/**
 * Runtime validation for BFF responses.
 *
 * TypeScript's `readonly SkillSummary[]` is a *compile-time* claim about a
 * payload that crosses a network boundary. It is erased at runtime, so
 * `client.get<T>()` used to hand the SPA a bare assertion: the parsed JSON was
 * cast to `T` and whatever arrived was rendered. When the BFF answered `/skills`
 * with the real catalog envelope — `{ skills, total, limit, offset, sort,
 * applied_filters, facets }` — the page read `.length` and `.map` off an object
 * and threw during render, taking the whole route down with it.
 *
 * Every decoder here turns "the payload is not what the contract says" into a
 * thrown {@link ResponseContractError}, which `useApiResource` turns into a
 * controlled error panel. A malformed response is a bug to report, not a crash
 * to propagate into React.
 *
 * These are deliberately hand-written and structural rather than generated: they
 * check the fields the pages actually read, in the shape the server actually
 * returns, so a contract drift is caught at the boundary that caused it. A
 * validator that merely re-stated the TypeScript type would pass everything the
 * type permits and stop being useful.
 */

import { isWorkspaceRole } from "../console-model.ts";

/** Thrown when a response does not match its declared contract. */
export class ResponseContractError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "ResponseContractError";
    this.detail = detail;
  }
}

function fail(what: string, detail: string): never {
  throw new ResponseContractError(`The server response did not match the ${what} contract.`, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, what: string, detail: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(what, `${detail}: expected an array, received ${describe(value)}`);
  return value;
}

function requireString(value: unknown, what: string, detail: string): string {
  if (typeof value !== "string") fail(what, `${detail}: expected a string, received ${describe(value)}`);
  return value;
}

function requireFiniteNumber(value: unknown, what: string, detail: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(what, `${detail}: expected a finite number, received ${describe(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, what: string, detail: string): boolean {
  if (typeof value !== "boolean") fail(what, `${detail}: expected a boolean, received ${describe(value)}`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, what: string, detail: string): boolean {
  return value === undefined ? fallback : requireBoolean(value, what, detail);
}

/**
 * A short, safe description of an unexpected value.
 *
 * Only the JSON type and, for arrays, the length are reported. The payload is
 * untrusted server output and may carry content or user data, so it is never
 * interpolated into an error message that gets rendered or logged verbatim.
 */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  const type = typeof value;
  if (type === "object") return "an object";
  if (type === "string") return "a string";
  return `a ${type}`;
}

/* -------------------------------------------------------------------------- */
/* Skill rows                                                                  */
/* -------------------------------------------------------------------------- */

function requireStringArray(value: unknown, what: string, detail: string): readonly string[] {
  const items = requireArray(value, what, detail);
  return items.map((item, index) => requireString(item, what, `${detail}[${index}]`));
}

/**
 * Validate one skill row.
 *
 * `triggers` is optional on the wire: the server's catalog row carries routing
 * facets, and a skill with no recorded trigger list is an honest empty state
 * rather than a reason to reject the whole page. Everything the table renders
 * directly is required.
 */
function decodeSkillSummary(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  requireString(value.skill_id, what, `${detail}.skill_id`);
  requireString(value.name, what, `${detail}.name`);
  requireString(value.description, what, `${detail}.description`);
  requireString(value.content_digest, what, `${detail}.content_digest`);
  requireString(value.version_hash, what, `${detail}.version_hash`);
  requireStringArray(value.frameworks ?? [], what, `${detail}.frameworks`);
  requireStringArray(value.platforms ?? [], what, `${detail}.platforms`);
  if (value.l1_status !== "AUTHORED" && value.l1_status !== "MISSING") {
    fail(what, `${detail}.l1_status: expected AUTHORED or MISSING, received ${describe(value.l1_status)}`);
  }
  if (value.l1_tokens !== null && typeof value.l1_tokens !== "number") {
    fail(what, `${detail}.l1_tokens: expected a number or null, received ${describe(value.l1_tokens)}`);
  }
  requireFiniteNumber(value.l2_tokens, what, `${detail}.l2_tokens`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Catalog page                                                                */
/* -------------------------------------------------------------------------- */

function decodeFacets(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  return value;
}

/**
 * The real `/catalog` and `/skills` envelope.
 *
 * `/skills` is served by the same `handleCatalog`, so it answers with this shape
 * too — that identity is deliberate (one enumeration, two names), and it is why
 * the page must read `.skills` rather than treating the body as an array.
 */
export function decodeCatalogPage(value: unknown): Record<string, unknown> {
  const what = "catalog page";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  const skills = requireArray(value.skills, what, "skills");
  for (const [index, row] of skills.entries()) {
    decodeSkillSummary(row, what, `skills[${index}]`);
  }
  const total = requireFiniteNumber(value.total, what, "total");
  const limit = requireFiniteNumber(value.limit, what, "limit");
  const offset = requireFiniteNumber(value.offset, what, "offset");
  if (total < 0 || limit < 0 || offset < 0) {
    fail(what, "total, limit and offset must be non-negative counts");
  }
  requireString(value.sort, what, "sort");
  requireString(value.sort_direction, what, "sort_direction");
  decodeFacets(value.facets, what, "facets");
  return value;
}

/* -------------------------------------------------------------------------- */
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

function decodeReleaseIdentity(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  requireString(value.release_digest, what, `${detail}.release_digest`);
  requireString(value.hub_id, what, `${detail}.hub_id`);
  if (value.status !== "stable" && value.status !== "unpinned" && value.status !== "mismatch") {
    fail(
      what,
      `${detail}.status: expected stable, unpinned or mismatch, received ${describe(value.status)}`,
    );
  }
  requireFiniteNumber(value.skill_count, what, `${detail}.skill_count`);
  requireFiniteNumber(value.snapshot_rows, what, `${detail}.snapshot_rows`);
  requireString(value.sqlite_artifact_digest, what, `${detail}.sqlite_artifact_digest`);
  if (value.mismatch_reason !== null && typeof value.mismatch_reason !== "string") {
    fail(what, `${detail}.mismatch_reason: expected string or null, received ${describe(value.mismatch_reason)}`);
  }
  return value;
}

function decodeReleaseSummary(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  const release = value.release;
  if (!isRecord(release)) fail(what, `${detail}.release: expected an object, received ${describe(release)}`);
  requireString(release.release_digest, what, `${detail}.release.release_digest`);
  requireString(release.hub_id, what, `${detail}.release.hub_id`);
  if (release.status !== "stable" && release.status !== "unpinned" && release.status !== "mismatch") {
    fail(
      what,
      `${detail}.release.status: expected stable, unpinned or mismatch, received ${describe(release.status)}`,
    );
  }
  optionalBoolean(value.is_stable, false, what, `${detail}.is_stable`);
  return value;
}

/** The real `/releases` envelope: `{ releases: [...] }`, never a bare array. */
export function decodeReleasesPage(value: unknown): Record<string, unknown> {
  const what = "releases page";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  const releases = requireArray(value.releases, what, "releases");
  for (const [index, row] of releases.entries()) {
    decodeReleaseSummary(row, what, `releases[${index}]`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Release comparison                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `/releases/compare` answers with the diff DTO.
 */
export function decodeReleaseComparison(value: unknown): Record<string, unknown> {
  const what = "release comparison";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  requireString(value.base, what, "base");
  requireString(value.candidate, what, "candidate");
  return value;
}

/* -------------------------------------------------------------------------- */
/* Skill Detail (/skills/:skillId)                                             */
/* -------------------------------------------------------------------------- */

export function decodeSkillContent(value: unknown): Record<string, unknown> {
  const what = "skill content";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  requireString(value.skill_id, what, "skill_id");
  requireString(value.version_hash, what, "version_hash");
  if (value.level !== "L1" && value.level !== "L2") {
    fail(what, `level: expected L1 or L2, received ${describe(value.level)}`);
  }
  requireFiniteNumber(value.token_count, what, "token_count");
  requireString(value.content, what, "content");
  requireFiniteNumber(value.requested_max_tokens, what, "requested_max_tokens");
  if (value.truncated !== false) {
    fail(what, `truncated: expected false, received ${describe(value.truncated)}`);
  }
  if (value.file_path !== undefined && typeof value.file_path !== "string") {
    fail(what, `file_path: expected string or undefined, received ${describe(value.file_path)}`);
  }
  decodeReleaseIdentity(value.release, what, "release");
  return value;
}

export function decodeSkillDetail(value: unknown): Record<string, unknown> {
  const what = "skill detail";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  decodeSkillSummary(value.summary, what, "summary");
  if (!isRecord(value.routing)) fail(what, `routing: expected an object, received ${describe(value.routing)}`);
  requireStringArray(value.routing.domains ?? [], what, "routing.domains");
  requireStringArray(value.routing.triggers ?? [], what, "routing.triggers");
  requireStringArray(value.routing.exclude_patterns ?? [], what, "routing.exclude_patterns");
  requireArray(value.sources, what, "sources");
  requireArray(value.files, what, "files");
  if (value.release !== null && value.release !== undefined) {
    decodeReleaseIdentity(value.release, what, "release");
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Release Detail (/releases/:releaseDigest)                                   */
/* -------------------------------------------------------------------------- */

export function decodeReleaseDetail(value: unknown): Record<string, unknown> {
  const what = "release detail";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  decodeReleaseIdentity(value.release, what, "release");
  if (value.published_at !== null && typeof value.published_at !== "string") {
    fail(what, `published_at: expected string or null, received ${describe(value.published_at)}`);
  }
  requireBoolean(value.is_stable, what, "is_stable");
  const artifacts = requireArray(value.artifacts, what, "artifacts");
  for (const [index, art] of artifacts.entries()) {
    if (!isRecord(art)) fail(what, `artifacts[${index}]: expected an object, received ${describe(art)}`);
    requireString(art.artifact_kind, what, `artifacts[${index}].artifact_kind`);
    requireString(art.object_digest, what, `artifacts[${index}].object_digest`);
    requireFiniteNumber(art.byte_length, what, `artifacts[${index}].byte_length`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Projects (/projects and /projects/:projectId)                               */
/* -------------------------------------------------------------------------- */

function decodeProjectSummary(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  requireString(value.project_id, what, `${detail}.project_id`);
  requireString(value.workspace_id, what, `${detail}.workspace_id`);
  requireString(value.name, what, `${detail}.name`);
  requireString(value.created_at, what, `${detail}.created_at`);
  requireFiniteNumber(value.active_context_count, what, `${detail}.active_context_count`);
  return value;
}

export function decodeProjectsList(value: unknown): readonly Record<string, unknown>[] {
  const what = "projects list";
  const rows = requireArray(value, what, "projects");
  for (const [index, row] of rows.entries()) {
    decodeProjectSummary(row, what, `projects[${index}]`);
  }
  return rows as readonly Record<string, unknown>[];
}

export function decodeProjectDetail(value: unknown): Record<string, unknown> {
  const what = "project detail";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  decodeProjectSummary(value.project, what, "project");
  const contexts = requireArray(value.contexts, what, "contexts");
  for (const [index, ctx] of contexts.entries()) {
    if (!isRecord(ctx)) fail(what, `contexts[${index}]: expected an object, received ${describe(ctx)}`);
    requireString(ctx.context_id, what, `contexts[${index}].context_id`);
    requireString(ctx.project_id, what, `contexts[${index}].project_id`);
    requireString(ctx.context_digest, what, `contexts[${index}].context_digest`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Workspace (/workspace and /workspace/members)                              */
/* -------------------------------------------------------------------------- */

export function decodeWorkspaceSummary(value: unknown): Record<string, unknown> {
  const what = "workspace summary";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  requireString(value.workspace_id, what, "workspace_id");
  requireString(value.owner_subject, what, "owner_subject");
  requireString(value.created_at, what, "created_at");
  if (!isWorkspaceRole(value.viewer_role)) {
    fail(what, `viewer_role: expected a valid workspace role, received ${describe(value.viewer_role)}`);
  }
  return value;
}

export function decodeMembersList(value: unknown): readonly Record<string, unknown>[] {
  const what = "workspace members list";
  const rows = requireArray(value, what, "members");
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) fail(what, `members[${index}]: expected an object, received ${describe(row)}`);
    requireString(row.subject, what, `members[${index}].subject`);
    if (!isWorkspaceRole(row.role)) {
      fail(what, `members[${index}].role: expected a valid workspace role, received ${describe(row.role)}`);
    }
    requireBoolean(row.active, what, `members[${index}].active`);
    requireString(row.created_at, what, `members[${index}].created_at`);
  }
  return rows as readonly Record<string, unknown>[];
}

/* -------------------------------------------------------------------------- */
/* Governance (/workspace/quotas, /workspace/security/denies, /audit)         */
/* -------------------------------------------------------------------------- */

export function decodeWorkspaceQuotas(value: unknown): Record<string, unknown> {
  const what = "workspace quotas";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  requireString(value.workspace_id, what, "workspace_id");
  if (value.policy !== null && value.policy !== undefined) {
    if (!isRecord(value.policy)) fail(what, `policy: expected an object or null, received ${describe(value.policy)}`);
    requireString(value.policy.workspace_id, what, "policy.workspace_id");
    requireFiniteNumber(value.policy.requests_per_minute, what, "policy.requests_per_minute");
    requireFiniteNumber(value.policy.concurrent_requests, what, "policy.concurrent_requests");
    requireFiniteNumber(value.policy.bandwidth_bytes, what, "policy.bandwidth_bytes");
  }
  const usage = requireArray(value.usage, what, "usage");
  for (const [index, row] of usage.entries()) {
    if (!isRecord(row)) fail(what, `usage[${index}]: expected an object, received ${describe(row)}`);
    requireString(row.workspace_id, what, `usage[${index}].workspace_id`);
    requireString(row.window_started, what, `usage[${index}].window_started`);
    requireFiniteNumber(row.request_count, what, `usage[${index}].request_count`);
    requireFiniteNumber(row.bandwidth_bytes, what, `usage[${index}].bandwidth_bytes`);
  }
  return value;
}

export function decodeSecurityDenies(value: unknown): readonly Record<string, unknown>[] {
  const what = "security denies";
  const rows = requireArray(value, what, "denies");
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) fail(what, `denies[${index}]: expected an object, received ${describe(row)}`);
    requireString(row.id, what, `denies[${index}].id`);
    requireString(row.kind, what, `denies[${index}].kind`);
    requireString(row.identity, what, `denies[${index}].identity`);
    requireString(row.reason, what, `denies[${index}].reason`);
    requireString(row.created_at, what, `denies[${index}].created_at`);
  }
  return rows as readonly Record<string, unknown>[];
}

export function decodeAuditList(value: unknown): readonly Record<string, unknown>[] {
  const what = "audit events";
  const rows = requireArray(value, what, "audit");
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) fail(what, `audit[${index}]: expected an object, received ${describe(row)}`);
    requireString(row.id, what, `audit[${index}].id`);
    requireString(row.actor_subject, what, `audit[${index}].actor_subject`);
    requireString(row.operation, what, `audit[${index}].operation`);
    requireString(row.occurred_at, what, `audit[${index}].occurred_at`);
    if (row.result !== "allowed" && row.result !== "denied") {
      fail(what, `audit[${index}].result: expected allowed or denied, received ${describe(row.result)}`);
    }
  }
  return rows as readonly Record<string, unknown>[];
}

/* -------------------------------------------------------------------------- */
/* Usage Analytics (/analytics/usage)                                          */
/* -------------------------------------------------------------------------- */

export function decodeUsageSummary(value: unknown): Record<string, unknown> {
  const what = "usage summary";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  requireString(value.workspace_id, what, "workspace_id");
  requireFiniteNumber(value.request_count, what, "request_count");
  requireFiniteNumber(value.bandwidth_bytes, what, "bandwidth_bytes");
  requireArray(value.windows, what, "windows");
  // CONTRACT-T1 telemetry is optional, but when present its daily series is the
  // one the chart plots. Validated here so a malformed bucket is a controlled
  // error panel rather than a chart drawn from an unvalidated value.
  if (value.telemetry !== null && value.telemetry !== undefined) {
    if (!isRecord(value.telemetry)) {
      fail(what, `telemetry: expected an object or null, received ${describe(value.telemetry)}`);
    }
    requireFiniteNumber(value.telemetry.total_executions, what, "telemetry.total_executions");
    const daily = requireArray(value.telemetry.daily, what, "telemetry.daily");
    for (const [index, bucket] of daily.entries()) {
      if (!isRecord(bucket)) {
        fail(what, `telemetry.daily[${index}]: expected an object, received ${describe(bucket)}`);
      }
      requireString(bucket.date, what, `telemetry.daily[${index}].date`);
      requireFiniteNumber(bucket.executions, what, `telemetry.daily[${index}].executions`);
    }
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Discovery inspection (/discovery)                                           */
/* -------------------------------------------------------------------------- */

export function decodeDiscoveryInspection(value: unknown): Record<string, unknown> {
  const what = "discovery inspection";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  // Only the digest keys the real producer emits, plus the BFF-added
  // `served_release_digest` for round-tripped BFF output. Unknown variants
  // (e.g. `catalog_release_digest`) are intentionally not accepted.
  const digest =
    value.release_digest ??
    value.evaluated_release_digest ??
    value.evaluated_catalog_digest ??
    value.artifact_digest ??
    value.served_release_digest;
  if (typeof digest !== "string") {
    fail(what, "release_digest: expected a string");
  }
  if (!isRecord(value.case) && value.case !== undefined) {
    fail(what, `case: expected an object, received ${describe(value.case)}`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Endpoint map                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The decoder each endpoint must use.
 */
export const RESPONSE_DECODERS: Readonly<Record<string, (value: unknown) => unknown>> = Object.freeze({
  "/catalog": decodeCatalogPage,
  "/skills": decodeCatalogPage,
  "/releases": decodeReleasesPage,
  "/releases/compare": decodeReleaseComparison,
  "/projects": decodeProjectsList,
  "/workspace": decodeWorkspaceSummary,
  "/workspace/members": decodeMembersList,
  "/workspace/quotas": decodeWorkspaceQuotas,
  "/workspace/security/denies": decodeSecurityDenies,
  "/audit": decodeAuditList,
  "/analytics/usage": decodeUsageSummary,
  "/discovery": decodeDiscoveryInspection,
});

/**
 * Find the response decoder for any path, matching exact paths and parameterized routes.
 */
export function findResponseDecoder(path: string): ((value: unknown) => unknown) | undefined {
  const cleanPath = path.split("?")[0] ?? path;
  if (cleanPath in RESPONSE_DECODERS) {
    return RESPONSE_DECODERS[cleanPath as keyof typeof RESPONSE_DECODERS];
  }
  if (cleanPath.startsWith("/skills/") && cleanPath !== "/skills") {
    if (cleanPath.endsWith("/content")) {
      return decodeSkillContent;
    }
    return decodeSkillDetail;
  }
  if (cleanPath.startsWith("/releases/") && cleanPath !== "/releases" && cleanPath !== "/releases/compare") {
    return decodeReleaseDetail;
  }
  if (cleanPath.startsWith("/projects/") && cleanPath !== "/projects") {
    return decodeProjectDetail;
  }
  return undefined;
}

/** Whether a path has a declared decoder. */
export function hasResponseDecoder(path: string): boolean {
  return findResponseDecoder(path) !== undefined;
}
