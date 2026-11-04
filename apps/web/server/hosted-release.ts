/**
 * Canonical hosted MCP release observation for the Console.
 *
 * The Console already knows which immutable release it can read. This module
 * answers a different question: which release is the fixed canonical hosted MCP
 * serving right now? It deliberately keeps the two facts separate.
 *
 * ## Boundaries
 *
 * - The endpoint is a constant. No request parameter, header, or environment
 *   value can replace it, so this module is not a URL proxy and cannot be turned
 *   into one by a caller.
 * - The check is bounded by a timeout and a small body limit. Every failure is
 *   an honest `unknown`; this module never guesses and never serves a stale
 *   observation as live.
 * - A matching digest identifies the same release artifact. It is **not**
 *   evidence that every caller may read every skill, and it is never used to
 *   authorize anything.
 */

import { isCanonicalDigest, type ServerConfig } from "./env.ts";
import { getReleaseIdentityBinding } from "./release-identity.ts";

/** The one canonical hosted MCP readiness endpoint this Console may observe. */
export const CANONICAL_HOSTED_MCP_READYZ_URL = "https://ega-skills-mcp.vercel.app/readyz";

/** A readiness probe may take this long before the state becomes unknown. */
export const HOSTED_READINESS_TIMEOUT_MS = 2_000;

/** A successful observation is reusable for this long, then it is stale. */
export const HOSTED_READINESS_FRESHNESS_MS = 15_000;

/** The readiness response is tiny; anything larger is refused unread. */
export const HOSTED_READINESS_MAX_BODY_BYTES = 2_048;

/** The three states the Console may present. */
export type HostedReleaseState = "matches" | "different" | "unknown";

/**
 * One observation of the canonical hosted MCP release.
 *
 * `observed_at` is non-null only for a successful readiness observation. A
 * failed attempt still reports `checked_at`, so the UI can say that a check ran
 * without claiming a successful observation.
 */
export interface HostedReleaseStatusView {
  readonly state: HostedReleaseState;
  readonly console_release_digest: string | null;
  readonly hosted_release_digest: string | null;
  readonly observed_at: string | null;
  /**
   * When the Console handled this status request.
   *
   * A cached observation keeps its original `observed_at` while this timestamp
   * advances. It is not proof that the Console contacted the MCP again.
   */
  readonly checked_at: string;
  /** Non-null exactly when `state === "unknown"`. */
  readonly reason: string | null;
  /** The fixed canonical endpoint, shown for transparency. */
  readonly endpoint: string;
}

/** Overridable collaborators. Tests inject time and fetch; production does not. */
export interface HostedReleaseDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly freshnessMs?: number;
}

/**
 * One accepted observation, keyed by the Console digest it was compared with.
 *
 * A cached entry keeps its original `observedAtMs`. A later request updates the
 * response's `checked_at` but reuses this `observed_at`, so the UI never claims
 * a new upstream check happened. Entries older than the freshness window are
 * never served; they are re-observed or the state becomes unknown.
 */
interface CachedObservation {
  readonly consoleDigest: string;
  readonly hostedDigest: string;
  readonly observedAtMs: number;
}

let cache: CachedObservation | null = null;

/** A refused observation whose message is already safe to show. */
class HostedReadinessError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "HostedReadinessError";
    this.reason = reason;
  }
}

function unknownStatus(
  consoleDigest: string | null,
  checkedAt: string,
  reason: string,
): HostedReleaseStatusView {
  return Object.freeze({
    state: "unknown",
    console_release_digest: consoleDigest,
    hosted_release_digest: null,
    observed_at: null,
    checked_at: checkedAt,
    reason,
    endpoint: CANONICAL_HOSTED_MCP_READYZ_URL,
  });
}

function observedStatus(
  consoleDigest: string,
  hostedDigest: string,
  observedAtMs: number,
  checkedAt: string,
): HostedReleaseStatusView {
  return Object.freeze({
    state: consoleDigest === hostedDigest ? "matches" : "different",
    console_release_digest: consoleDigest,
    hosted_release_digest: hostedDigest,
    observed_at: new Date(observedAtMs).toISOString(),
    checked_at: checkedAt,
    reason: null,
    endpoint: CANONICAL_HOSTED_MCP_READYZ_URL,
  });
}

/**
 * Read the fixed canonical readiness response.
 *
 * The whole exchange is raced against the deadline by the caller, so a fetch
 * implementation that ignores abort cannot hang the request. This function only
 * validates what a successful HTTP 200 actually contained.
 */
async function fetchHostedDigest(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(CANONICAL_HOSTED_MCP_READYZ_URL, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal,
  });

  if (response.status !== 200) {
    throw new HostedReadinessError(
      `The canonical hosted MCP readiness check returned HTTP ${response.status}.`,
    );
  }

  const body = await readBoundedBody(response);
  return parseReadiness(body);
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HostedReadinessError(
        "The canonical hosted MCP readiness response declared an invalid length.",
      );
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw new HostedReadinessError(
        "The canonical hosted MCP readiness response declared an invalid length.",
      );
    }
    if (length > HOSTED_READINESS_MAX_BODY_BYTES) {
      throw new HostedReadinessError(
        `The canonical hosted MCP readiness response exceeded the ${HOSTED_READINESS_MAX_BODY_BYTES}-byte limit.`,
      );
    }
  }

  const body = response.body;
  if (body === null) {
    throw new HostedReadinessError(
      "The canonical hosted MCP readiness response had no readable body.",
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const textChunks: string[] = [];
  let receivedBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > HOSTED_READINESS_MAX_BODY_BYTES) {
        // Stop the producer before the oversized chunk can join the accepted
        // text. `cancel` is best effort: the limit error is the real result.
        try {
          await reader.cancel();
        } catch {
          // The stream is already unusable; the size refusal still stands.
        }
        throw new HostedReadinessError(
          `The canonical hosted MCP readiness response exceeded the ${HOSTED_READINESS_MAX_BODY_BYTES}-byte limit.`,
        );
      }

      textChunks.push(decoder.decode(value, { stream: true }));
    }

    textChunks.push(decoder.decode());
    return textChunks.join("");
  } catch (error) {
    if (error instanceof HostedReadinessError) throw error;
    try {
      await reader.cancel();
    } catch {
      // Ignore a cancel failure on an already broken stream.
    }
    throw new HostedReadinessError(
      "The canonical hosted MCP readiness response could not be read completely.",
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A reader with a pending read can reject releaseLock; the body is
      // already refused, so there is nothing useful to do here.
    }
  }
}

/**
 * Strict readiness schema.
 *
 * Exactly the two facts the hosted runtime publishes are load-bearing: the
 * service is ready, and the digest is canonical. Nothing else is inferred from
 * an extra field, and no non-canonical digest is ever compared.
 */
function parseReadiness(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HostedReadinessError(
      "The canonical hosted MCP readiness response was not valid JSON.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HostedReadinessError(
      "The canonical hosted MCP readiness response was not a JSON object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  if (record["status"] !== "ready") {
    throw new HostedReadinessError(
      "The canonical hosted MCP readiness response did not report ready status.",
    );
  }

  const digest = record["release_digest"];
  if (typeof digest !== "string" || !isCanonicalDigest(digest)) {
    throw new HostedReadinessError(
      "The canonical hosted MCP readiness response carried an invalid release digest.",
    );
  }
  return digest;
}

function reasonFor(error: unknown, aborted: boolean, timeoutMs: number): string {
  if (error instanceof HostedReadinessError) return error.reason;
  if (aborted) {
    return `The canonical hosted MCP readiness check timed out after ${timeoutMs} ms.`;
  }
  return "The canonical hosted MCP readiness check could not be completed.";
}

/**
 * Observe the canonical hosted MCP release and compare it with this Console's
 * verified release.
 *
 * Never throws. A missing Console identity short-circuits before any network
 * request, and every transport, schema, freshness, or timeout failure becomes
 * `unknown`.
 */
export async function getHostedReleaseStatus(
  config?: Readonly<ServerConfig>,
  deps: HostedReleaseDependencies = {},
): Promise<HostedReleaseStatusView> {
  const now = deps.now ?? Date.now;
  const checkedAtMs = now();
  const checkedAt = new Date(checkedAtMs).toISOString();

  let consoleDigest: string | null = null;
  try {
    const binding = getReleaseIdentityBinding(config);
    if (binding.identity !== null && binding.identity.status === "mismatch") {
      return unknownStatus(
        null,
        checkedAt,
        "The Console release does not match the deployment's expected release, so no hosted comparison is made.",
      );
    }
    const candidate = binding.identity?.release_digest ?? null;
    consoleDigest = candidate !== null && isCanonicalDigest(candidate) ? candidate : null;
  } catch {
    return unknownStatus(
      null,
      checkedAt,
      "The Console release identity could not be read.",
    );
  }

  if (consoleDigest === null) {
    return unknownStatus(
      null,
      checkedAt,
      "The Console has no verified release identity, so there is nothing to compare.",
    );
  }

  const freshnessMs = deps.freshnessMs ?? HOSTED_READINESS_FRESHNESS_MS;
  if (cache !== null && cache.consoleDigest === consoleDigest) {
    const age = checkedAtMs - cache.observedAtMs;
    // A clock that moved backwards cannot prove freshness either. Treat it the
    // same as an expired observation and re-check.
    if (age >= 0 && age <= freshnessMs) {
      return observedStatus(
        consoleDigest,
        cache.hostedDigest,
        cache.observedAtMs,
        checkedAt,
      );
    }
  }

  const timeoutMs = Math.max(1, deps.timeoutMs ?? HOSTED_READINESS_TIMEOUT_MS);
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new HostedReadinessError(
            `The canonical hosted MCP readiness check timed out after ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
    });

    const hostedDigest = await Promise.race([
      fetchHostedDigest(fetchImpl, controller.signal),
      timeout,
    ]);

    const observedAtMs = now();
    cache = Object.freeze({
      consoleDigest,
      hostedDigest,
      observedAtMs,
    });
    return observedStatus(consoleDigest, hostedDigest, observedAtMs, checkedAt);
  } catch (error) {
    cache = null;
    return unknownStatus(
      consoleDigest,
      checkedAt,
      reasonFor(error, controller.signal.aborted, timeoutMs),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Drop the short-lived observation cache. Only tests need this. */
export function resetHostedReleaseCache(): void {
  cache = null;
}
