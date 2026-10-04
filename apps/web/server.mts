// Vercel Node server entrypoint for the EGA Skills web console.
//
// This app is NOT a pure SPA. Every `@ega-skills/*` domain package is Node-only
// (`packages/hashing/src/identities.ts` imports `node:crypto`; the registry and
// project packages open the native `better-sqlite3` binding), so a browser
// bundle cannot call `loadHostedReleaseSnapshot`, `runInspectTool`, or
// `getCacheBlob`. The BFF therefore runs here, in Node, exactly as
// `packages/mcp/server.mts` does, and serves the built SPA alongside it.
//
// Routes:
//   GET  /healthz                     200 {"status":"ok"} while the process lives
//   GET  /readyz                      200 / 503 from the release-readiness probe
//   GET  /api/*                       handled by the registered API routes below
//   GET  <static asset under dist/>   served from disk with correct content type
//   GET  <anything else>              SPA fallback to dist/index.html
//   *    /api/*                       controlled 404, never a stack trace
//
// Two extension points for Builder 2, both additive — neither requires rewriting
// this file. Both are now wired at the bottom of this file:
//   1. `API_ROUTES`: push a matcher plus handler for each real endpoint. The
//      router here already handles method rejection, envelope encoding, and the
//      controlled 404, so a handler only returns a body or throws `ApiError` (or
//      `ConsoleApiError`, which `apps/web/server/api.ts` throws and which this
//      file recognises identically).
//   2. `setReleaseReadinessProbe`: replace the default probe with one that
//      actually verifies a release artifact. The default probe below is kept as
//      the *configuration precondition* of the real probe, so an unconfigured or
//      mistyped deployment still gets the operator message naming the variable.
//
// Path patterns: a route path segment beginning with `:` captures a parameter,
// and exact literal paths are matched before patterns. Percent-encoded segments
// are decoded after the split, so `%2F` inside a segment cannot introduce a new
// one and `anthropic%2Fclaude-api` arrives as the canonical skill id.
//
// Security posture mirrors `packages/mcp`: env validation at startup, no
// secrets logged, no stack traces returned, fail-closed JSON instead of crashes.
// Build: Vercel runs `pnpm --filter @ega-skills/web build` (see vercel.json) so
// `dist/` exists before this file is bundled. `config.includeFiles` ships both
// `dist/**` and `artifact/**` so the SPA and the release artifacts are present
// at runtime.

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import { ConsoleApiError, installConsoleApi } from "./server/api.ts";

/* -------------------------------------------------------------------------- */
/* Response helpers                                                            */
/* -------------------------------------------------------------------------- */

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "no-referrer"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  [
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.supabase.co; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ],
];

function writeHead(outgoing: ServerResponse, status: number, headers: Record<string, string>): void {
  outgoing.writeHead(status, { ...Object.fromEntries(SECURITY_HEADERS), ...headers });
}

/** JSON body with the standard error envelope. Never leaks internals. */
function json(outgoing: ServerResponse, status: number, body: unknown): void {
  if (outgoing.writableEnded) return;
  writeHead(outgoing, status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  outgoing.end(JSON.stringify(body));
}

function errorBody(code: string, message: string): { readonly error: { readonly code: string; readonly message: string } } {
  return { error: { code, message } };
}

function notFound(outgoing: ServerResponse): void {
  json(outgoing, 404, errorBody("E_NOT_FOUND", "No such route."));
}

/**
 * Error type a Builder 2 handler may throw (or return) to control the response.
 * Anything else becomes a generic 500 with no detail, mirroring the MCP adapter.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Release readiness                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Readiness verdict. `ready` is only ever true when the deployment can serve
 * release contents; `detail` is an operator-safe explanation shown in the body.
 */
export interface ReleaseReadiness {
  readonly ready: boolean;
  readonly detail: string;
}

export type ReleaseReadinessProbe = () => ReleaseReadiness | Promise<ReleaseReadiness>;

/**
 * Default probe: checks that release artifacts are configured and present on
 * disk. It never returns `ready: true` on configuration alone — the artifact
 * directory (or retained manifest) has to actually resolve.
 *
 * Builder 2 replaces this with a real probe via `setReleaseReadinessProbe`,
 * ideally one that also verifies the digests in the retained manifest. That is
 * what now happens: `createReleaseReadinessProbe` (in `apps/web/server/api.ts`)
 * runs this function first and then requires a verified artifact whose identity
 * is not `mismatch`. Keeping this function as the first layer is deliberate — its
 * messages name the offending variable, which is more useful to an operator than
 * a generic verification failure.
 */
const defaultReadinessProbe: ReleaseReadinessProbe = () => {
  // An empty value counts as unset: a Vercel env var declared but left blank
  // must not read as a configured path. This matches the `requiredEnv` rule in
  // `packages/mcp/src/hosted-runtime.ts`, which rejects empty rather than
  // falling through to a default.
  const configured = (raw: string | undefined): string | undefined =>
    raw === undefined || raw.trim() === "" ? undefined : raw;

  const artifactDir = configured(process.env["EGA_WEB_ARTIFACT_DIR"]);
  const retainedManifest = configured(process.env["EGA_WEB_RETAINED_MANIFEST"]);

  if (artifactDir === undefined && retainedManifest === undefined) {
    return {
      ready: false,
      detail: "Neither EGA_WEB_ARTIFACT_DIR nor EGA_WEB_RETAINED_MANIFEST is configured, so no release can be served.",
    };
  }
  if (artifactDir !== undefined && !existsSync(artifactDir)) {
    return {
      ready: false,
      detail: "EGA_WEB_ARTIFACT_DIR does not resolve to an existing directory.",
    };
  }
  if (retainedManifest !== undefined && !existsSync(retainedManifest)) {
    return {
      ready: false,
      detail: "EGA_WEB_RETAINED_MANIFEST does not resolve to an existing file.",
    };
  }
  if (artifactDir === undefined) {
    return {
      ready: false,
      detail: "EGA_WEB_ARTIFACT_DIR is not configured; a retained manifest alone does not provide release artifacts to read.",
    };
  }
  if (!statSync(artifactDir).isDirectory()) {
    return {
      ready: false,
      detail: "EGA_WEB_ARTIFACT_DIR exists but is not a directory.",
    };
  }
  return { ready: true, detail: "Release artifacts are configured and present on disk." };
};

let readinessProbe: ReleaseReadinessProbe = defaultReadinessProbe;

/** Builder 2 seam: install the real release-readiness probe. */
export function setReleaseReadinessProbe(probe: ReleaseReadinessProbe): void {
  readinessProbe = probe;
}

/* -------------------------------------------------------------------------- */
/* API routes                                                                  */
/* -------------------------------------------------------------------------- */

export interface ApiRouteContext {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly request: IncomingMessage;
  /**
   * Decoded `:name` path segments, keyed by the name in the matched route's
   * `path`. Empty for a literal route.
   *
   * Segments are percent-decoded by the matcher, so a skill id arrives as the
   * canonical `namespace/name` string even though the URL carried `%2F`. The
   * WHATWG URL parser leaves `%2F` encoded in `pathname`, so the split happens
   * before the decode and a decoded `/` can never introduce a new segment.
   */
  readonly params: Readonly<Record<string, string>>;
}

export interface ApiRoute {
  /** Stable route id, useful in logs and tests. */
  readonly id: string;
  /**
   * Path under `/api`, e.g. `/releases`. A segment beginning with `:` names a
   * captured parameter: `/skills/:skillId` matches `/skills/anthropic%2Ffoo`.
   */
  readonly path: string;
  readonly methods: readonly string[];
  readonly handle: (context: ApiRouteContext) => Promise<unknown> | unknown;
}

/** A matched route and the parameters captured from its path. */
export interface ApiRouteMatch {
  readonly route: ApiRoute;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Registry of BFF endpoints.
 *
 * Populated at bootstrap by `installConsoleApi` (see `apps/web/server/api.ts`),
 * which pushes the console's read routes and builds the real release-readiness
 * probe. The array stays exported and mutable so a later builder can add a route
 * without editing this file.
 */
export const API_ROUTES: ApiRoute[] = [];

/**
 * Match one `:name` pattern against one concrete path.
 *
 * Returns the captured parameters, or `undefined` when the shapes differ. A
 * segment count mismatch never matches: `/skills/:skillId` must not swallow
 * `/skills/a/b`, because the whole point of validating a skill id with the
 * frozen schema parser is that the value it receives is the one the URL named.
 *
 * A percent-decoding failure is a non-match rather than a thrown error, so a
 * malformed escape answers the controlled 404 instead of a stack trace.
 */
function matchRoutePattern(pattern: string, pathname: string): Readonly<Record<string, string>> | undefined {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, patternSegment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return undefined;
    if (!patternSegment.startsWith(":")) {
      if (patternSegment !== pathSegment) return undefined;
      continue;
    }
    try {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
    } catch {
      return undefined;
    }
  }
  return Object.freeze(params);
}

/**
 * Find the route for a path.
 *
 * Exact literal matches are tried first, so a concrete path always beats a
 * pattern of the same shape. That is what keeps `/releases/compare` from being
 * captured by `/releases/:releaseDigest` independently of registration order —
 * and `api.ts` additionally registers `compare` first, so neither mechanism is
 * load-bearing on its own.
 */
function matchApiRoute(method: string, pathname: string): ApiRouteMatch | undefined {
  void method;
  for (const route of API_ROUTES) {
    if (!route.path.includes(":")) {
      if (route.path === pathname) return { route, params: Object.freeze({}) };
    }
  }
  for (const route of API_ROUTES) {
    if (!route.path.includes(":")) continue;
    const params = matchRoutePattern(route.path, pathname);
    if (params !== undefined) return { route, params };
  }
  return undefined;
}

async function handleApi(
  match: ApiRouteMatch | undefined,
  context: ApiRouteContext,
  outgoing: ServerResponse,
): Promise<void> {
  if (match === undefined) {
    notFound(outgoing);
    return;
  }
  const route = match.route;
  if (!route.methods.includes(context.method)) {
    if (outgoing.writableEnded) return;
    writeHead(outgoing, 405, {
      "content-type": "application/json; charset=utf-8",
      allow: route.methods.join(", "),
      "cache-control": "no-store",
    });
    outgoing.end(JSON.stringify(errorBody("E_METHOD_NOT_ALLOWED", "Method not allowed for this route.")));
    return;
  }
  try {
    const body = await route.handle(context);
    json(outgoing, 200, body ?? {});
  } catch (cause) {
    // Both error types publish `status` and `code`, so the envelope is identical
    // whichever route raised it: `ApiError` for a handler that speaks this file's
    // dialect, `ConsoleApiError` for the modules registered by `server/api.ts`.
    // Their messages were redacted at the throw site.
    if (cause instanceof ApiError || cause instanceof ConsoleApiError) {
      json(outgoing, cause.status, errorBody(cause.code, cause.message));
      return;
    }
    // Unexpected failure: log a sanitized line server-side, return nothing
    // specific to the client.
    process.stderr.write(
      `ega-web route ${route.id} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    json(outgoing, 500, errorBody("E_INTERNAL", "The console API failed to handle this request."));
  }
}

/* -------------------------------------------------------------------------- */
/* Static SPA                                                                  */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const DIST_DIR = resolve(process.cwd(), "dist");

/**
 * Resolve a URL path inside `dist/`, refusing anything that escapes the
 * directory. Returns `undefined` for traversal attempts so the caller falls
 * through to the SPA fallback rather than serving an arbitrary file.
 */
export function resolveStaticPath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const candidate = resolve(DIST_DIR, `.${normalize(decoded)}`);
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + sep)) return undefined;
  if (!existsSync(candidate)) return undefined;
  const stats = statSync(candidate);
  if (!stats.isFile()) return undefined;
  return candidate;
}

function serveFile(path: string, outgoing: ServerResponse, immutable: boolean): void {
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  writeHead(outgoing, 200, {
    "content-type": type,
    // Vite fingerprints asset filenames, so only those may be cached hard.
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(path)
    .on("error", () => {
      if (!outgoing.writableEnded) outgoing.end();
    })
    .pipe(outgoing);
}

function serveSpa(outgoing: ServerResponse): void {
  const indexPath = join(DIST_DIR, "index.html");
  if (!existsSync(indexPath)) {
    // The build did not run. Say so plainly instead of returning an empty body.
    json(
      outgoing,
      503,
      errorBody(
        "E_SPA_NOT_BUILT",
        "The console bundle is not present. Run the build before serving this deployment.",
      ),
    );
    return;
  }
  serveFile(indexPath, outgoing, false);
}

/* -------------------------------------------------------------------------- */
/* Request listener                                                            */
/* -------------------------------------------------------------------------- */

export function createConsoleRequestListener(): (
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) => Promise<void> {
  return async (incoming, outgoing) => {
    let url: URL;
    try {
      url = new URL(incoming.url ?? "/", "http://console.invalid");
    } catch {
      notFound(outgoing);
      return;
    }
    const { pathname } = url;
    const method = incoming.method ?? "GET";

    if (method === "GET" && pathname === "/healthz") {
      json(outgoing, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && pathname === "/readyz") {
      let verdict: ReleaseReadiness;
      try {
        verdict = await readinessProbe();
      } catch (cause) {
        json(outgoing, 503, {
          status: "unavailable",
          detail: "The release-readiness probe threw.",
          error: errorBody(
            "E_READINESS_PROBE_FAILED",
            cause instanceof Error ? cause.message : "The release-readiness probe failed.",
          ),
        });
        return;
      }
      json(outgoing, verdict.ready ? 200 : 503, {
        status: verdict.ready ? "ready" : "unavailable",
        detail: verdict.detail,
      });
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const apiPath = pathname.slice("/api".length) || "/";
      const match = matchApiRoute(method, apiPath);
      await handleApi(match, {
        method,
        pathname: apiPath,
        query: url.searchParams,
        request: incoming,
        params: match?.params ?? Object.freeze({}),
      }, outgoing);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      // The console is read-only. Any write verb is refused outright rather
      // than falling through to the SPA.
      writeHead(outgoing, 405, {
        "content-type": "application/json; charset=utf-8",
        allow: "GET, HEAD",
        "cache-control": "no-store",
      });
      outgoing.end(
        JSON.stringify(
          errorBody("E_READ_ONLY", "This console exposes read-only endpoints."),
        ),
      );
      return;
    }

    const asset = resolveStaticPath(pathname);
    if (asset !== undefined) {
      // Fingerprinted files live under /assets/ in a Vite build.
      serveFile(asset, outgoing, pathname.startsWith("/assets/"));
      return;
    }

    serveSpa(outgoing);
  };
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                     */
/* -------------------------------------------------------------------------- */

function socketEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    process.stderr.write(
      `ega-web startup warning: ${name} is not a positive safe integer; using ${fallback}\n`,
    );
    return fallback;
  }
  return value;
}

const listener = createConsoleRequestListener();

// Register the console read routes and build the real readiness probe. Builder 1
// shipped this file with an empty registry and a conservative default probe; both
// seams are still exported, so this is the only wiring statement the entrypoint
// needs. `installConsoleApi` returns the probe rather than installing it, because
// `server/api.ts` must not import a value from this file.
setReleaseReadinessProbe(installConsoleApi(API_ROUTES, defaultReadinessProbe));

const server = createServer((incoming, outgoing) => {
  void listener(incoming, outgoing).catch(() => {
    // Last-resort net: a controlled 500, never a thrown stack trace.
    try {
      if (!outgoing.writableEnded) {
        outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        outgoing.end(
          JSON.stringify(errorBody("E_INTERNAL", "The console failed to handle this request.")),
        );
      }
    } catch {
      try {
        outgoing.destroy();
      } catch {
        // Never let an error-response failure crash the process.
      }
    }
  });
});

server.maxConnections = socketEnv(process.env["EGA_WEB_MAX_CONNECTIONS"], 128, "EGA_WEB_MAX_CONNECTIONS");

const port = socketEnv(process.env["PORT"], 3000, "PORT");
server.listen(port, () => {
  process.stderr.write(`ega-web-console listening on ${port}\n`);
});