/**
 * The console read API: route registration, request bounds, and the real
 * release-readiness probe.
 *
 * ## What this module is responsible for
 *
 * 1. **Route registration.** It pushes handlers onto the `API_ROUTES` array that
 *    `apps/web/server.mts` already owns, and installs the real readiness probe.
 *    `server.mts` is not restructured: it keeps its own method rejection, its
 *    error envelope, its controlled 404, its static handling and its SPA
 *    fallback. This module only adds what the console needs on top.
 *
 * 2. **Request bounds.** Every handler runs inside {@link withRequestBounds}:
 *    a per-request deadline, a process-wide concurrency cap, and a serialized
 *    response-size ceiling. The three defaults and the three environment names
 *    mirror `packages/mcp/src/hosted-runtime.ts:303-318` (`DEFAULT_HOSTED_*`),
 *    so the console and the hosted MCP share one convention rather than two.
 *
 * 3. **Error translation.** `catalog.ts`, `skills.ts` and `releases.ts` each
 *    export a typed error that already carries `code` and `status`, so there is
 *    no per-code mapping table anywhere: {@link toConsoleApiError} reads the two
 *    fields the errors already publish. Nothing else is inspected, and a
 *    `ServerConfigError` — which publishes no status, because it is a deployment
 *    fault rather than a request fault — is the single deliberate exception and
 *    becomes a 503.
 *
 * ## What a browser can influence, and what it cannot
 *
 * A request contributes: a path, a set of query strings, and a method. That is
 * all. Every one of those is bounded before it reaches a module
 * ({@link readQuery}, `SKILL_ID_MAX_LENGTH`, `RELEASE_DIGEST_MAX_LENGTH`).
 *
 * A request cannot supply an artifact identity, a filesystem path, or SQL. The
 * artifact directory comes from the server's own `ServerConfig`; skill file
 * paths are validated by `runGetContentTool` against exact manifest entries; and
 * this module contains no SQL at all — every read goes through the parameterized
 * helpers in `apps/web/server/registry.ts`.
 *
 * ## Response hygiene
 *
 * {@link sanitizeMessage} is applied to every message that reaches the wire,
 * whatever raised it. It collapses absolute POSIX and Windows paths to a
 * placeholder and caps the length, so an upstream failure message that embeds
 * `HostedReleaseSnapshot.artifactDir` cannot disclose the deployment's directory
 * layout even if a future loader stops redacting its own text. Responses are
 * frozen-shape DTOs assembled in the server modules; this module copies no
 * snapshot internals, and `release-identity` deliberately projects the binding
 * rather than serialising it.
 *
 * ## No stdout
 *
 * SPEC-006 §5.1.2 forbids the MCP from writing to stdout, and the same discipline
 * applies to the console's Node entrypoint: diagnostics go to `process.stderr`
 * only, and a stderr line carries a route id and a message, never a token.
 */

import { isAbsolute, resolve } from "node:path";

import {
  getCatalog,
  CATALOG_MAX_LIMIT,
  CATALOG_MAX_OFFSET,
  type CatalogOptions,
} from "./catalog.ts";
import {
  loadServerConfig,
  describeServerConfig,
  ServerConfigError,
} from "./env.ts";
import {
  getReleaseIdentityBinding,
} from "./release-identity.ts";
import {
  RegistryReadError,
} from "./registry.ts";
import {
  RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE,
  getReleaseComparison,
  getReleaseDetail,
  getReleases,
  RELEASE_DIGEST_MAX_LENGTH,
} from "./releases.ts";
import {
  SKILL_CONTENT_MAX_PATH_LENGTH,
  SKILL_ID_MAX_LENGTH,
  getSkillContent,
  getSkillDetail,
} from "./skills.ts";

import type { ReleaseIdentity } from "../src/api/contracts.ts";
import type {
  ApiRoute,
  ApiRouteContext,
  ReleaseReadiness,
  ReleaseReadinessProbe,
} from "../server.mts";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Largest serialized API response.
 *
 * Mirrors `DEFAULT_HOSTED_MAX_RESPONSE_BYTES`
 * (`packages/mcp/src/hosted-runtime.ts:40`). The largest real payload is the
 * catalog page at `CATALOG_MAX_LIMIT` rows; a release comparison with a full
 * `unchanged_skill_ids` list is the next largest. Both fit well inside 4 MiB, so
 * this is a ceiling on a future regression rather than a limit anyone hits.
 */
export const API_MAX_RESPONSE_BYTES_DEFAULT = 4 * 1_048_576;

/**
 * Per-request deadline. Mirrors `DEFAULT_HOSTED_REQUEST_TIMEOUT_MS`
 * (`hosted-runtime.ts:41`).
 *
 * A deadline is a correctness control, not just latency: the artifact loaders
 * touch the filesystem and SQLite, and a wedged read must not hold a route slot
 * forever.
 */
export const API_REQUEST_TIMEOUT_MS_DEFAULT = 30_000;

/**
 * Concurrent API requests. Mirrors `DEFAULT_HOSTED_MAX_CONCURRENT_REQUESTS`
 * (`hosted-runtime.ts:42`).
 *
 * Every route is CPU- and IO-bound against one immutable artifact, so
 * unbounded concurrency buys nothing and costs latency for every other reader.
 * Over the cap a request is refused immediately with 503 rather than queued.
 */
export const API_MAX_CONCURRENT_REQUESTS_DEFAULT = 32;

/**
 * Largest accepted number of query parameters.
 *
 * The widest real request uses nine (`/api/catalog`). Sixteen leaves room for a
 * UI that echoes state, and stops a URL carrying hundreds of junk parameters from
 * reaching a validator loop.
 */
export const API_MAX_QUERY_PARAMS = 16;

/** Largest accepted single query-parameter value. */
export const API_MAX_QUERY_PARAM_VALUE_LENGTH = 512;

/** Longest accepted decoded path segment, before any module-specific check. */
export const API_MAX_PATH_SEGMENT_LENGTH = SKILL_ID_MAX_LENGTH;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The error a console route raises, carrying the HTTP status and stable code the
 * router encodes into `{ error: { code, message } }`.
 *
 * Distinct from `server.mts`'s own `ApiError` on purpose: `api.ts` must not
 * import a *value* from `server.mts`, because `server.mts` imports `api.ts` to
 * register the routes, and a runtime cycle between the entrypoint and its route
 * table is a latent ordering bug. The two are structurally identical, and
 * `server.mts` recognises both.
 */
export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Collapse absolute filesystem paths in a wire message, then cap its length.
 *
 * Two rules, applied in this order.
 *
 * 1. **Exact configured paths.** The artifact directory and retained-manifest
 *    path this process resolved are the only absolute paths that can appear in an
 *    upstream failure at all: `HostedReleaseSnapshot.artifactDir` and
 *    `.sqlitePath` derive from the first, the cache-blob messages in
 *    `packages/registry/src/cache.ts` embed `<artifactDir>/cache/sha256/..`, and
 *    the retained manifest path is the second. Replacing those literal strings
 *    closes the real leak precisely, including when the operator configured a
 *    *relative* directory and `parseServerConfig` resolved it somewhere else.
 * 2. **A token that begins with `/`.** A path recognised structurally — one that
 *    starts a token, as in "… is missing at /srv/app/…" — is rewritten even if it
 *    is not a configured path, so a future loader cannot introduce a new one.
 *
 * The boundary in rule 2 is load-bearing and is the reason this is not simply
 * "collapse every slash": a canonical skill id is `namespace/name`, and upstream
 * messages legitimately name the skill that was refused. `/claude-api` inside
 * `anthropic/claude-api` is preceded by a word character, so it is not a token
 * boundary and is left intact. Rewriting it would corrupt an identifier to
 * protect against a leak that rules 1 and the throw-site redaction already cover.
 *
 * A path embedded mid-token with no configured-path match is therefore *not*
 * rewritten. That is a deliberate trade and it is stated rather than hidden: the
 * modules that can embed one (`release-identity.ts`, `releases.ts`,
 * `skills.ts`) redact at the throw site, where the path is known exactly.
 */
export function sanitizeMessage(message: string): string {
  let redacted = message;
  for (const path of configuredPathLiterals()) {
    if (path.length > 1 && redacted.includes(path)) {
      redacted = redacted.split(path).join("<redacted-path>");
    }
  }
  redacted = redacted
    // A token that starts with an absolute POSIX path.
    .replace(/(^|[\s"'(=:[])(\/[A-Za-z0-9._@+-]+)+/g, "$1<redacted-path>")
    // A token that starts with an absolute Windows path.
    .replace(/(^|[\s"'(=:])([A-Za-z]:\\(?:[^\\\s"'`,;)]+\\)*[^\\\s"'`,;)]*)/g, "$1<redacted-path>");
  return redacted.length > 512 ? `${redacted.slice(0, 509)}...` : redacted;
}

/**
 * The absolute paths this deployment configured, resolved once.
 *
 * Read defensively: {@link sanitizeMessage} runs on the error path, including
 * when the configuration itself is what failed, so it must never throw. A blank
 * or relative value is skipped — `parseServerConfig` owns resolution, and rule 2
 * of {@link sanitizeMessage} still catches a structural path.
 */
function configuredPathLiterals(): readonly string[] {
  if (pathLiterals === null) {
    const literals: string[] = [];
    for (const name of ["EGA_WEB_ARTIFACT_DIR", "EGA_WEB_RETAINED_MANIFEST"] as const) {
      const raw = process.env[name];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed === "" || !isAbsolute(trimmed)) continue;
      literals.push(resolve(trimmed));
    }
    pathLiterals = Object.freeze(literals);
  }
  return pathLiterals;
}

/** Process-lifetime cache: the environment does not change under a server. */
let pathLiterals: readonly string[] | null = null;

/** Shape every server module's typed error already publishes. */
interface CodedStatusError {
  readonly code: string;
  readonly status: number;
  readonly message: string;
}

function isCodedStatusError(value: unknown): value is CodedStatusError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

/**
 * Translate a server module's typed error into a {@link ConsoleApiError}.
 *
 * `CatalogError`, `SkillReadError`, `ReleaseReadError` and
 * `ReleaseIdentityError` all publish `code` and `status` on the error itself, so
 * the first branch covers every one of them without a per-code table. Two classes
 * publish no status and are handled explicitly below.
 *
 * Never returns `null`: an unrecognised failure becomes a sanitized 503 rather
 * than being allowed to reach the router as a bare 500 with a message this module
 * had a chance to redact.
 */
export function toConsoleApiError(error: unknown): ConsoleApiError {
  if (error instanceof ConsoleApiError) return error;
  if (isCodedStatusError(error)) {
    return new ConsoleApiError(error.status, error.code, sanitizeMessage(error.message));
  }
  // A deployment fault: a malformed expected digest, a path that no longer
  // resolves, or a read the verified handle refused. It is never a client error,
  // so it never becomes a 4xx, and it never degrades into "no data" — 503 is the
  // fail-closed answer.
  if (error instanceof ServerConfigError || error instanceof RegistryReadError) {
    return new ConsoleApiError(503, error.code, sanitizeMessage(error.message));
  }
  return new ConsoleApiError(
    503,
    "E_WEB_READ_FAILED",
    sanitizeMessage(
      error instanceof Error ? error.message : "The console could not complete this read.",
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Request bounds                                                              */
/* -------------------------------------------------------------------------- */

function positiveIntEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    // A bad bound is a startup warning, not a silent default: an operator who set
    // `EGA_WEB_MAX_RESPONSE_BYTES=0` and got the default would not know.
    process.stderr.write(
      `ega-web startup warning: ${name} is not a positive safe integer; using ${fallback}\n`,
    );
    return fallback;
  }
  return value;
}

/** The three bounds, read from the environment with the documented defaults. */
export interface RequestBounds {
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxConcurrentRequests: number;
}

/**
 * Read the bounds for this process.
 *
 * Blank counts as unset (the same rule `apps/web/server/env.ts` applies, so a
 * Vercel variable declared but left empty does not read as a configured `0`).
 */
export function loadRequestBounds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RequestBounds {
  return Object.freeze({
    maxResponseBytes: positiveIntEnv(
      env["EGA_WEB_MAX_RESPONSE_BYTES"],
      API_MAX_RESPONSE_BYTES_DEFAULT,
      "EGA_WEB_MAX_RESPONSE_BYTES",
    ),
    requestTimeoutMs: positiveIntEnv(
      env["EGA_WEB_REQUEST_TIMEOUT_MS"],
      API_REQUEST_TIMEOUT_MS_DEFAULT,
      "EGA_WEB_REQUEST_TIMEOUT_MS",
    ),
    maxConcurrentRequests: positiveIntEnv(
      env["EGA_WEB_MAX_CONCURRENT_REQUESTS"],
      API_MAX_CONCURRENT_REQUESTS_DEFAULT,
      "EGA_WEB_MAX_CONCURRENT_REQUESTS",
    ),
  });
}

/** A timer that cannot keep the process alive past the request. */
function deadlineSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Wrap one handler in the response-size, deadline and concurrency bounds.
 *
 * Each bound is enforced by *refusing*, never by truncating:
 *
 * - Over the concurrency cap: refused immediately with 503, because queueing
 *   would move the latency problem rather than bound it. Note what the cap does
 *   and does not cover in this deployment: every console route reads
 *   already-verified in-memory data through `better-sqlite3` and the sync `fs`
 *   API, so a handler settles inside a single tick and releases its slot before
 *   the next request is even read. The cap is therefore a real bound on
 *   *overlapping* requests — which is what it becomes the moment any handler
 *   awaits — and it is exercised directly against a slow handler rather than
 *   against a synchronous route, where a pass would prove nothing.
 * - Past the deadline: refused with 504. The deadline is enforced twice, and both
 *   halves are needed. The race catches a genuinely *hanging* read — one waiting
 *   on a filesystem or socket that never answers. The elapsed check afterwards
 *   catches a read that *did* finish but took too long, which a race alone would
 *   miss for exactly the same reason the cap cannot trip on a synchronous route:
 *   no timer callback can run before a settled promise resolves. Refusing to
 *   deliver a response that already missed its deadline bounds the latency a
 *   client actually observes. The losing promise's rejection is consumed, so a
 *   late failure cannot surface as an unhandled rejection.
 * - Over `maxResponseBytes`: refused with 503. The size is measured on the exact
 *   bytes `JSON.stringify` would write, so the check cannot disagree with what
 *   the socket receives. A partial body is never written, so the console cannot
 *   render a truncated page as complete.
 *
 * Exported so a test can drive the real bound with a deliberately slow handler.
 * `apps/web/server/registry.ts` sets the same precedent — it exports
 * `createRegistryReader` for exactly this reason.
 */
export function createBoundedHandler(
  bounds: RequestBounds,
  handle: (context: ApiRouteContext) => Promise<unknown> | unknown,
): (context: ApiRouteContext) => Promise<unknown> {
  let inFlight = 0;
  return async (context: ApiRouteContext): Promise<unknown> => {
    if (inFlight >= bounds.maxConcurrentRequests) {
      throw new ConsoleApiError(
        503,
        "E_WEB_TOO_MANY_REQUESTS",
        "The console API is at its concurrency limit. Try again once an in-flight read completes.",
      );
    }
    inFlight += 1;
    const startedAt = Date.now();
    try {
      const pending = (async () => handle(context))();
      // Consume the loser's rejection so a late failure is neither unhandled
      // nor reported to the client as a success.
      const timer = deadlineSignal(bounds.requestTimeoutMs);
      const timed = pending.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const winner = await Promise.race([
        timed,
        timerAbort(timer).then(() => ({ kind: "timeout" as const }) as const),
      ]);
      if (winner.kind === "timeout") {
        void pending.catch(() => undefined);
        throw deadlineExceeded(bounds.requestTimeoutMs);
      }
      if (winner.kind === "error") throw winner.error;
      if (Date.now() - startedAt > bounds.requestTimeoutMs) {
        throw deadlineExceeded(bounds.requestTimeoutMs);
      }
      const serialized = JSON.stringify(winner.value ?? {});
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > bounds.maxResponseBytes) {
        throw new ConsoleApiError(
          503,
          "E_WEB_RESPONSE_TOO_LARGE",
          `The console API response would be ${bytes} bytes, above the ${bounds.maxResponseBytes} byte ceiling for this deployment. Narrow the request instead.`,
        );
      }
      return winner.value ?? {};
    } catch (error) {
      throw toConsoleApiError(error);
    } finally {
      inFlight -= 1;
    }
  };
}

/** The one refusal both halves of the deadline produce. */
function deadlineExceeded(requestTimeoutMs: number): ConsoleApiError {
  return new ConsoleApiError(
    504,
    "E_WEB_REQUEST_TIMEOUT",
    `The console API did not complete this read within ${requestTimeoutMs} ms.`,
  );
}

/** Resolve when `signal` aborts. Used as the deadline arm of the race above. */
function timerAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* Query parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read one query parameter as a trimmed string, or `null` when absent.
 *
 * `""` and whitespace-only are treated as *absent* rather than as a value, which
 * matches `apps/web/server/env.ts`'s blank rule and the client's
 * `buildQueryString`, which drops empty values. A value that is present but
 * blank cannot be a filter the caller meant.
 */
function readParam(query: URLSearchParams, name: string): string | null {
  if (!query.has(name)) return null;
  const raw = query.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parse an integer query parameter.
 *
 * A malformed value is a 400 rather than a silent default: `limit=abc` and
 * `limit=` are different requests, and quietly serving the default page for
 * either hides the caller's bug.
 */
function readIntParam(query: URLSearchParams, name: string): number | undefined {
  const raw = readParam(query, name);
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConsoleApiError(
      400,
      "E_WEB_QUERY_INVALID",
      `${name} must be a base-ten integer; it is not coerced to a default`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ConsoleApiError(400, "E_WEB_QUERY_INVALID", `${name} must be a safe integer`);
  }
  return value;
}

/**
 * Bound the request's query string before any module sees it.
 *
 * Both bounds exist so a URL cannot smuggle an unbounded amount of work into the
 * validators. `API_MAX_QUERY_PARAMS` stops a many-parameter request; the value
 * cap stops a single enormous one, and is set above the longest parameter any
 * route accepts (`SKILL_CONTENT_MAX_PATH_LENGTH`, 512).
 */
function assertBoundedQuery(query: URLSearchParams): void {
  let count = 0;
  for (const [name, value] of query) {
    count += 1;
    if (count > API_MAX_QUERY_PARAMS) {
      throw new ConsoleApiError(
        400,
        "E_WEB_QUERY_INVALID",
        `A console API request may carry at most ${API_MAX_QUERY_PARAMS} query parameters`,
      );
    }
    if (name.length > 64) {
      throw new ConsoleApiError(400, "E_WEB_QUERY_INVALID", "query parameter names are bounded");
    }
    if (value.length > API_MAX_QUERY_PARAM_VALUE_LENGTH) {
      throw new ConsoleApiError(
        400,
        "E_WEB_QUERY_INVALID",
        `query parameter ${name} must be at most ${API_MAX_QUERY_PARAM_VALUE_LENGTH} characters`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the real release-readiness probe.
 *
 * Replaces Builder 1's conservative default, which answered "is a directory
 * configured and present?" — a question that a directory of unrelated files
 * passes. This one answers the question the architecture poses: **may this
 * deployment serve release contents right now?**
 *
 * Two layers, in order:
 *
 * 1. `precondition` — Builder 1's configuration rules, unchanged. Keeping them
 *    as the first layer means a deployment with no artifact configured still gets
 *    the operator message naming the missing variable, which is more useful than
 *    a generic verification failure.
 * 2. Real verification, via `getReleaseIdentityBinding`. 200 requires an artifact
 *    that `loadHostedReleaseSnapshot` verified **and** a `ReleaseIdentity.status`
 *    that is not `mismatch`.
 *
 * `unpinned` is deliberately **ready**. The bytes are fully verified; nobody has
 * claimed which release they should be. `assertCatalogServable` serves that state
 * and the reconciled architecture requires the console to render it rather than
 * call itself stable — refusing it would make an honest deployment permanently
 * unavailable. Only `mismatch` fails closed, and so does a verification failure.
 *
 * The probe returns a verdict rather than throwing, so `/readyz` always answers
 * with a reason. Every message is passed through {@link sanitizeMessage}.
 */
export function createReleaseReadinessProbe(
  precondition: ReleaseReadinessProbe,
  bounds: RequestBounds,
): ReleaseReadinessProbe {
  return async (): Promise<ReleaseReadiness> => {
    const configured = await precondition();
    if (!configured.ready) {
      return Object.freeze({ ready: false, detail: sanitizeMessage(configured.detail) });
    }
    try {
      // The bound applies to the probe too, but the concurrency cap does not: a
      // readiness endpoint that is refused because the API is busy is exactly
      // the endpoint an operator needs during an incident. Both halves of the
      // deadline are enforced, for the reason given on `withRequestBounds`: the
      // verification path is synchronous over cached bytes, so a race alone would
      // never trip.
      const startedAt = Date.now();
      const verdict = await Promise.race([
        verifyReadiness(),
        timerAbort(deadlineSignal(bounds.requestTimeoutMs)).then(() => "timeout" as const),
      ]);
      if (verdict === "timeout" || Date.now() - startedAt > bounds.requestTimeoutMs) {
        return Object.freeze({
          ready: false,
          detail: `The release artifact did not verify within ${bounds.requestTimeoutMs} ms.`,
        });
      }
      return verdict;
    } catch (error) {
      const translated = toConsoleApiError(error);
      return Object.freeze({
        ready: false,
        detail: sanitizeMessage(`${translated.code}: ${translated.message}`),
      });
    }
  };
}

/** The verification half of the readiness probe. */
async function verifyReadiness(): Promise<ReleaseReadiness> {
  const config = loadServerConfig();
  const binding = getReleaseIdentityBinding(config);
  if (binding.identity === null) {
    return Object.freeze({
      ready: false,
      detail: sanitizeMessage(
        `The release artifact is not verified, so no release can be served. ${binding.unavailable_reason ?? "No verified release identity."}`,
      ),
    });
  }
  if (binding.identity.status === "mismatch") {
    return Object.freeze({
      ready: false,
      detail: sanitizeMessage(
        `The verified web artifact does not match the release this deployment expects, so the console serves no release contents. ${binding.identity.mismatch_reason ?? ""}`.trim(),
      ),
    });
  }
  return Object.freeze({
    ready: true,
    detail: sanitizeMessage(
      `Release ${binding.identity.release_digest} is verified and carries ${binding.identity.skill_count} skills (${binding.identity.status}).`,
    ),
  });
}

/* -------------------------------------------------------------------------- */
/* Release identity projection                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The operator-facing projection of the release-identity binding.
 *
 * The binding itself holds a `HostedReleaseSnapshot` (with absolute paths), a
 * `RetainedReleaseSet` (with an absolute manifest path) and a memo. None of that
 * may be serialised, so this projects the binding down to facts: the identity,
 * both digests with their provenance, whether a retained manifest was configured,
 * how many releases it retains, and an environment description that
 * `describeServerConfig` builds from **presence only** — no path, no digest, no
 * secret.
 */
export interface ReleaseIdentityView {
  /** `null` only when verification produced no identity at all. */
  readonly release: ReleaseIdentity | null;
  /** Non-null exactly when `release === null`. */
  readonly release_unavailable_reason: string | null;
  readonly actual_release_digest: string | null;
  readonly expected_release_digest: string | null;
  readonly expected_digest_source: "env" | "retained-manifest" | null;
  readonly is_stable: boolean;
  readonly has_retained_manifest: boolean;
  /** `null` when no manifest is configured. Never 0 for "none configured". */
  readonly retained_release_count: number | null;
  /** Non-null when a manifest is configured but records nothing readable. */
  readonly retained_release_unavailable_reason: string | null;
  /** Presence-only description of the server configuration. */
  readonly environment: string;
  readonly generated_at: string;
}

function releaseIdentityView(): ReleaseIdentityView {
  const config = loadServerConfig();
  const binding = getReleaseIdentityBinding(config);
  const retained = binding.retained;
  return Object.freeze({
    release: binding.identity,
    release_unavailable_reason: binding.identity === null ? binding.unavailable_reason : null,
    actual_release_digest: binding.actual_release_digest,
    expected_release_digest: binding.expected_release_digest,
    expected_digest_source: binding.expected_digest_source,
    is_stable: binding.is_stable,
    has_retained_manifest: retained !== null,
    retained_release_count: retained === null ? null : retained.manifest.payload.releases.length,
    retained_release_unavailable_reason:
      retained === null
        ? "No retained release manifest is configured, so this deployment retains no release history of its own."
        : null,
    environment: describeServerConfig(config),
    generated_at: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Route handlers                                                              */
/* -------------------------------------------------------------------------- */

/** A decoded `:name` path segment, refused when it is implausibly long. */
function segment(context: ApiRouteContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) {
    throw new ConsoleApiError(404, "E_NOT_FOUND", "No such route.");
  }
  if (value.length > API_MAX_PATH_SEGMENT_LENGTH) {
    throw new ConsoleApiError(
      400,
      "E_WEB_PATH_INVALID",
      `the ${name} path segment is too long to be a release identifier`,
    );
  }
  return value;
}

function catalogOptions(query: URLSearchParams): CatalogOptions {
  const options: Record<string, string | number> = {};
  const text: ReadonlyArray<readonly [string, string]> = [
    ["q", "q"],
    ["namespace", "namespace"],
    ["domain", "domain"],
    ["framework", "framework"],
    ["source", "source"],
    ["l1", "l1"],
    ["sort", "sort"],
    ["workspace_id", "workspace_id"],
  ];
  for (const [param, field] of text) {
    const value = readParam(query, param);
    if (value !== null) options[field] = value;
  }
  const limit = readIntParam(query, "limit");
  if (limit !== undefined) options["limit"] = limit;
  const offset = readIntParam(query, "offset");
  if (offset !== undefined) options["offset"] = offset;
  return options as CatalogOptions;
}

function handleReleaseIdentity(): unknown {
  return releaseIdentityView();
}

function handleCatalog(query: URLSearchParams): unknown {
  assertBoundedQuery(query);
  const config = loadServerConfig();
  return getCatalog(config, catalogOptions(query));
}

function handleSkillDetail(context: ApiRouteContext): unknown {
  assertBoundedQuery(context.query);
  const config = loadServerConfig();
  return getSkillDetail(config, segment(context, "skillId"));
}

function handleSkillContent(context: ApiRouteContext): unknown {
  assertBoundedQuery(context.query);
  const config = loadServerConfig();
  const skillId = segment(context, "skillId");
  // `level` is required, not defaulted. `SkillContentOptions.level` is a required
  // field and `skills.ts` refuses an absent one, so defaulting here would either
  // duplicate that rule or silently pick a level the caller did not ask for. L1
  // genuinely does not exist for any skill in the shipped release, so guessing
  // "L1" would be worse than refusing.
  const level = readParam(context.query, "level");
  if (level !== "L1" && level !== "L2") {
    throw new ConsoleApiError(
      400,
      "E_WEB_CONTENT_LEVEL_INVALID",
      "level is required and must be one of L1, L2",
    );
  }
  const filePath = readParam(context.query, "file_path");
  if (filePath !== null && filePath.length > SKILL_CONTENT_MAX_PATH_LENGTH) {
    throw new ConsoleApiError(
      400,
      "E_WEB_CONTENT_FILE_PATH_INVALID",
      `file_path must be at most ${SKILL_CONTENT_MAX_PATH_LENGTH} characters`,
    );
  }
  const maxTokens = readIntParam(context.query, "max_tokens");
  const versionHash = readParam(context.query, "version_hash");
  return getSkillContent(config, {
    skillId,
    level,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(filePath === null ? {} : { filePath }),
    ...(versionHash === null ? {} : { versionHash }),
  });
}

function handleReleases(context: ApiRouteContext): unknown {
  assertBoundedQuery(context.query);
  return getReleases(loadServerConfig());
}

function handleReleaseCompare(context: ApiRouteContext): unknown {
  assertBoundedQuery(context.query);
  const base = readParam(context.query, "base");
  const candidate = readParam(context.query, "candidate");
  if (base === null || candidate === null) {
    throw new ConsoleApiError(
      400,
      "E_WEB_RELEASE_DIGEST_INVALID",
      "compare requires both a base and a candidate release digest",
    );
  }
  return getReleaseComparison(loadServerConfig(), { base, candidate });
}

function handleReleaseDetail(context: ApiRouteContext): unknown {
  assertBoundedQuery(context.query);
  const digest = segment(context, "releaseDigest");
  if (digest.length > RELEASE_DIGEST_MAX_LENGTH) {
    throw new ConsoleApiError(
      400,
      "E_WEB_RELEASE_DIGEST_INVALID",
      `releaseDigest must be at most ${RELEASE_DIGEST_MAX_LENGTH} characters`,
    );
  }
  return getReleaseDetail(loadServerConfig(), digest);
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

let installed = false;

/**
 * Push the console read routes and build the real readiness probe.
 *
 * Idempotent, because `server.mts` calls it once at module scope and a test may
 * call it again; registering the same handler twice would make the router's
 * `find` ambiguous for no benefit.
 *
 * **Registration order is load-bearing.** `/releases/compare` is registered
 * *before* `/releases/:releaseDigest`. The router also prefers an exact literal
 * match over a pattern match, so the compare route wins twice over — but relying
 * on one mechanism would make the ordering silently significant, and ordering is
 * exactly the kind of thing a later edit reorders without noticing. Belt and
 * braces, deliberately.
 *
 * Every route is read-only (`GET` alone), so the router's 405 branch answers a
 * write verb with `Allow: GET` and never reaches a handler.
 *
 * The readiness probe is **returned**, not installed, because this module must
 * not import a value from `server.mts` (see {@link ConsoleApiError}). `server.mts`
 * owns `setReleaseReadinessProbe` and passes the returned probe straight into it.
 */
export function installConsoleApi(
  routes: ApiRoute[],
  precondition: ReleaseReadinessProbe,
  bounds: RequestBounds = loadRequestBounds(),
): ReleaseReadinessProbe {
  const probe = createReleaseReadinessProbe(precondition, bounds);
  if (installed) return probe;
  installed = true;

  const bound = (handle: (context: ApiRouteContext) => Promise<unknown> | unknown) =>
    createBoundedHandler(bounds, handle);

  routes.push(
    {
      id: "release-identity",
      path: "/release-identity",
      methods: ["GET"],
      handle: bound(() => handleReleaseIdentity()),
    },
    {
      id: "catalog",
      path: "/catalog",
      methods: ["GET"],
      handle: bound((context) => handleCatalog(context.query)),
    },
    {
      id: "skills",
      path: "/skills",
      methods: ["GET"],
      // The list surface is the catalog with no filters: one bounded
      // enumeration, not a second read path that could disagree with `/catalog`
      // about what the release contains.
      handle: bound((context) => handleCatalog(context.query)),
    },
    {
      id: "skill-detail",
      path: "/skills/:skillId",
      methods: ["GET"],
      handle: bound(handleSkillDetail),
    },
    {
      id: "skill-content",
      path: "/skills/:skillId/content",
      methods: ["GET"],
      handle: bound(handleSkillContent),
    },
    {
      id: "releases",
      path: "/releases",
      methods: ["GET"],
      handle: bound(handleReleases),
    },
    {
      id: "releases-compare",
      path: "/releases/compare",
      methods: ["GET"],
      handle: bound(handleReleaseCompare),
    },
    {
      id: "release-detail",
      path: "/releases/:releaseDigest",
      methods: ["GET"],
      handle: bound(handleReleaseDetail),
    },
  );

  return probe;
}

/** Exported bounds, for a deployment that wants to advertise them. */
export function describeRequestBounds(bounds: RequestBounds): string {
  return [
    `max response ${bounds.maxResponseBytes} bytes`,
    `request timeout ${bounds.requestTimeoutMs} ms`,
    `max concurrent ${bounds.maxConcurrentRequests}`,
    `catalog page ceiling ${CATALOG_MAX_LIMIT} rows`,
    `catalog offset ceiling ${CATALOG_MAX_OFFSET}`,
  ].join("; ");
}

/** Re-exported so a test or an operator page can name the comparison state. */
export { RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE };
