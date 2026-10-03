/**
 * EGA Skills Web Console — shared API data-transfer objects.
 *
 * These types are the contract between the console SPA (this app) and the BFF
 * served by `apps/web/server.mts`. They are declared now, before any endpoint
 * exists, so Builders 2 and 3 compile against a single source of truth.
 *
 * Rules for implementers:
 *  1. Field names mirror the hosted control plane (`supabase/migrations/`) and
 *     the domain packages (`packages/control-plane`, `packages/schema`) rather
 *     than a prettified UI vocabulary. The console renders them as received.
 *  2. A field is nullable only when the database genuinely allows the absence
 *     of the underlying value. Absent *data* is modelled with an explicit
 *     `null` plus a sibling `*_reason` string; it is never faked with a zero,
 *     an empty array, or a placeholder label.
 *  3. Every DTO is frozen-shape: `readonly` everywhere, no classes, no
 *     methods. Responses cross a trust boundary and must not be mutated.
 *
 * Digests are always the canonical `sha256:<64 hex>` form enforced by the
 * database `check` constraints (`release_digest ~ '^sha256:[0-9a-f]{64}$'`).
 */

import type { WorkspaceRole } from "../console-model";

/* -------------------------------------------------------------------------- */
/* Release identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Integrity state of a release as observed by the BFF.
 *
 * - `stable`    — the release digest matches the verified snapshot on disk.
 * - `unpinned`  — the digest is well-formed but this deployment has no
 *                 retained manifest entry authorizing it, so its contents are
 *                 unknown and MUST NOT be served.
 * - `mismatch`  — the retained manifest authorizes the digest but the artifact
 *                 digest or snapshot contents disagree with it.
 *
 * The console treats anything other than `stable` as fail-closed: it must show
 * the identity, show `mismatch_reason`, and refuse to present release contents
 * as trustworthy.
 */
export type ReleaseIntegrityStatus = "stable" | "unpinned" | "mismatch";

/**
 * The single fact every release surface renders.
 *
 * Invariant enforced by the BFF and relied upon by the UI:
 * `status === "mismatch"` if and only if `mismatch_reason !== null`.
 * A `stable` or `unpinned` release carries `mismatch_reason: null` and, in the
 * `unpinned` case, its reason is carried by the accompanying HTTP status /
 * `ReleaseDetail.stable_pointer_updated_at` instead.
 */
export interface ReleaseIdentity {
  /** Canonical `sha256:<64 hex>` release digest. */
  readonly release_digest: string;
  /** UUID of the owning hub. */
  readonly hub_id: string;
  readonly status: ReleaseIntegrityStatus;
  /** Skills present in the verified snapshot. Zero is a legitimate value. */
  readonly skill_count: number;
  /** Rows in the released SQLite snapshot. Zero is a legitimate value. */
  readonly snapshot_rows: number;
  /** Canonical `sha256:<64 hex>` digest of the SQLite artifact. */
  readonly sqlite_artifact_digest: string;
  /** Publication revision, when the deployment records one. */
  readonly publication_revision?: string;
  /** Human-readable explanation. Non-null exactly when `status === "mismatch"`. */
  readonly mismatch_reason: string | null;
}

/** Immutable-object backing one half of a release. */
export interface ReleaseArtifactRef {
  /** `release` (serialized HubRelease) or `sqlite`. */
  readonly artifact_kind: "release" | "sqlite";
  /** Canonical `sha256:<64 hex>` object digest. */
  readonly object_digest: string;
  /** Byte length from `public.immutable_objects.byte_length`. */
  readonly byte_length: number;
  readonly created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Catalog and skills                                                          */
/* -------------------------------------------------------------------------- */

/** Catalog-wide totals for one workspace. */
export interface CatalogSummary {
  readonly workspace_id: string;
  readonly hub_id: string;
  /** Currently readable release, or `null` when no release can be read. */
  readonly release: ReleaseIdentity | null;
  /** Why `release` is `null`. Non-null exactly when `release === null`. */
  readonly release_unavailable_reason: string | null;
  readonly skill_total: number;
  readonly domain_total: number;
  /** Server timestamp of the snapshot these totals came from. */
  readonly generated_at: string;
}

/** One skill as listed in the catalog. */
export interface SkillSummary {
  readonly skill_id: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly triggers: readonly string[];
  readonly schema_version: number;
  /** Canonical `sha256:<64 hex>` content digest of `SKILL.md`. */
  readonly content_digest: string;
}

/** Provenance of the skill content (one adopted source revision). */
export interface SkillSourceRef {
  readonly source_id: string;
  /** Resolved revision of the source, not a branch name. */
  readonly revision: string;
  /** Repository-relative path the skill was adopted from. */
  readonly path: string;
}

/** One file inside a released skill. */
export interface SkillFileRef {
  /** POSIX path relative to the skill root. Never absolute, never `..`. */
  readonly path: string;
  readonly byte_length: number;
  readonly content_digest: string;
}

/** Router-visible routing block from `ega.yaml`. */
export interface SkillRouting {
  readonly domains: readonly string[];
  readonly triggers: readonly string[];
  readonly exclude_patterns: readonly string[];
  /** Absent when `ega.yaml` does not pin a priority. */
  readonly priority: number | null;
}

/** Full skill record for the detail route. */
export interface SkillDetail {
  readonly summary: SkillSummary;
  readonly routing: SkillRouting;
  readonly sources: readonly SkillSourceRef[];
  readonly files: readonly SkillFileRef[];
  /** Release this detail was read from. */
  readonly release: ReleaseIdentity | null;
}

/* -------------------------------------------------------------------------- */
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

/** Row in the release list. */
export interface ReleaseSummary {
  readonly release: ReleaseIdentity;
  readonly published_at: string;
  /** True when `hub_stable_pointers` currently points at this digest. */
  readonly is_stable: boolean;
}

/** Release detail: identity, artifacts, and stable-pointer bookkeeping. */
export interface ReleaseDetail {
  readonly release: ReleaseIdentity;
  readonly published_at: string;
  readonly is_stable: boolean;
  readonly artifacts: readonly ReleaseArtifactRef[];
  /** From `hub_stable_pointers.updated_at`; `null` when no pointer exists. */
  readonly stable_pointer_updated_at: string | null;
}

/**
 * Difference between two releases.
 *
 * Both sides carry a full `ReleaseIdentity` so the UI can refuse to diff a
 * side whose status is not `stable`. The `*_unavailable_reason` fields explain
 * a side that could not be read; when set, the corresponding id lists are
 * empty and MUST be rendered as unavailable rather than as "no differences".
 */
export interface ReleaseDiffView {
  readonly base: ReleaseIdentity | null;
  readonly head: ReleaseIdentity | null;
  readonly base_unavailable_reason: string | null;
  readonly head_unavailable_reason: string | null;
  readonly added_skill_ids: readonly string[];
  readonly removed_skill_ids: readonly string[];
  readonly changed_skill_ids: readonly string[];
  readonly unchanged_skill_ids: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Projects and contexts                                                       */
/* -------------------------------------------------------------------------- */

/** Row in the project list. */
export interface ProjectSummary {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly created_at: string;
  /** Published contexts with `revoked_at is null`. */
  readonly active_context_count: number;
}

/**
 * Project detail for the `/projects/:projectId` route: the project row plus
 * every published context, revoked ones included. Revoked rows are retained in
 * the database and MUST stay visible here with their revocation reason.
 */
export interface ProjectDetail {
  readonly project: ProjectSummary;
  readonly contexts: readonly ProjectContextSummary[];
}

/** One published project context. */
export interface ProjectContextSummary {
  readonly context_id: string;
  readonly project_id: string;
  /** Canonical `sha256:<64 hex>` context digest. */
  readonly context_digest: string;
  readonly release_digest: string;
  readonly published_at: string;
  /** Non-null once revoked; the row is retained, never deleted. */
  readonly revoked_at: string | null;
  /** Why it was revoked. Non-null exactly when `revoked_at` is non-null. */
  readonly revocation_reason: string | null;
  /** Revocation actor subject. Non-null exactly when `revoked_at` is non-null. */
  readonly revoked_by: string | null;
}

/* -------------------------------------------------------------------------- */
/* Workspace                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The workspace plus the viewer's own role.
 *
 * The role is always the *viewer's* row from `workspace_memberships`, readable
 * under `membership_self_or_admin_read` even for a non-admin. It is never
 * inferred client-side.
 */
export interface WorkspaceSummary {
  readonly workspace_id: string;
  /** `personal_workspaces.owner_subject`. */
  readonly owner_subject: string;
  readonly created_at: string;
  readonly viewer_role: WorkspaceRole;
}

/** One membership row. */
export interface MemberRow {
  readonly subject: string;
  readonly role: WorkspaceRole;
  readonly active: boolean;
  readonly created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Quotas, security, audit, usage                                             */
/* -------------------------------------------------------------------------- */

/** `public.quota_policies`. */
export interface QuotaPolicyRow {
  readonly workspace_id: string;
  readonly requests_per_minute: number;
  readonly concurrent_requests: number;
  readonly bandwidth_bytes: number;
}

/** One `public.quota_usage` window. */
export interface QuotaUsageRow {
  readonly workspace_id: string;
  readonly window_started: string;
  readonly request_count: number;
  readonly bandwidth_bytes: number;
}

/**
 * Quota policy plus observed usage for the quota routes.
 *
 * `policy` is `null` when no policy row exists for the workspace, and
 * `usage` is empty when no window has been recorded. Both absences are carried
 * with an explicit reason string so the UI can explain the gap instead of
 * implying a measurement of zero.
 */
export interface WorkspaceQuotaView {
  readonly workspace_id: string;
  readonly policy: QuotaPolicyRow | null;
  readonly policy_unavailable_reason: string | null;
  readonly usage: readonly QuotaUsageRow[];
  readonly usage_unavailable_reason: string | null;
}

/** `public.security_denies` row. */
export interface SecurityDenyRow {
  readonly id: string;
  readonly kind: "hub" | "release" | "skill" | "source" | "blob";
  readonly identity: string;
  readonly reason: string;
  readonly created_at: string;
}

/** `public.audit_events` row. */
export interface AuditRow {
  readonly id: string;
  readonly actor_subject: string;
  readonly operation: string;
  readonly target_identity: string | null;
  readonly old_identity: string | null;
  readonly new_identity: string | null;
  readonly request_id: string | null;
  readonly occurred_at: string;
  readonly result: "allowed" | "denied";
}

/**
 * Usage rollup for the analytics route.
 *
 * `policy` is `null` when no quota policy row is readable; `windows` is empty
 * when no usage window has been recorded. Both are legitimate states and the UI
 * must say so rather than render zeroes as if they were measurements.
 */
export interface UsageSummary {
  readonly workspace_id: string;
  /** Inclusive start of the reported window. */
  readonly window_started: string;
  /** Exclusive end of the reported window. */
  readonly window_ends_at: string;
  readonly request_count: number;
  readonly bandwidth_bytes: number;
  readonly windows: readonly QuotaUsageRow[];
  readonly policy: QuotaPolicyRow | null;
  /** Explains an empty `windows` array. `null` when windows are present. */
  readonly windows_unavailable_reason: string | null;
}

/* -------------------------------------------------------------------------- */
/* Error envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wire error body every non-2xx `/api/*` response carries.
 *
 * `code` is a stable machine identifier; `message` is safe to show an operator
 * (it must never contain secrets, stack traces, or SQL text).
 */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Normalized client-side error.
 *
 * A union rather than a class so the exhaustive `switch` in the UI is checked
 * by the compiler: adding a `kind` forces every render site to be revisited.
 * `retryable` is a statement about transport only — the console may offer a
 * retry affordance for `network`, `unavailable`, and `server` failures.
 */
export interface ApiErrorBase {
  /** Operator-safe explanation. */
  readonly message: string;
  /** Server error code, or `null` when the failure happened before a response. */
  readonly code: string | null;
  /** HTTP status, or `null` when no response was received. */
  readonly status: number | null;
  readonly retryable: boolean;
}

/** The request never completed: DNS, TLS, offline, connection reset. */
export interface ApiNetworkError extends ApiErrorBase {
  readonly kind: "network";
}

/** The caller aborted the request (navigation, filter change). Not an error. */
export interface ApiAbortedError extends ApiErrorBase {
  readonly kind: "aborted";
}

/** No API base URL is configured, so no request was attempted. */
export interface ApiNotConfiguredError extends ApiErrorBase {
  readonly kind: "not_configured";
}

/** A response arrived but its status means the caller may not proceed. */
export interface ApiAccessError extends ApiErrorBase {
  readonly kind: "unauthorized" | "forbidden" | "not_found" | "conflict" | "unavailable" | "server";
}

/** A response arrived but did not match the declared DTO shape. */
export interface ApiMalformedResponseError extends ApiErrorBase {
  readonly kind: "malformed_response";
}

export type ApiError =
  | ApiNetworkError
  | ApiAbortedError
  | ApiNotConfiguredError
  | ApiAccessError
  | ApiMalformedResponseError;

/** Discriminant of `ApiError`. Exported for exhaustive switches. */
export type ApiErrorKind = ApiError["kind"];

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "network" ||
    kind === "aborted" ||
    kind === "not_configured" ||
    kind === "unauthorized" ||
    kind === "forbidden" ||
    kind === "not_found" ||
    kind === "conflict" ||
    kind === "unavailable" ||
    kind === "server" ||
    kind === "malformed_response"
  );
}

/**
 * Human sentence for an error, including the reason the console is showing an
 * empty view rather than data.
 */
export function describeApiError(error: ApiError): string {
  switch (error.kind) {
    case "network":
      return `The console could not reach its own API. ${error.message}`;
    case "aborted":
      return "The request was cancelled.";
    case "not_configured":
      return `The console API is not configured. ${error.message}`;
    case "unauthorized":
      return `Sign in required. ${error.message}`;
    case "forbidden":
      return `Your workspace role does not grant this read. ${error.message}`;
    case "not_found":
      return `This view is not available from this deployment. ${error.message}`;
    case "conflict":
      return error.message;
    case "unavailable":
      return `The API is not ready. ${error.message}`;
    case "server":
      return `The API failed. ${error.message}`;
    case "malformed_response":
      return `The API returned a response this console cannot read. ${error.message}`;
  }
}

/**
 * True when the failure is "this deployment does not serve this view" rather
 * than "something went wrong". Pages use it to render an explicit unavailable
 * state instead of a retry loop.
 */
export function isUnavailableError(error: ApiError): boolean {
  return error.kind === "not_configured" || error.kind === "not_found";
}