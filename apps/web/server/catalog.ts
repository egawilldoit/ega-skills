/**
 * Authoritative catalog enumeration for the console.
 *
 * ## MCP `search` is NOT the catalog
 *
 * This module never imports `@ega-skills/mcp`, never calls the hosted MCP
 * handler, and never calls `runSearchTool`. MCP `search` requires a non-empty
 * query and caps at 20 results (`packages/mcp/src/search.ts`,
 * `SEARCH_LIMIT_MAX`): it is an agent discovery tool, not an enumeration API. A
 * console that paginates an enumeration over a tool capped at 20 results can
 * only ever show the first 20 of whatever the ranking preferred.
 *
 * Instead, enumeration is driven from the release's own authoritative
 * `skill_id -> version_hash` map (`release.payload.skill_versions`) through
 * Builder 2a's reader (`./registry.ts`). The reader is driven by that map, not
 * by whatever rows the SQLite file happens to contain, and it throws rather
 * than returning a short list.
 *
 * ## Routing facets come from `manifest_json.routing`, never from FTS
 *
 * The FTS `domains`/`platforms`/`frameworks`/`triggers`/`aliases` columns are a
 * **lossy search projection**: `serializeFtsArray`
 * (`packages/project/src/hub/release-state.ts:376-377`) newline-joins the
 * values into one indexed text blob, so a consumer must re-split a string to
 * recover an array and cannot distinguish a value containing a newline from two
 * values. `anti_triggers` has no column at all in either FTS table and is
 * deliberately not indexed.
 *
 * In the shipped 114-skill artifact that projection is also nearly empty:
 * 7/114 skills carry a domain, 1/114 a platform, 1/114 a framework. Filters
 * built from it look broken. Every facet here is therefore derived from
 * `skill_versions.manifest_json -> routing`, the same source
 * `runInspectTool` (`packages/mcp/src/inspect.ts:458-465`) reads.
 *
 * The text filter (`q`) is a case-insensitive substring match over already
 * loaded metadata, not an FTS `MATCH`. That is deliberate: it keeps the module
 * free of any dependence on the projection, keeps a browser-supplied string
 * out of SQL entirely (it never reaches SQLite at all), and cannot fail with an
 * `fts5: syntax error` on unbalanced quotes. Relevance ranking is not offered;
 * ranked search remains the MCP tool's job.
 *
 * ## Fail closed, never a partial catalog
 *
 * A catalog that silently omits one skill out of 114 is indistinguishable from a
 * complete catalog to an operator, which is the exact failure this console
 * exists to prevent. Three refusals, none of them downgradable:
 *
 * 1. `assertCatalogServable(config)` runs before anything is read, so a
 *    `mismatch` identity, an unverifiable artifact, or a malformed expected
 *    digest throws. There is no "serve rows with a warning banner" path.
 * 2. A released skill with no row becomes `E_WEB_CATALOG_INCOMPLETE`, naming
 *    the skill. The reader's `E_WEB_SKILL_MISSING` is translated rather than
 *    swallowed, so the refusal is still a catalog-level fact.
 * 3. A row count that does not equal the release map's own length becomes the
 *    same error, naming the first missing skill. This also catches a release
 *    larger than `MAX_RESULT_ROWS`, which would otherwise be silently truncated.
 *
 * A released version that cannot produce a coherent metadata row (no `SKILL.md`
 * blob, no recorded L2 token count, a manifest whose routing block or file list
 * is not the shape the canonical schema guarantees) is refused for the same
 * reason. Absent *data* is modelled as an explicit `null` plus a reason string,
 * never as a zero, an empty array, or a coerced value.
 *
 * ## Honest about what the release does not contain
 *
 * The shipped artifact genuinely has `l1_status: MISSING` for all 114 skills
 * (there are no `core`-role files, so L1 content does not exist), `trust_level:
 * UNKNOWN` for all 114, and `skill_sources.source_type: local` for all 114 with
 * no repository or commit sha. So `l1_tokens` is `null` for all 114 rather than
 * `0`, `provenance_status` is `local-only`, and the facets show how few skills
 * carry each value. These are reported, not smoothed over.
 *
 * ## Relationship to `apps/web/src/api/contracts.ts`
 *
 * `CatalogPage extends CatalogSummary` and `CatalogSkillRow extends
 * `SkillSummary` rather than redeclaring them. Every field the shared DTOs
 * declare is present here with the declared type, so both are assignable to the
 * contract and an existing consumer keeps compiling; the fields the brief
 * requires for a catalog row (namespace, version hash, frameworks, platforms,
 * L1 status, token counts, provenance) are *additive*. That was the only
 * reconciliation available without editing `apps/web/src/**`, which this slice
 * does not own. If the DTOs are widened later, these extensions can be deleted
 * without changing any payload.
 *
 * ## `workspace_id`
 *
 * The verified artifact is hub-scoped, not workspace-scoped: nothing in the
 * release names a workspace. Rather than invent one, `workspace_id` echoes
 * `options.workspace_id` when the route supplies the caller's session
 * workspace, and otherwise carries the documented sentinel
 * {@link CATALOG_UNSCOPED_WORKSPACE_ID}.
 *
 * ## No bodies, ever
 *
 * Rows carry metadata only. File roles, paths and byte sizes are not emitted
 * and no blob is ever read: the catalog module has no content path at all, so
 * there is nothing to leak. `content_digest` is the declared SHA-256 of
 * `SKILL.md`, which the contract defines as part of the summary.
 *
 * ## Determinism
 *
 * Filtering, sorting, faceting and pagination all happen server-side over
 * already loaded, bounded metadata (`MAX_RESULT_ROWS`), and every ordering
 * comparison uses code-unit string comparison, never `localeCompare`, so the
 * same release yields the same page on any host. Every sort is total: the
 * comparator always breaks ties on `skill_id`, so pages cannot duplicate or
 * drop a row.
 */

import type { CatalogSummary, ReleaseIdentity, SkillSummary } from "../src/api/contracts.ts";

import type { ServerConfig } from "./env.ts";
import { assertCatalogServable } from "./release-identity.ts";
import {
  MAX_CHILD_ROWS,
  MAX_RESULT_ROWS,
  RegistryReadError,
  getRegistry,
  type RegistryReader,
  type ReleasedSkillRow,
} from "./registry.ts";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Largest page this endpoint will assemble.
 *
 * The catalog is 114 rows today, but the ceiling is what stops a future release
 * from turning one request into an unbounded response. It is deliberately far
 * below `MAX_RESULT_ROWS`, which bounds the *read*; this bounds what is
 * serialized.
 */
export const CATALOG_MAX_LIMIT = 200;

/** Page size when the caller asks for none. */
export const CATALOG_DEFAULT_LIMIT = 50;

/**
 * Largest accepted `offset`.
 *
 * A real offset can never exceed the release size, which is itself bounded by
 * `MAX_RESULT_ROWS`; this bound exists so a nonsense offset is rejected
 * deterministically instead of silently yielding an empty page.
 */
export const CATALOG_MAX_OFFSET = 10_000;

/** Longest accepted `q`, after trimming. */
export const CATALOG_MAX_QUERY_LENGTH = 200;

/** Longest accepted filter value. Facet values are short identifiers. */
export const CATALOG_MAX_FILTER_LENGTH = 128;

/** Longest accepted `workspace_id` echo. */
export const CATALOG_MAX_WORKSPACE_ID_LENGTH = 128;

/**
 * Descriptions are truncated in the list payload.
 *
 * The longest description in the shipped release is 1018 characters
 * (`anthropic/claude-api`). A list view must not ship a kilobyte of prose per
 * row, so descriptions are cut here and `description_truncated` says so rather
 * than letting the UI believe it is showing the whole thing.
 */
export const CATALOG_DESCRIPTION_MAX_LENGTH = 280;

/**
 * `workspace_id` when the caller names none.
 *
 * A sentinel, not a fabricated identifier: it says the catalog was read from a
 * hub-scoped release artifact that names no workspace.
 */
export const CATALOG_UNSCOPED_WORKSPACE_ID = "unscoped-release";

/* -------------------------------------------------------------------------- */
/* Sort                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of sortable keys.
 *
 * An unknown key is an error, never a silent fallback to `skill_id`: a caller
 * asking for `sort=l1_token` has a bug, and quietly returning an arbitrary
 * order would hide it.
 */
export const CATALOG_SORT_KEYS = [
  "skill_id",
  "name",
  "namespace",
  "domain",
  "framework",
  "l1_status",
  "l1_tokens",
  "l2_tokens",
  "source_type",
  "trust_level",
] as const;

export type CatalogSortKey = (typeof CATALOG_SORT_KEYS)[number];

/** Direction of a sort. `-key` in the request means descending. */
export type CatalogSortDirection = "asc" | "desc";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A catalog read that cannot be served honestly.
 *
 * `code` is a stable machine identifier a route maps to `status`. The message
 * names the rule that was broken or the skill at fault and carries no SQL text,
 * no stack trace, and no filesystem path.
 */
export class CatalogError extends Error {
  readonly code: string;
  /** Suggested HTTP status for a route that surfaces this error. */
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Result shapes                                                               */
/* -------------------------------------------------------------------------- */

/** One facet value and how many skills in the current result set carry it. */
export interface CatalogFacetValue {
  readonly value: string;
  readonly skill_count: number;
}

/**
 * Facet values with real counts.
 *
 * Counts are computed over the filtered result set *before* pagination, so the
 * UI can show what a filter would yield without a second request. They are
 * counts of the release's genuine contents: in the shipped artifact `domains`
 * has 7 values covering 7 skills, which is the truth and is shown as such.
 */
export interface CatalogFacets {
  readonly namespaces: readonly CatalogFacetValue[];
  readonly domains: readonly CatalogFacetValue[];
  readonly frameworks: readonly CatalogFacetValue[];
  readonly platforms: readonly CatalogFacetValue[];
  readonly triggers: readonly CatalogFacetValue[];
  readonly aliases: readonly CatalogFacetValue[];
  /** `skill_sources.source_type` values, e.g. `local`. */
  readonly sources: readonly CatalogFacetValue[];
  readonly l1_statuses: readonly CatalogFacetValue[];
  readonly trust_levels: readonly CatalogFacetValue[];
}

/**
 * Whether a skill's content traces to a pinned repository revision.
 *
 * `repository-pinned` requires a source row carrying both a repository and a
 * commit sha. The shipped release has neither, so all 114 skills are
 * `local-only`, and that is reported rather than presented as provenance.
 */
export type CatalogProvenanceStatus = "repository-pinned" | "local-only" | "unknown";

/**
 * One skill in the catalog list view: metadata only, never a body.
 *
 * Extends the shared `SkillSummary` (all of whose fields are present
 * unchanged) with the routing, token and provenance metadata a catalog row has
 * to carry. See the module header for why this is an extension.
 */
export interface CatalogSkillRow extends SkillSummary {
  readonly namespace: string;
  /** The `version_hash` the release pins for this skill. */
  readonly version_hash: string;
  readonly frameworks: readonly string[];
  readonly platforms: readonly string[];
  /** Routing aliases, read from the manifest like every other facet. */
  readonly aliases: readonly string[];
  /** Present only here; no FTS table indexes it. */
  readonly anti_triggers: readonly string[];
  /** True when `description` was cut to `CATALOG_DESCRIPTION_MAX_LENGTH`. */
  readonly description_truncated: boolean;
  readonly l1_status: "AUTHORED" | "MISSING";
  readonly l2_size_class: "NORMAL" | "LARGE" | "OVERSIZED";
  /** `null` when no L1 was authored. Never `0`. */
  readonly l1_tokens: number | null;
  readonly l2_tokens: number;
  /** The estimator the recorded counts were produced by. */
  readonly token_estimator_id: string;
  readonly trust_level: "OWNED" | "EXTERNAL" | "UNKNOWN";
  /** `null` only when the released version has no source observation. */
  readonly source_type: string | null;
  readonly provenance_status: CatalogProvenanceStatus;
  readonly source_repository: string | null;
  readonly source_commit_sha: string | null;
  /** Non-null exactly when `source_type` is `null`. */
  readonly source_unavailable_reason: string | null;
}

/** The filters actually applied, echoed so a UI can render its own state. */
export interface CatalogAppliedFilters {
  readonly q: string | null;
  readonly namespace: string | null;
  readonly domain: string | null;
  readonly framework: string | null;
  readonly source: string | null;
  readonly l1: string | null;
}

/**
 * One bounded page of the catalog.
 *
 * `skill_total` (inherited from `CatalogSummary`) is the release-wide skill
 * count; `total` is how many skills matched the filters before pagination.
 * `release` is never `null` here: an unservable release throws rather than
 * returning a null identity with a reason, so `release_unavailable_reason` is
 * structurally always `null`.
 */
export interface CatalogPage extends CatalogSummary {
  readonly skills: readonly CatalogSkillRow[];
  /** Matches for these filters, before `limit`/`offset`. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sort: CatalogSortKey;
  readonly sort_direction: CatalogSortDirection;
  readonly applied_filters: CatalogAppliedFilters;
  readonly facets: CatalogFacets;
}

/* -------------------------------------------------------------------------- */
/* Request options                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Filters, sort and bounded pagination.
 *
 * Every field is validated before the database is touched, so a malformed
 * request is rejected deterministically without opening a handle or running a
 * query.
 */
export interface CatalogOptions {
  /** Case-insensitive substring match over already loaded metadata. */
  readonly q?: string;
  /** Exact match on `skills.namespace`. */
  readonly namespace?: string;
  /** Exact match on a `manifest_json.routing.domains` value. */
  readonly domain?: string;
  /** Exact match on a `manifest_json.routing.frameworks` value. */
  readonly framework?: string;
  /** Exact match on `skill_sources.source_type`. */
  readonly source?: string;
  /** Exact match on `skill_versions.l1_status`. */
  readonly l1?: string;
  /** A {@link CATALOG_SORT_KEYS} key, optionally `-`-prefixed for descending. */
  readonly sort?: string;
  /** 1..{@link CATALOG_MAX_LIMIT}. */
  readonly limit?: number;
  /** 0..{@link CATALOG_MAX_OFFSET}. */
  readonly offset?: number;
  /** Echoed into `CatalogSummary.workspace_id`; never invented. */
  readonly workspace_id?: string;
}

/* -------------------------------------------------------------------------- */
/* Validation — all of it runs before any read                                 */
/* -------------------------------------------------------------------------- */

/**
 * Control characters are never a legitimate facet value or query.
 *
 * Written as explicit escapes so the source stays readable. Rejects C0 controls
 * and DEL only: Unicode spaces and non-ASCII text are legitimate in descriptions
 * and facet values, so they are allowed.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate one bounded, trimmed string option.
 *
 * A blank value is a rejection rather than an implicit "no filter": it means
 * the caller built the request wrong, and guessing which filter they meant is
 * worse than saying so.
 */
function boundedText(value: unknown, field: string, max: number, code: string): string {
  if (typeof value !== "string") {
    throw new CatalogError(code, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new CatalogError(code, `${field} must not be empty or whitespace-only`);
  }
  if (trimmed.length > max) {
    throw new CatalogError(code, `${field} must be at most ${max} characters`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new CatalogError(code, `${field} must not contain control characters`);
  }
  return trimmed;
}

/** Optional variant: `undefined` means "not supplied". */
function optionalText(
  value: unknown,
  field: string,
  max: number,
  code: string,
): string | null {
  if (value === undefined) return null;
  return boundedText(value, field, max, code);
}

/** `limit`: a positive safe integer within the explicit page ceiling. */
function validateLimit(value: unknown): number {
  if (value === undefined) return CATALOG_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CatalogError(
      "E_WEB_CATALOG_INVALID_LIMIT",
      `limit must be a safe integer between 1 and ${CATALOG_MAX_LIMIT}`,
    );
  }
  if (value < 1 || value > CATALOG_MAX_LIMIT) {
    throw new CatalogError(
      "E_WEB_CATALOG_INVALID_LIMIT",
      `limit must be between 1 and ${CATALOG_MAX_LIMIT}`,
    );
  }
  return value;
}

/** `offset`: a non-negative safe integer within the explicit bound. */
function validateOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CatalogError(
      "E_WEB_CATALOG_INVALID_OFFSET",
      `offset must be a safe integer between 0 and ${CATALOG_MAX_OFFSET}`,
    );
  }
  if (value < 0 || value > CATALOG_MAX_OFFSET) {
    throw new CatalogError(
      "E_WEB_CATALOG_INVALID_OFFSET",
      `offset must be between 0 and ${CATALOG_MAX_OFFSET}`,
    );
  }
  return value;
}

/** `sort`: a closed allow-list, with an optional `-` direction prefix. */
function validateSort(value: unknown): { key: CatalogSortKey; direction: CatalogSortDirection } {
  if (value === undefined) return { key: "skill_id", direction: "asc" };
  if (typeof value !== "string") {
    throw new CatalogError("E_WEB_CATALOG_INVALID_SORT", "sort must be a string");
  }
  const trimmed = value.trim();
  const descending = trimmed.startsWith("-");
  const key = descending ? trimmed.slice(1) : trimmed;
  const allowed: readonly string[] = CATALOG_SORT_KEYS;
  if (!allowed.includes(key)) {
    throw new CatalogError(
      "E_WEB_CATALOG_INVALID_SORT",
      `sort must be one of ${allowed.join(", ")}, optionally prefixed with "-" for descending`,
    );
  }
  return { key: key as CatalogSortKey, direction: descending ? "desc" : "asc" };
}

/** Everything validated, so the read path never re-checks. */
interface ValidatedOptions {
  readonly q: string | null;
  readonly qFolded: string | null;
  readonly namespace: string | null;
  readonly domain: string | null;
  readonly framework: string | null;
  readonly source: string | null;
  readonly l1: string | null;
  readonly sortKey: CatalogSortKey;
  readonly sortDirection: CatalogSortDirection;
  readonly limit: number;
  readonly offset: number;
  readonly workspaceId: string;
}

function validateOptions(options: CatalogOptions): ValidatedOptions {
  // Widened so a route that forwards an unparsed query object as `null` is a
  // typed refusal rather than a property read on null.
  const given: unknown = options;
  if (given === null || typeof given !== "object") {
    throw new CatalogError("E_WEB_CATALOG_INVALID_OPTIONS", "catalog options must be an object");
  }
  const q = optionalText(options.q, "q", CATALOG_MAX_QUERY_LENGTH, "E_WEB_CATALOG_INVALID_QUERY");
  const { key, direction } = validateSort(options.sort);
  const workspaceId =
    options.workspace_id === undefined
      ? CATALOG_UNSCOPED_WORKSPACE_ID
      : boundedText(
          options.workspace_id,
          "workspace_id",
          CATALOG_MAX_WORKSPACE_ID_LENGTH,
          "E_WEB_CATALOG_INVALID_WORKSPACE",
        );
  return {
    q,
    qFolded: q === null ? null : q.toLowerCase(),
    namespace: optionalText(options.namespace, "namespace", CATALOG_MAX_FILTER_LENGTH, "E_WEB_CATALOG_INVALID_FILTER"),
    domain: optionalText(options.domain, "domain", CATALOG_MAX_FILTER_LENGTH, "E_WEB_CATALOG_INVALID_FILTER"),
    framework: optionalText(options.framework, "framework", CATALOG_MAX_FILTER_LENGTH, "E_WEB_CATALOG_INVALID_FILTER"),
    source: optionalText(options.source, "source", CATALOG_MAX_FILTER_LENGTH, "E_WEB_CATALOG_INVALID_FILTER"),
    l1: optionalText(options.l1, "l1", CATALOG_MAX_FILTER_LENGTH, "E_WEB_CATALOG_INVALID_FILTER"),
    sortKey: key,
    sortDirection: direction,
    limit: validateLimit(options.limit),
    offset: validateOffset(options.offset),
    workspaceId,
  };
}

/* -------------------------------------------------------------------------- */
/* Manifest reading                                                            */
/* -------------------------------------------------------------------------- */

/** The six routing facets, all read from `manifest_json.routing`. */
interface RoutingFacets {
  readonly aliases: readonly string[];
  readonly anti_triggers: readonly string[];
  readonly domains: readonly string[];
  readonly frameworks: readonly string[];
  readonly platforms: readonly string[];
  readonly triggers: readonly string[];
}

const ROUTING_FACETS = [
  "aliases",
  "anti_triggers",
  "domains",
  "frameworks",
  "platforms",
  "triggers",
] as const;

/** The file roles whose blob hash matters for a catalog row. */
const L1_ROLE = "core";
const L2_ROLE = "skill-body";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Fail closed on a released version whose recorded metadata cannot be read.
 *
 * Deliberately not recoverable: a released version is supposed to be complete,
 * so a manifest that is not the shape the canonical schema guarantees means the
 * catalog cannot be presented as complete.
 */
function incomplete(skillId: string, detail: string): CatalogError {
  return new CatalogError(
    "E_WEB_CATALOG_INCOMPLETE",
    `The verified release declares ${skillId}, but its recorded metadata cannot be read: ${detail} Refusing to present a partial catalog.`,
    503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one routing facet.
 *
 * A missing or wrongly typed facet is a refusal, not an empty array: reporting
 * "no domains" for a manifest whose routing block could not be read would be a
 * fabricated absence, and the whole point of the sparse-facet reporting here is
 * that an empty facet means empty.
 */
function readFacet(routing: Record<string, unknown>, key: string, skillId: string): readonly string[] {
  const raw = routing[key];
  if (!Array.isArray(raw)) {
    throw incomplete(skillId, `manifest_json.routing.${key} is not an array`);
  }
  for (const value of raw) {
    if (typeof value !== "string" || value === "") {
      throw incomplete(skillId, `manifest_json.routing.${key} contains a non-string value`);
    }
  }
  return Object.freeze([...(raw as readonly string[])]);
}

/** Read all six routing facets from the manifest, never from an FTS column. */
function readRouting(manifest: Record<string, unknown>, skillId: string): RoutingFacets {
  const routing = manifest["routing"];
  if (!isRecord(routing)) {
    throw incomplete(skillId, "manifest_json.routing is not an object");
  }
  const values: Record<string, readonly string[]> = {};
  for (const key of ROUTING_FACETS) values[key] = readFacet(routing, key, skillId);
  return Object.freeze({
    aliases: values["aliases"] ?? [],
    anti_triggers: values["anti_triggers"] ?? [],
    domains: values["domains"] ?? [],
    frameworks: values["frameworks"] ?? [],
    platforms: values["platforms"] ?? [],
    triggers: values["triggers"] ?? [],
  });
}

/** First blob hash for a role, or `null` when the version has no such file. */
function blobForRole(files: readonly unknown[], role: string): string | null {
  for (const entry of files) {
    if (!isRecord(entry)) continue;
    if (entry["role"] !== role) continue;
    const blob = entry["blob_hash"];
    return typeof blob === "string" && DIGEST_RE.test(blob) ? blob : null;
  }
  return null;
}

/** Trim, then truncate with an explicit marker. Never silently shortened. */
function truncateDescription(raw: string): { text: string; truncated: boolean } {
  const trimmed = raw.replace(/\s+$/u, "");
  if (trimmed.length <= CATALOG_DESCRIPTION_MAX_LENGTH) {
    return { text: trimmed, truncated: false };
  }
  return {
    text: `${trimmed.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH)}…`,
    truncated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Row assembly                                                                */
/* -------------------------------------------------------------------------- */

/** The token facts one catalog row carries. */
interface TokenCounts {
  /** `null` when no L1 was authored. Never `0`. */
  readonly l1Tokens: number | null;
  readonly l2Tokens: number;
  readonly estimatorId: string;
}

/**
 * Read the recorded token counts for one released version.
 *
 * `l1_tokens` follows `runInspectTool` exactly
 * (`packages/mcp/src/inspect.ts:415-419`): a count exists only when L1 was
 * authored *and* a `core`-role blob exists. There are no `core`-role files in
 * the shipped release, so every skill reports `null` — the honest value, and
 * not a zero that would read as a measurement.
 *
 * A missing L2 count is different in kind: `SKILL.md` is required and its count
 * is always persisted at import, so its absence means the recorded version is
 * not fully available. That refuses rather than reporting `0`, mirroring
 * `McpContextError("E_VERSION_NOT_FOUND", ...)` in the inspect tool.
 */
function readTokens(reader: RegistryReader, skillId: string, l1Status: string): TokenCounts {
  const byRole = new Map<string, number>();
  let estimatorId: string | null = null;
  for (const row of reader.listReleasedSkillTokens(skillId, { limit: MAX_CHILD_ROWS })) {
    if (estimatorId !== null && row.estimator_id !== estimatorId) {
      throw incomplete(skillId, "recorded token counts disagree about the estimator id");
    }
    estimatorId = row.estimator_id;
    if (!Number.isSafeInteger(row.token_count) || row.token_count < 0) {
      throw incomplete(skillId, "a recorded token count is not a non-negative integer");
    }
    // First count for a role wins, matching `l1BlobHash`/`l2BlobHash`, which
    // return the first matching file rather than accumulating.
    if (!byRole.has(row.role)) byRole.set(row.role, row.token_count);
  }
  const l2Tokens = byRole.get(L2_ROLE);
  if (l2Tokens === undefined) {
    throw incomplete(skillId, "no recorded L2 token count for its SKILL.md");
  }
  const l1Tokens = l1Status === "AUTHORED" ? (byRole.get(L1_ROLE) ?? null) : null;
  return {
    l1Tokens,
    l2Tokens,
    // Unreachable while the L2 check above holds, but reported as a value
    // rather than assumed, so the row never claims an estimator it did not read.
    estimatorId: estimatorId ?? "none-recorded",
  };
}

/** Provenance facts for one released version, from `skill_sources` only. */
function readProvenance(
  reader: RegistryReader,
  skillId: string,
): {
  sourceType: string | null;
  provenanceStatus: CatalogProvenanceStatus;
  repository: string | null;
  commitSha: string | null;
  unavailableReason: string | null;
} {
  const sources = reader.listReleasedSkillSources(skillId, { limit: MAX_CHILD_ROWS });
  if (sources.length === 0) {
    return {
      sourceType: null,
      provenanceStatus: "unknown",
      repository: null,
      commitSha: null,
      unavailableReason:
        "No source observation is recorded for this released skill version.",
    };
  }
  const first = sources[0];
  const sourceType = first?.source_type ?? null;
  if (sourceType === null) {
    throw incomplete(skillId, "a source observation has no source_type");
  }
  // Rows are ordered by source_id, so the first row carrying both fields is the
  // deterministic choice rather than whichever happened to be scanned last.
  let repository: string | null = null;
  let commitSha: string | null = null;
  for (const source of sources) {
    if (source.repository !== null && source.commit_sha !== null) {
      repository = source.repository;
      commitSha = source.commit_sha;
      break;
    }
  }
  return {
    sourceType,
    provenanceStatus: repository === null ? "local-only" : "repository-pinned",
    repository,
    commitSha,
    unavailableReason: null,
  };
}

/**
 * Build one catalog row from one released version.
 *
 * Returns `null` only if the skill is not in the release, which cannot happen
 * for a row this function is called with.
 */
function buildRow(reader: RegistryReader, released: ReleasedSkillRow): CatalogSkillRow {
  const skillId = released.skill_id;
  const manifest = released.manifest;

  if (manifest["skill_id"] !== skillId) {
    throw incomplete(skillId, "manifest_json.skill_id does not match the row");
  }

  const routing = readRouting(manifest, skillId);

  const portable = manifest["portable"];
  if (!isRecord(portable)) {
    throw incomplete(skillId, "manifest_json.portable is not an object");
  }
  const manifestName = portable["name"];
  if (typeof manifestName !== "string" || manifestName !== released.name) {
    throw incomplete(skillId, "manifest_json.portable.name does not match the registry name");
  }
  const rawDescription = portable["description"];
  if (typeof rawDescription !== "string") {
    throw incomplete(skillId, "manifest_json.portable.description is not a string");
  }
  const description = truncateDescription(rawDescription);

  const schemaVersion = manifest["schema_version"];
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw incomplete(skillId, "manifest_json.schema_version is not a positive integer");
  }

  const files = manifest["files"];
  if (!Array.isArray(files)) {
    throw incomplete(skillId, "manifest_json.files is not an array");
  }
  const contentDigest = blobForRole(files, L2_ROLE);
  if (contentDigest === null) {
    throw incomplete(skillId, "manifest_json.files has no skill-body blob for SKILL.md");
  }

  const tokens = readTokens(reader, skillId, released.l1_status);
  const provenance = readProvenance(reader, skillId);

  return Object.freeze({
    skill_id: skillId,
    name: released.name,
    description: description.text,
    domains: routing.domains,
    triggers: routing.triggers,
    schema_version: schemaVersion,
    content_digest: contentDigest,
    namespace: released.namespace,
    version_hash: released.version_hash,
    frameworks: routing.frameworks,
    platforms: routing.platforms,
    aliases: routing.aliases,
    anti_triggers: routing.anti_triggers,
    description_truncated: description.truncated,
    l1_status: released.l1_status,
    l2_size_class: released.l2_size_class,
    l1_tokens: tokens.l1Tokens,
    l2_tokens: tokens.l2Tokens,
    token_estimator_id: tokens.estimatorId,
    trust_level: released.trust_level,
    source_type: provenance.sourceType,
    provenance_status: provenance.provenanceStatus,
    source_repository: provenance.repository,
    source_commit_sha: provenance.commitSha,
    source_unavailable_reason: provenance.unavailableReason,
  });
}

/* -------------------------------------------------------------------------- */
/* Enumeration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read every released skill, failing closed if the result is not the release.
 *
 * Two independent checks, because they fail for different reasons:
 * `listReleasedSkills` throws `E_WEB_SKILL_MISSING` naming the skill when a
 * released version has no row, and the count comparison catches a release too
 * large for `MAX_RESULT_ROWS`, which would otherwise be truncated silently and
 * look like a complete catalog.
 */
function readAllReleasedSkills(reader: RegistryReader): readonly ReleasedSkillRow[] {
  const declared = reader.listReleasedSkillIds();
  let rows: readonly ReleasedSkillRow[];
  try {
    rows = reader.listReleasedSkills({ limit: MAX_RESULT_ROWS });
  } catch (error) {
    if (error instanceof RegistryReadError && error.code === "E_WEB_SKILL_MISSING") {
      // Translate, do not swallow: the refusal is a catalog-level fact and the
      // operator needs the skill id, which the reader's message already carries.
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        error.message,
        503,
      );
    }
    throw error;
  }
  if (rows.length !== declared.length) {
    const present = new Set(rows.map((row) => row.skill_id));
    const firstMissing = declared.find((id) => !present.has(id)) ?? "unknown";
    throw new CatalogError(
      "E_WEB_CATALOG_INCOMPLETE",
      `The verified release declares ${declared.length} skills but only ${rows.length} could be read; ${firstMissing} is missing. Refusing to present a partial catalog.`,
      503,
    );
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Filtering, sorting, faceting                                                */
/* -------------------------------------------------------------------------- */

/** Code-unit comparison. Never `localeCompare`: its result is host-dependent. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** First value of a facet, or `""` so a skill with none sorts consistently. */
function firstOrEmpty(values: readonly string[]): string {
  return values.length === 0 ? "" : (values[0] as string);
}

/** Sort key extractor. Every key is total, and `skill_id` breaks all ties. */
function sortValue(row: CatalogSkillRow, key: CatalogSortKey): string | number | null {
  switch (key) {
    case "skill_id":
      return row.skill_id;
    case "name":
      return row.name;
    case "namespace":
      return row.namespace;
    case "domain":
      return firstOrEmpty(row.domains);
    case "framework":
      return firstOrEmpty(row.frameworks);
    case "l1_status":
      return row.l1_status;
    case "l1_tokens":
      return row.l1_tokens;
    case "l2_tokens":
      return row.l2_tokens;
    case "source_type":
      // A skill with no source observation sorts with the empty key rather than
      // being dropped, so no row can vanish from a sort.
      return row.source_type ?? "";
    case "trust_level":
      return row.trust_level;
  }
}

/**
 * Compare two rows for one sort key and direction.
 *
 * A `null` numeric key (an un-authored L1) always sorts last, in both
 * directions: "no value" is not a small value, and flipping it to the front on
 * a descending sort would read as a measurement.
 */
function compareRows(
  a: CatalogSkillRow,
  b: CatalogSkillRow,
  key: CatalogSortKey,
  direction: CatalogSortDirection,
): number {
  const left = sortValue(a, key);
  const right = sortValue(b, key);
  if (left === null || right === null) {
    if (left === null && right === null) return compareText(a.skill_id, b.skill_id);
    return left === null ? 1 : -1;
  }
  const primary =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : compareText(String(left), String(right));
  if (primary !== 0) return direction === "asc" ? primary : -primary;
  // Total order: without this a page boundary could repeat or skip a row.
  return compareText(a.skill_id, b.skill_id);
}

/**
 * Everything `q` matches against: identity, name, description, and every
 * routing facet, folded to lower case once per row.
 *
 * Folded at the row rather than per comparison so a query costs one substring
 * scan over pre-folded text instead of re-lowercasing the row for every filter.
 */
function searchableText(row: CatalogSkillRow): string {
  return [
    row.skill_id,
    row.name,
    row.namespace,
    row.description,
    ...row.domains,
    ...row.frameworks,
    ...row.platforms,
    ...row.triggers,
    ...row.aliases,
    ...row.anti_triggers,
  ]
    .join("\n")
    .toLowerCase();
}

/** Exact facet membership. A value absent from a skill never matches. */
function hasValue(values: readonly string[], wanted: string | null): boolean {
  if (wanted === null) return true;
  return values.some((value) => value === wanted);
}

function matches(row: CatalogSkillRow, options: ValidatedOptions, folded: string): boolean {
  if (options.namespace !== null && row.namespace !== options.namespace) return false;
  if (options.domain !== null && !hasValue(row.domains, options.domain)) return false;
  if (options.framework !== null && !hasValue(row.frameworks, options.framework)) return false;
  if (options.source !== null && (row.source_type ?? "") !== options.source) return false;
  if (options.l1 !== null && row.l1_status !== options.l1) return false;
  if (options.qFolded !== null && !folded.includes(options.qFolded)) return false;
  return true;
}

/** Count one facet over the filtered rows, sorted by count then value. */
function facetOf(rows: readonly CatalogSkillRow[], values: (row: CatalogSkillRow) => readonly string[]): readonly CatalogFacetValue[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    // A skill carrying the same value twice in one facet still counts once.
    for (const value of new Set(values(row))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return Object.freeze(
    [...counts.entries()]
      .map(([value, skillCount]) => Object.freeze({ value, skill_count: skillCount }))
      .sort((a, b) => b.skill_count - a.skill_count || compareText(a.value, b.value)),
  );
}

function scalarFacet(rows: readonly CatalogSkillRow[], values: (row: CatalogSkillRow) => string | null): readonly CatalogFacetValue[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = values(row);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.freeze(
    [...counts.entries()]
      .map(([value, skillCount]) => Object.freeze({ value, skill_count: skillCount }))
      .sort((a, b) => b.skill_count - a.skill_count || compareText(a.value, b.value)),
  );
}

function buildFacets(rows: readonly CatalogSkillRow[]): CatalogFacets {
  return Object.freeze({
    namespaces: scalarFacet(rows, (row) => row.namespace),
    domains: facetOf(rows, (row) => row.domains),
    frameworks: facetOf(rows, (row) => row.frameworks),
    platforms: facetOf(rows, (row) => row.platforms),
    triggers: facetOf(rows, (row) => row.triggers),
    aliases: facetOf(rows, (row) => row.aliases),
    sources: scalarFacet(rows, (row) => row.source_type),
    l1_statuses: scalarFacet(rows, (row) => row.l1_status),
    trust_levels: scalarFacet(rows, (row) => row.trust_level),
  });
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the catalog page from an already verified reader and identity.
 *
 * The reader-scoped core, split out so `getCatalog`'s guard ordering is visible
 * in one place and so a test can exercise the completeness refusal on a
 * deliberately impossible snapshot. Production goes through
 * {@link getCatalog}; nothing here reads `process.env`.
 */
export function buildCatalogPage(
  reader: RegistryReader,
  identity: ReleaseIdentity,
  options: CatalogOptions = {},
): CatalogPage {
  const validated = validateOptions(options);
  const released = readAllReleasedSkills(reader);

  const rows: CatalogSkillRow[] = [];
  for (const row of released) rows.push(buildRow(reader, row));

  const matched = rows.filter((row) => matches(row, validated, searchableText(row)));

  matched.sort((a, b) => compareRows(a, b, validated.sortKey, validated.sortDirection));

  const total = matched.length;
  const page = matched.slice(validated.offset, validated.offset + validated.limit);

  // Facet counts describe the whole filtered set, not the page, so the UI can
  // show what another value would yield without a second request.
  const facets = buildFacets(matched);
  const domainTotal = buildFacets(rows).domains.length;

  return Object.freeze({
    workspace_id: validated.workspaceId,
    hub_id: identity.hub_id,
    release: identity,
    release_unavailable_reason: null,
    skill_total: identity.skill_count,
    domain_total: domainTotal,
    generated_at: new Date().toISOString(),
    skills: Object.freeze(page),
    total,
    limit: validated.limit,
    offset: validated.offset,
    sort: validated.sortKey,
    sort_direction: validated.sortDirection,
    applied_filters: Object.freeze({
      q: validated.q,
      namespace: validated.namespace,
      domain: validated.domain,
      framework: validated.framework,
      source: validated.source,
      l1: validated.l1,
    }),
    facets,
  });
}

/**
 * The catalog entry point.
 *
 * Order matters and is the point of this function:
 *
 * 1. Validate every option. A malformed request is rejected before a database
 *    handle is opened, so it costs nothing and never depends on artifact state.
 * 2. `assertCatalogServable(config)`. On `mismatch`, an unverifiable artifact, or
 *    a malformed expected digest this throws. It is never caught here and never
 *    downgraded to a warning: serving catalog rows under a stale identity is
 *    the prohibited failure.
 * 3. `getRegistry(config)`, which re-asserts the same guard before opening a
 *    read-only handle, so the identity checked and the rows read can never come
 *    from different evaluations.
 * 4. Build the page from that reader and that identity.
 */
export function getCatalog(
  config?: Readonly<ServerConfig>,
  options: CatalogOptions = {},
): CatalogPage {
  const identity = assertCatalogServable(config);
  const reader = getRegistry(config);
  return buildCatalogPage(reader, identity, options);
}