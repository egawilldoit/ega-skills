/**
 * EGA Skills Web Console — typed fetch wrapper for the same-origin BFF.
 *
 * Design rules:
 *  - One base URL. Every request is same-origin (`/api/...`) so the CSP needs
 *    only `connect-src 'self'` for API traffic and no credentialed cross-origin
 *    request is ever made from the browser.
 *  - No secrets. The only credential is the first-party Supabase user access
 *    token supplied by the caller, attached as `Authorization: Bearer`. The
 *    publishable key is already in the bundle by design; nothing here reads
 *    `process.env` or a server-only variable.
 *  - Errors are normalized into the `ApiError` union from `./contracts` so no
 *    call site has to inspect a `Response` or a raw `TypeError`.
 *  - Every request accepts an `AbortSignal`; callers are expected to abort on
 *    unmount so a slow BFF query cannot resolve into a dead component.
 */

import type { ApiError, ApiErrorEnvelope, ApiErrorKind } from "./contracts";

/** Same-origin BFF prefix. Never a full URL: relative keeps cookies and CSP sane. */
export const API_BASE_PATH = "/api";

/** Canonical digest form enforced by the control-plane `check` constraints. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isReleaseDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/** True for UUIDs, the identifier form used by every control-plane table. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Percent-encode one path segment, rejecting values that could escape the
 * segment or change the route shape (empty, `.`, `..`, or containing `/`).
 * Digests are `sha256:<hex>` so the `:` encodes to `%3A`, which the server
 * decodes back before lookup.
 */
export function encodePathSegment(value: string, label: string): string {
  if (value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new TypeError(`${label} must be a single URL path segment`);
  }
  return encodeURIComponent(value);
}

/**
 * Encode a canonical skill id for a single path segment.
 *
 * A skill id is `<namespace>/<portable-name>`, so it CONTAINS a slash and cannot go through
 * `encodePathSegment`, which rejects a slash precisely because it would change the path
 * structure. Here the slash is wanted inside one segment: percent-encoding it yields
 * `namespace%2Fportable-name`, and the server splits the path first and percent-decodes the
 * segment afterwards, so the id arrives intact without ever becoming two segments.
 *
 * Only the shapes that could genuinely alter path structure or escape the segment are refused;
 * everything else is percent-encoded, so no caller can inject an extra path segment.
 */
export function encodeSkillIdPathSegment(skillId: string): string {
  if (skillId === "" || skillId === "." || skillId === ".." || skillId.includes("\0")) {
    throw new TypeError("skillId must be a non-empty canonical <namespace>/<portable-name> string");
  }
  return encodeURIComponent(skillId);
}

export type QueryValue = string | number | boolean;

/**
 * Deterministic query serialization: keys sorted so a given logical request
 * produces exactly one URL (useful for caching and for tests). `undefined` and
 * empty-string values are dropped rather than sent as blanks.
 */
export function buildQueryString(query: Readonly<Record<string, QueryValue | undefined>>): string {
  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    const text = String(value);
    if (text === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function apiUrl(
  path: string,
  query?: Readonly<Record<string, QueryValue | undefined>>,
): string {
  if (!path.startsWith("/")) throw new TypeError("API path must start with '/'");
  return `${API_BASE_PATH}${path}${query ? buildQueryString(query) : ""}`;
}

/**
 * Canonical BFF endpoints. Builders 2 and 3 must serve exactly these paths;
 * keeping them in one constant means the SPA and the server cannot disagree.
 */
export const API_ENDPOINTS = {
  catalog: "/catalog",
  skills: "/skills",
  skill: (skillId: string) => `/skills/${encodeSkillIdPathSegment(skillId)}`,
  releases: "/releases",
  /** `/releases/compare` must never be shadowed by `/releases/:releaseDigest`. */
  releaseCompare: () => "/releases/compare",
  release: (releaseDigest: string) => `/releases/${encodePathSegment(releaseDigest, "releaseDigest")}`,
  projects: "/projects",
  project: (projectId: string) => `/projects/${encodePathSegment(projectId, "projectId")}`,
  workspace: "/workspace",
  members: "/workspace/members",
  /** Policy and observed usage in one response; see `WorkspaceQuotaView`. */
  workspaceQuotas: () => "/workspace/quotas",
  securityDenies: "/workspace/security/denies",
  analyticsUsage: () => "/analytics/usage",
  auditEvents: "/audit",
} as const;

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-request options. Generic so `decode` can return the caller's `T` while
 * the request path stays unparameterized.
 */
export interface RequestOptions<T> {
  /** Caller-owned cancellation. Combined with the timeout via `AbortSignal.any`. */
  readonly signal?: AbortSignal;
  readonly query?: Readonly<Record<string, QueryValue | undefined>>;
  /** Optional per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Runtime decoder for the payload. When omitted the parsed JSON is returned
   * as `T` on trust. There is no backend yet, so no DTO guard exists; add a
   * decoder in the same commit that introduces a real endpoint.
   */
  readonly decode?: (value: unknown) => T;
}

export interface ApiClientOptions {
  /** Prefix override. Defaults to `API_BASE_PATH`. */
  readonly basePath?: string;
  /** Injected for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Supplies the first-party Supabase user access token, or `null` when signed
   * out. The token is never logged, never stored, and never sent anywhere but
   * the same-origin BFF.
   */
  readonly getAccessToken?: () => Promise<string | null>;
  /** Applied to every request. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Applied to every request unless overridden. */
  readonly defaultTimeoutMs?: number;
}

export interface ApiClient {
  readonly basePath: string;
  get<T>(path: string, options?: RequestOptions<T>): Promise<T>;
}

/** Map an HTTP status onto an `ApiError` discriminant. */
export function errorKindForStatus(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 503) return "unavailable";
  return "server";
}

/** Transport-level retry guidance. `4xx` other than 408/429 is not retryable. */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

function error(
  kind: ApiErrorKind,
  message: string,
  status: number | null,
  code: string | null,
): ApiError {
  const retryable =
    kind === "network" || kind === "unavailable" || kind === "server";
  return { kind, message, status, code, retryable } as ApiError;
}

function isAbortLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Turn an unknown thrown value into an `ApiError`. Never includes the thrown
 * object's stack or the request URL, both of which can carry identifiers.
 */
export function normalizeThrownError(cause: unknown): ApiError {
  if (isAbortLike(cause)) {
    return error("aborted", "The request was cancelled before it completed.", null, null);
  }
  const detail = cause instanceof Error ? cause.message : "Unknown transport failure.";
  return error("network", `Transport failure: ${detail}`, null, null);
}

/** Read the server's `ApiErrorEnvelope`, tolerating a non-envelope body. */
export async function readErrorEnvelope(response: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const text = await response.text();
    if (text === "") return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const inner = (parsed as { error?: unknown }).error;
    if (typeof inner !== "object" || inner === null) return null;
    const { code, message } = inner as { code?: unknown; message?: unknown };
    if (typeof code !== "string" || typeof message !== "string") return null;
    return { error: { code, message } };
  } catch {
    // A non-JSON error body (proxy HTML, truncated body) still yields a typed
    // error; the status alone is enough to classify it.
    return null;
  }
}

export function apiErrorFromResponse(status: number, envelope: ApiErrorEnvelope | null): ApiError {
  const kind = errorKindForStatus(status);
  const message = envelope?.error.message ?? `HTTP ${status}`;
  const code = envelope?.error.code ?? null;
  // `errorKindForStatus` only ever returns an access kind, so this widening of
  // `ApiAccessError` to the full `ApiError` union is safe and keeps the mapping
  // in one place.
  return { kind, message, status, code, retryable: isRetryableStatus(status) };
}

/** Compose the caller signal with the per-request deadline. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  if (timeoutMs === undefined) return { signal, dispose: () => {} };
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return { signal: timeoutSignal, dispose: () => {} };
  return { signal: AbortSignal.any([signal, timeoutSignal]), dispose: () => {} };
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const basePath = options.basePath ?? API_BASE_PATH;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const defaultHeaders = options.defaultHeaders ?? {};
  const defaultTimeoutMs = options.defaultTimeoutMs;

  async function get<T>(path: string, requestOptions: RequestOptions<T> = {}): Promise<T> {
    if (typeof fetchImpl !== "function") {
      throw error(
        "not_configured",
        "No fetch implementation is available in this runtime.",
        null,
        null,
      );
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...defaultHeaders,
    };
    if (options.getAccessToken !== undefined) {
      const token = await options.getAccessToken();
      if (token !== null && token !== "") headers["authorization"] = `Bearer ${token}`;
    }

    const query = requestOptions.query;
    const url = `${basePath}${path}${query ? buildQueryString(query) : ""}`;
    const { signal, dispose } = withTimeout(requestOptions.signal, requestOptions.timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        // Same-origin only, so this sends cookies the BFF may need and never
        // crosses an origin boundary.
        credentials: "same-origin",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw normalizeThrownError(cause);
    } finally {
      dispose();
    }

    if (!response.ok) {
      throw apiErrorFromResponse(response.status, await readErrorEnvelope(response));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw error(
        "malformed_response",
        "The API returned a success status with a body that is not JSON.",
        response.status,
        null,
      );
    }

    if (requestOptions.decode !== undefined) {
      return requestOptions.decode(payload);
    }
    // Trusted cast: there is no backend yet, so no payload exists to validate.
    // Replace with `decode` in the same commit that adds a real endpoint.
    return payload as T;
  }

  return { basePath, get };
}