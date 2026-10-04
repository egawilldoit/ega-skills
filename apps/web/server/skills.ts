/**
 * Skill detail and on-demand skill content.
 *
 * ## Metadata on the catalog route, bodies on the content route
 *
 * `getSkillDetail` returns identity, version, routing, token counts, provenance
 * and release identity — and **no instruction body, ever**. The routing block it
 * reports comes from the verified release's canonical manifest, read through
 * `runInspectTool`, for the structural reason the architecture settles in §6.1:
 * `anti_triggers` has no column in either FTS table and 44 of the 114 released
 * skills carry it, so it is unreachable through the search projection.
 *
 * `getSkillContent` is the only function here that returns content, and it is
 * only ever reached when a caller asks for it. `apps/web/server/catalog.ts` has
 * no content path at all; this module has no path that returns a body without an
 * explicit `level` (or `file_path`) request.
 *
 * ## Two reused tools, not two reimplementations
 *
 * | Need | Reused | Why reuse is the requirement |
 * |---|---|---|
 * | skill metadata | `runInspectTool` (`packages/mcp/src/inspect.ts:306`) | It already produces the exact join of manifest routing, source ordering, token metadata, trust level and provenance, with `openReadOnlyRegistry` (`query_only`) and an exact-version lookup that never falls forward. |
 * | skill content | `runGetContentTool` (`packages/mcp/src/get-content.ts:352`) | See below. |
 *
 * `runGetContentTool`'s guarantees are **load-bearing security properties, not
 * incidental behaviour**, and this module weakens none of them:
 *
 * - exact manifest-path string equality for `file_path` — no normalization, no
 *   glob, no directory access, so a traversal shape can never equal a canonical
 *   manifest path and falls through to "unknown path";
 * - refusal of `FORBIDDEN_FILE_ROLES` = `skill-body`, `core`, `ega-metadata`,
 *   `script`, `asset` (`get-content.ts:246-252`);
 * - refusal of BINARY content;
 * - blob reads through the hash-verified `getCacheBlob`, so bytes are verified
 *   before any content is exposed;
 * - `level` accepts only `L1` or `L2`;
 * - a per-call `max_tokens` bound, where over budget is an error and never a
 *   truncation.
 *
 * There is deliberately **no second content path here**: no `fs.readFile`, no
 * `getCacheBlob` call of our own, no alternative role check. The artifact control
 * files (`hub-release.json`, `release-package.json`, `candidate.json`,
 * `token-artifact.json`, `alias-map.json`, `search-index-input.json`,
 * `release-diff.json`, `publication-preflight.json`) are not manifest entries, so
 * exact manifest-path equality makes them unreachable by construction.
 *
 * ## The two contexts, and why they are not interchangeable
 *
 * - The **release identity** context (`./release-identity.ts`) decides whether
 *   anything may be served at all. `assertCatalogServable` runs before any read
 *   and throws on `mismatch` or an unverifiable artifact. It is never
 *   downgraded to a warning.
 * - The **project** context is `snapshot.context` from that same verified
 *   snapshot (`packages/mcp/src/hosted.ts:157-169`): `UNLOCKED`, no project
 *   policy allow/deny list populated, `registryHome` = the artifact directory.
 *   It is handed to the two tools unchanged. This module never constructs,
 *   relaxes or overrides a project context, so it cannot manufacture its own
 *   authorization.
 *
 * Both come from one `getReleaseIdentityBinding(config)` evaluation, and the
 * config is resolved once so the identity check and the snapshot a payload is
 * built from can never come from two different evaluations of the environment.
 *
 * ## Honesty about what this deployment does not have
 *
 * Three real conditions in the shipped 114-skill release are reported, not
 * smoothed over:
 *
 * 1. **`l1_status` is `MISSING` for all 114 skills.** There are no `core`-role
 *    files in the artifact, so `SKILL.core.md` was never authored and L1 content
 *    genuinely does not exist. A request for L1 returns the deterministic
 *    missing-level error (`E_WEB_CONTENT_LEVEL_MISSING`, HTTP 409) — never an
 *    empty string, a zero-token stub, or a fabricated body.
 * 2. **No historical versions are retained.** `skill_versions` holds exactly one
 *    row per skill in this release, and the schema has no timestamp column at
 *    all. `getSkillDetail` reads that fact and reports `history.state =
 *    "not-retained"` with a reason; `history.versions` is empty. Nothing is
 *    inferred, reconstructed, or back-dated.
 * 3. **No adopted source revision.** `skill_sources.source_type` is `local` for
 *    all 114 with `repository` and `commit_sha` null, so `SkillDetail.sources`
 *    is empty and `sources_unavailable_reason` says why. The real source
 *    *observation* (type, local path, observed instant) is still carried, in
 *    `source_observations`, because suppressing it would hide a fact the release
 *    does record. `SkillSourceRef.revision` is never synthesised from a local
 *    path or a branch name.
 * 4. **`skill_files` is a superset of the canonical manifest, by design.**
 *    The registry holds 869 file rows; the manifests declare 796 files. The 73
 *    extra rows are all `ega-metadata` role `ega.yaml`, which the canonical
 *    manifest excludes. `detail.files` therefore reports the manifest's list —
 *    the set `runGetContentTool` matches `file_path` against — and the two
 *    sources are cross-checked as a containment with identical digests, not as
 *    an equality. See {@link assertManifestFilesPresent}.
 *
 * ## `SkillDetail` and its widening
 *
 * `SkillDetailView extends SkillDetail`. Every field the shared DTO declares is
 * present with the declared type and name — nothing renamed, nothing retyped —
 * so a `SkillDetailView` is assignable to `SkillDetail` and an existing consumer
 * keeps compiling. The extra fields are *additive*, and they are additive because
 * the shared DTO cannot express what the brief requires:
 *
 * - `SkillRouting` declares `exclude_patterns` and `priority`, but the canonical
 *   manifest's routing block has exactly six fields — `domains`, `platforms`,
 *   `frameworks`, `triggers`, `anti_triggers`, `aliases`
 *   (`packages/hashing/src/manifest.ts:132-138`). Neither key exists anywhere in
 *   `packages/**`. They are reported as `[]` and `null` (the DTO's own declared
 *   "absent" representation for `priority`) with
 *   `routing.unavailable_fields_reason` naming why, so an empty value can never
 *   be read as "checked and found none".
 * - `SkillDetail` has no history field, no content-availability field, and no
 *   trust level, and the routing it declares cannot carry `anti_triggers` or
 *   `aliases`.
 *
 * This is the same reconciliation `catalog.ts` documented for
 * `CatalogPage`/`CatalogSkillRow`, and it was the only one available without
 * editing `apps/web/src/**`, which this slice does not own.
 *
 * ## Error mapping and message sanitization
 *
 * `SkillReadError` carries a `status`, so a route builder needs no mapping
 * logic. Upstream messages are **never** forwarded: `getCacheBlob`'s
 * `E_CACHE_HASH_MISMATCH` text embeds the absolute cache path, and
 * `get-content.ts`/`inspect.ts` messages are MCP tool messages written for a
 * different client. Every message here is composed from values already
 * validated as canonical (skill id, version digest, level) plus numeric counts,
 * so no SQL, no stack trace, and no absolute filesystem path can appear.
 *
 * ## `parseCanonicalSkillId` comes from `@ega-skills/registry`
 *
 * The canonical-ID rule is frozen in `@ega-skills/schema`
 * (`packages/schema/src/index.ts:343`), but `apps/web/server` may only import
 * `@ega-skills/mcp`, `@ega-skills/project` and `@ega-skills/registry` — the
 * allow-list in `tests/web/project-boundary.test.mjs:231-242` — and
 * `@ega-skills/schema` is not a dependency of `apps/web` at all. `@ega-skills/
 * registry` re-exports both the parser and its error class verbatim
 * (`packages/registry/src/index.ts:69`), so the same frozen function is imported
 * from an allowed package with no reimplementation and no new dependency.
 */

import {
  GET_CONTENT_MAX_TOKENS_MAX,
  GET_CONTENT_MAX_TOKENS_MIN,
  McpContextError,
  runGetContentTool,
  runInspectTool,
  type GetContentLevel,
  type HostedReleaseSnapshot,
  type McpInspectOutput,
} from "@ega-skills/mcp";
import { parseCanonicalSkillId, SchemaValidationError } from "@ega-skills/registry";

import type {
  ReleaseIdentity,
  SkillDetail,
  SkillFileRef,
  SkillRouting,
  SkillSourceRef,
  SkillSummary,
} from "../src/api/contracts.ts";

import { loadServerConfig, type ServerConfig } from "./env.ts";
import {
  MAX_CHILD_ROWS,
  RegistryReadError,
  getRegistry,
  type RegistryReader,
} from "./registry.ts";
import { assertCatalogServable, getReleaseIdentityBinding } from "./release-identity.ts";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `max_tokens` applied when a request names none.
 *
 * The largest recorded L2 body in the shipped release is 21,623 `ega-o200k-v1`
 * tokens (`anthropic/claude-api`), so this default serves every released skill
 * with real headroom while staying far below the tool's own ceiling. A future
 * release with a larger skill does not silently truncate: it produces the
 * explicit over-budget error, which is the correct outcome.
 */
export const SKILL_CONTENT_DEFAULT_MAX_TOKENS = 32_000;

/**
 * Longest accepted `file_path`.
 *
 * Manifest paths in the shipped release are short; this bounds the request, not
 * the release. A path that is not an exact manifest entry is refused by the
 * tool regardless of its length.
 */
export const SKILL_CONTENT_MAX_PATH_LENGTH = 512;

/**
 * Longest accepted `skill_id`.
 *
 * `parseCanonicalSkillId` already bounds both halves at 64 characters plus one
 * separator. This ceiling exists so an oversized string is refused with a
 * sanitized message instead of reaching the schema validator.
 */
export const SKILL_ID_MAX_LENGTH = 129;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A skill read that cannot be served honestly.
 *
 * `code` is a stable machine identifier and `status` is the HTTP status a route
 * should use, so no mapping logic is needed downstream. `detail` names the rule
 * that broke or the skill at fault and carries no SQL, no stack trace, and no
 * filesystem path.
 */
export class SkillReadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SkillReadError";
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Result shapes                                                               */
/* -------------------------------------------------------------------------- */

/** Content levels this endpoint serves. Exactly the tool's own two. */
export const SKILL_CONTENT_LEVELS = ["L1", "L2"] as const;
export type SkillContentLevel = GetContentLevel;

/**
 * Router-visible routing, widened from the shared {@link SkillRouting}.
 *
 * Every field the DTO declares is present unchanged. `exclude_patterns` is
 * always `[]` and `priority` always `null` because the canonical manifest has no
 * such keys at all — see the module header — and
 * {@link SkillRoutingView.unavailable_fields_reason} says so, so neither value
 * can be mistaken for "read and found none".
 */
export interface SkillRoutingView extends SkillRouting {
  readonly frameworks: readonly string[];
  readonly platforms: readonly string[];
  readonly anti_triggers: readonly string[];
  readonly aliases: readonly string[];
  /** Non-null exactly when `exclude_patterns`/`priority` are structurally absent. */
  readonly unavailable_fields_reason: string | null;
}

/**
 * One real `skill_sources` observation, as `runInspectTool` reports it.
 *
 * Carried separately from `SkillSourceRef` because the shipped release records
 * an observation (type, local path, observed instant) without recording a
 * revision, and dropping the observation would hide a real fact.
 */
export interface SkillSourceObservation {
  readonly source_type: "local" | "git";
  readonly local_path: string | null;
  readonly repository: string | null;
  readonly commit_sha: string | null;
  readonly repository_path: string | null;
  readonly observed_at: string;
}

/** Whether a level can be retrieved on demand, and why not when it cannot. */
export interface SkillContentAvailability {
  /** Always `on-demand`: this deployment serves no body in a metadata payload. */
  readonly retrieval: "on-demand";
  readonly l1_status: "AUTHORED" | "MISSING";
  /** True only when the release really contains a `core`-role blob. */
  readonly l1_available: boolean;
  /** Non-null exactly when `l1_available` is false. */
  readonly l1_unavailable_reason: string | null;
  readonly l2_available: boolean;
  readonly l2_tokens: number;
  readonly l2_size_class: "NORMAL" | "LARGE" | "OVERSIZED";
  readonly token_estimator_id: string;
}

/** One historical version. Never synthesised; see the module header. */
export interface SkillVersionEntry {
  readonly version_hash: string;
  readonly l1_status: "AUTHORED" | "MISSING";
  readonly trust_level: "OWNED" | "EXTERNAL" | "UNKNOWN";
}

/**
 * A skill's version history, or an explicit statement that none is retained.
 *
 * `state` is `"not-retained"` when this deployment records no version other than
 * the one the release pins, and then `versions` is empty and `reason` is
 * non-null. Nothing else is ever populated: there is no code path that invents
 * a timeline, and the `skill_versions` schema carries no timestamp column, so
 * there is no real date to report either.
 */
export interface SkillVersionHistory {
  readonly state: "retained" | "not-retained";
  /** The version the verified release pins. Never part of `versions`. */
  readonly released_version_hash: string;
  /** Historical versions only. Empty in the shipped release, by fact. */
  readonly versions: readonly SkillVersionEntry[];
  /** Non-null exactly when `state` is `"not-retained"`. */
  readonly reason: string | null;
}

/**
 * The full skill record for the detail route: every field of the shared
 * {@link SkillDetail} plus the routing, provenance, content-availability and
 * history facts the DTO cannot carry. Assignable to `SkillDetail`.
 */
export interface SkillDetailView extends SkillDetail {
  readonly routing: SkillRoutingView;
  /**
   * Always empty in the shipped release. `SkillSourceRef` describes an adopted
   * source *revision*, and no released skill has one; see
   * `sources_unavailable_reason`.
   */
  readonly sources: readonly SkillSourceRef[];
  readonly source_observations: readonly SkillSourceObservation[];
  /** Non-null exactly when `sources` is empty. */
  readonly sources_unavailable_reason: string | null;
  readonly files: readonly SkillFileRef[];
  readonly history: SkillVersionHistory;
  readonly trust_level: "OWNED" | "EXTERNAL" | "UNKNOWN";
  /**
   * The observed source revision — a commit sha, never a branch name. `null` for
   * all 114 released skills, which is why `sources` is empty.
   */
  readonly observed_source_revision: string | null;
  readonly source_repository: string | null;
  readonly source_commit_sha: string | null;
  readonly content: SkillContentAvailability;
}

/**
 * One skill body, returned only by an explicit content request.
 *
 * `truncated` is always `false`: an over-budget request is an error
 * (`E_WEB_CONTENT_TOKEN_BUDGET`), so a `true` here would mean this module had
 * silently shortened content, which it cannot.
 */
export interface SkillContentView {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly level: SkillContentLevel;
  readonly token_count: number;
  /** The exact canonical bytes, hash-verified before return. */
  readonly content: string;
  readonly requested_max_tokens: number;
  readonly truncated: false;
  /** Present only when the request named a companion path. */
  readonly file_path?: string;
  /** Release this body was read from. Never null: an unservable release throws. */
  readonly release: ReleaseIdentity;
}

/* -------------------------------------------------------------------------- */
/* Request options                                                             */
/* -------------------------------------------------------------------------- */

/** One on-demand content request. Every field is validated before any read. */
export interface SkillContentOptions {
  /** Canonical `<namespace>/<portable-name>`. */
  readonly skillId: string;
  /**
   * Exact version to read. Defaults to the version the verified release pins for
   * this skill. That default is the release's own authoritative pin — it is not
   * a fallback to `current_version_hash` and never a fall-forward. A version
   * this release does not pin is refused, not silently replaced.
   */
  readonly versionHash?: string;
  readonly level: SkillContentLevel;
  /** `1..GET_CONTENT_MAX_TOKENS_MAX`; defaults to {@link SKILL_CONTENT_DEFAULT_MAX_TOKENS}. */
  readonly maxTokens?: number;
  /** Exact manifest path. Requires `level: "L2"`; the tool enforces both. */
  readonly filePath?: string;
}

/* -------------------------------------------------------------------------- */
/* Validation — every rule here runs before the database is touched             */
/* -------------------------------------------------------------------------- */

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Control characters are never part of a canonical id or a manifest path.
 *
 * Written as explicit escapes so the source stays readable. Rejects C0 and DEL;
 * the canonical grammar allows no other character anyway, so this only produces
 * a clearer message.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a canonical skill id with the frozen schema parser.
 *
 * The parser is not a convenience here — it is the rule
 * `runInspectTool`/`runGetContentTool` apply, so validating before the read
 * makes this module's refusal identical to theirs instead of a second opinion
 * that could drift. SQL metacharacters, `..` segments, absolute paths, a
 * non-canonical shape and the empty string are all rejected by it, which is why
 * an invalid id never reaches SQLite.
 */
function validateSkillId(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillReadError("E_WEB_SKILL_ID_INVALID", "skillId must be a string");
  }
  if (value.length > SKILL_ID_MAX_LENGTH) {
    throw new SkillReadError(
      "E_WEB_SKILL_ID_INVALID",
      `skillId must be at most ${SKILL_ID_MAX_LENGTH} characters`,
    );
  }
  try {
    parseCanonicalSkillId(value);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      // The upstream message quotes only the grammar, never the input, so it is
      // safe to surface; the input itself is never echoed.
      throw new SkillReadError(
        "E_WEB_SKILL_ID_INVALID",
        `skillId must be a canonical <namespace>/<portable-name> identifier. ${error.message}`,
      );
    }
    throw error;
  }
  return value;
}

/** `level`: a closed two-value set, checked here and again by the tool. */
function validateLevel(value: unknown): SkillContentLevel {
  if (value !== "L1" && value !== "L2") {
    throw new SkillReadError(
      "E_WEB_CONTENT_LEVEL_INVALID",
      `level must be one of ${SKILL_CONTENT_LEVELS.join(", ")}`,
    );
  }
  return value;
}

/**
 * `max_tokens`: a safe integer inside the tool's own per-call bound.
 *
 * Checked here so `0`, a negative value, a non-integer and an over-ceiling value
 * are each refused by this module's code rather than relying on the tool's
 * identical check. Both use the same constants, so the two cannot disagree.
 */
function validateMaxTokens(value: unknown): number {
  if (value === undefined) return SKILL_CONTENT_DEFAULT_MAX_TOKENS;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SkillReadError(
      "E_WEB_CONTENT_MAX_TOKENS_INVALID",
      `maxTokens must be an integer between ${GET_CONTENT_MAX_TOKENS_MIN} and ${GET_CONTENT_MAX_TOKENS_MAX}`,
    );
  }
  if (value < GET_CONTENT_MAX_TOKENS_MIN || value > GET_CONTENT_MAX_TOKENS_MAX) {
    throw new SkillReadError(
      "E_WEB_CONTENT_MAX_TOKENS_INVALID",
      `maxTokens must be between ${GET_CONTENT_MAX_TOKENS_MIN} and ${GET_CONTENT_MAX_TOKENS_MAX}`,
    );
  }
  return value;
}

/** `filePath`: a bounded, control-character-free string when present. */
function validateFilePath(value: unknown, level: SkillContentLevel): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillReadError(
      "E_WEB_CONTENT_FILE_PATH_INVALID",
      "filePath must be a non-empty manifest path string when present",
    );
  }
  if (value.length > SKILL_CONTENT_MAX_PATH_LENGTH) {
    throw new SkillReadError(
      "E_WEB_CONTENT_FILE_PATH_INVALID",
      `filePath must be at most ${SKILL_CONTENT_MAX_PATH_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(value)) {
    throw new SkillReadError(
      "E_WEB_CONTENT_FILE_PATH_INVALID",
      "filePath must not contain control characters",
    );
  }
  if (level !== "L2") {
    throw new SkillReadError(
      "E_WEB_CONTENT_FILE_PATH_INVALID",
      "filePath requires level to be L2",
    );
  }
  return value;
}

/**
 * Version hash: a canonical digest that this release actually pins.
 *
 * A malformed digest is invalid input (400). A well-formed digest for a version
 * this release does not pin is a version that is not in the release (404), which
 * is a different fact from a malformed request.
 */
function resolveVersionHash(released: string | null, requested: unknown): string {
  if (requested === undefined) {
    if (released === null) {
      throw new SkillReadError(
        "E_WEB_SKILL_NOT_RELEASED",
        "The requested skill is not part of the verified release.",
        404,
      );
    }
    return released;
  }
  if (typeof requested !== "string" || !DIGEST_RE.test(requested)) {
    throw new SkillReadError(
      "E_WEB_CONTENT_VERSION_INVALID",
      `versionHash must match sha256:<64 lowercase hex characters>`,
    );
  }
  if (released === null || requested !== released) {
    throw new SkillReadError(
      "E_WEB_SKILL_VERSION_NOT_RELEASED",
      "This deployment serves exactly the version the verified release pins for a skill, and that version is not the one requested.",
      404,
    );
  }
  return requested;
}

/* -------------------------------------------------------------------------- */
/* Release membership                                                          */
/* -------------------------------------------------------------------------- */

/** Released version hash, or the 404 refusal when the skill is not released. */
function requireReleased(reader: RegistryReader, skillId: string): string {
  const versionHash = reader.releasedVersionHash(skillId);
  if (versionHash === null) {
    throw new SkillReadError(
      "E_WEB_SKILL_NOT_RELEASED",
      `The requested skill is not part of the verified release: ${skillId}`,
      404,
    );
  }
  return versionHash;
}

/* -------------------------------------------------------------------------- */
/* MCP error mapping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Per-code refusals from the reused tools.
 *
 * Each entry is the console's own code, its HTTP status, and whether the
 * upstream message may be shown. It may not: `getCacheBlob` builds its
 * `E_CACHE_HASH_MISMATCH` text with the absolute cache path interpolated into it,
 * so passing any upstream message through would put a filesystem path in an
 * operator-facing error. Every message is composed instead.
 *
 * Statuses:
 * - `409` for a level that genuinely does not exist in a readable resource. The
 *   skill is present and readable, so `404` would be a false statement about
 *   existence; the request conflicts with the resource's actual state.
 * - `400` for the caller's own budget being too small for real content, and for
 *   a file the request may not have. Both are fixed by changing the request,
 *   and the resource is fine.
 * - `503` for anything that means this deployment cannot answer: a blob that
 *   fails hash verification, an unreadable registry, a context-level refusal.
 */
function refuse(code: string, status: number, skillId: string, level: SkillContentLevel): SkillReadError {
  const messages: Record<string, string> = {
    E_WEB_CONTENT_LEVEL_MISSING: `${skillId} has no ${level} content in the released version. Its l1_status is recorded as MISSING, so no L1 was ever authored; nothing is returned in place of a body.`,
    E_WEB_CONTENT_TOKEN_BUDGET: `The ${level} content of ${skillId} exceeds the requested max_tokens budget. Content is never truncated; request a larger budget.`,
    E_WEB_CONTENT_FILE_FORBIDDEN: `That file of ${skillId} is never served through content retrieval (instruction bodies, metadata, scripts and assets are refused).`,
    E_WEB_CONTENT_FILE_UNKNOWN: `${skillId} has no retrievable file at that path. Paths must match a manifest entry exactly.`,
    E_WEB_CONTENT_REQUEST_INVALID: `The content request is not a valid get_content input for ${skillId}.`,
    E_WEB_CONTENT_INTEGRITY: `The stored blob for ${skillId} failed hash verification, so no content is returned.`,
    E_WEB_CONTENT_UNAVAILABLE: `Content for ${skillId} cannot be served from this deployment right now.`,
    E_WEB_SKILL_VERSION_NOT_RELEASED: `This deployment serves exactly the version the verified release pins for ${skillId}, and that version is not the one requested.`,
  };
  return new SkillReadError(code, messages[code] ?? `Content for ${skillId} cannot be served from this deployment right now.`, status);
}

/**
 * Translate one thrown tool error into a {@link SkillReadError}.
 *
 * Unknown codes fail closed as `503` rather than becoming a `500` that carries
 * an upstream message. No branch forwards `error.message`.
 */
function translateToolError(
  error: unknown,
  skillId: string,
  level: SkillContentLevel,
): SkillReadError {
  const code = error instanceof McpContextError ? error.code : "";
  switch (code) {
    case "E_CONTENT_LEVEL_MISSING":
      return refuse("E_WEB_CONTENT_LEVEL_MISSING", 409, skillId, level);
    case "E_CONTENT_TOKEN_BUDGET":
      return refuse("E_WEB_CONTENT_TOKEN_BUDGET", 400, skillId, level);
    case "E_CONTENT_FILE_FORBIDDEN":
      return refuse("E_WEB_CONTENT_FILE_FORBIDDEN", 400, skillId, level);
    case "E_CONTENT_FILE_UNKNOWN":
      return refuse("E_WEB_CONTENT_FILE_UNKNOWN", 400, skillId, level);
    case "E_MCP_INPUT_INVALID":
      // Unreachable: every input rule is validated above with the same
      // constants. It is mapped rather than left to the default so that if it
      // ever fires, the cause is "our validation and the tool's diverged", which
      // is a bug to fix rather than a user error to render.
      return refuse("E_WEB_CONTENT_REQUEST_INVALID", 400, skillId, level);
    case "E_VERSION_NOT_FOUND":
      return refuse("E_WEB_SKILL_VERSION_NOT_RELEASED", 404, skillId, level);
    case "E_CACHE_HASH_MISMATCH":
      return refuse("E_WEB_CONTENT_INTEGRITY", 503, skillId, level);
    case "E_REGISTRY_UNAVAILABLE":
    case "E_SKILL_NOT_FOUND":
    case "E_PROJECT_LOCK_INVALID":
    case "E_VERSION_NOT_LOCKED":
      return refuse("E_WEB_CONTENT_UNAVAILABLE", 503, skillId, level);
    default:
      return refuse("E_WEB_CONTENT_UNAVAILABLE", 503, skillId, level);
  }
}

/* -------------------------------------------------------------------------- */
/* Detail assembly                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The one routing block the DTO declares but the canonical manifest cannot
 * supply.
 *
 * Stated once so the reason travels with the payload instead of being implied by
 * an empty array and a `null`.
 */
const ROUTING_ABSENT_FIELDS_REASON =
  "exclude_patterns and priority are not fields of the canonical version manifest (it declares exactly domains, platforms, frameworks, triggers, anti_triggers and aliases), and no release artifact carries them. They are absent, not empty.";

/** `core`-role blob hash from a released manifest, or `null` when unauthored. */
function coreBlobHash(inspect: McpInspectOutput): string | null {
  for (const file of inspect.manifest.files) {
    if (file.role === "core") return file.blob_hash;
  }
  return null;
}

/** `skill-body` blob hash, i.e. `SKILL.md`. Required, so its absence refuses. */
function skillBodyBlobHash(inspect: McpInspectOutput, skillId: string): string {
  for (const file of inspect.manifest.files) {
    if (file.role === "skill-body") return file.blob_hash;
  }
  throw new SkillReadError(
    "E_WEB_SKILL_METADATA_UNAVAILABLE",
    `The released manifest for ${skillId} declares no SKILL.md blob, so its content digest cannot be reported.`,
    503,
  );
}

/**
 * Refuse when the registry's file rows and the inspected manifest disagree.
 *
 * The two are independent reads of the same released version, and
 * `verifyReleaseProjection` already checks file identities during snapshot
 * verification, so a manifest entry with no matching registry row — or a
 * disagreeing digest — means the bytes changed between verification and this
 * read. That is the same condition `./release-identity.ts` refuses for
 * `release-package.json`.
 *
 * The relationship is **containment, not equality**, and that is measured, not
 * assumed. In the shipped release `skill_files` holds 869 rows while the
 * canonical manifests declare 796 files: the 73 extra rows are all
 * `ega-metadata` role `ega.yaml`, which `skill_files` records and the canonical
 * manifest deliberately excludes — the manifests declare exactly `other`,
 * `skill-body`, `script`, `asset` and `reference`, never `ega-metadata` and never
 * `core`. So the manifest is checked to be a subset of the registry rows with
 * identical digests, and the reverse containment is not demanded.
 *
 * A useful second-order consequence, verified in the tests: `ega.yaml` is
 * unreachable through `runGetContentTool` twice over. It is a forbidden role, and
 * it is not a manifest entry, so exact manifest-path equality refuses it before
 * the role check is reached.
 */
function assertManifestFilesPresent(
  skillId: string,
  fromRegistry: readonly { readonly path: string; readonly blob_hash: string }[],
  fromManifest: readonly { readonly path: string; readonly blob_hash: string }[],
): void {
  const byPath = new Map(fromRegistry.map((row) => [row.path, row.blob_hash] as const));
  for (const entry of fromManifest) {
    const recorded = byPath.get(entry.path);
    if (recorded === undefined) {
      throw new SkillReadError(
        "E_WEB_SKILL_METADATA_INCOHERENT",
        `The released manifest for ${skillId} declares a file the registry does not record, so no coherent detail can be presented.`,
        503,
      );
    }
    if (recorded !== entry.blob_hash) {
      throw new SkillReadError(
        "E_WEB_SKILL_METADATA_INCOHERENT",
        `The registry and the released manifest disagree about the content digest of one file of ${skillId}, so no coherent detail can be presented.`,
        503,
      );
    }
  }
}

/**
 * Version history, from the rows the registry actually records.
 *
 * The release's own `skill_versions` table is the only evidence available. When
 * it holds exactly the one version the release pins, that is reported as
 * "not retained" with the real count named. There is no branch that synthesises
 * an entry, and `skill_versions` has no timestamp column, so there is no date to
 * report either.
 */
function buildHistory(reader: RegistryReader, skillId: string, releasedVersionHash: string): SkillVersionHistory {
  const recorded = reader.listSkillVersions(skillId, { limit: MAX_CHILD_ROWS });
  const versions = recorded
    .filter((row) => row.version_hash !== releasedVersionHash)
    .map((row) =>
      Object.freeze({
        version_hash: row.version_hash,
        l1_status: row.l1_status,
        trust_level: row.trust_level,
      }),
    );
  if (versions.length === 0) {
    return Object.freeze({
      state: "not-retained" as const,
      released_version_hash: releasedVersionHash,
      versions: Object.freeze([]),
      reason:
        `This deployment retains no historical versions of ${skillId}. The verified release records ` +
        `${recorded.length} version row for this skill, which is the one version the release pins, and ` +
        `the release artifact carries no earlier revision to show. No timeline is inferred.`,
    });
  }
  return Object.freeze({
    state: "retained" as const,
    released_version_hash: releasedVersionHash,
    versions: Object.freeze(versions),
    reason: null,
  });
}

/** Build the detail payload from an already validated and released skill. */
function buildDetail(
  reader: RegistryReader,
  identity: ReleaseIdentity,
  snapshot: HostedReleaseSnapshot,
  skillId: string,
  versionHash: string,
): SkillDetailView {
  // 1. The metadata join. The exact released version is passed explicitly, so the
  //    tool performs an exact lookup and never resolves through
  //    `current_version_hash`.
  let inspect: McpInspectOutput;
  try {
    inspect = runInspectTool({ skill_id: skillId, version_hash: versionHash }, snapshot.context);
  } catch (error) {
    if (error instanceof RegistryReadError && error.code === "E_WEB_SKILL_NOT_RELEASED") {
      throw new SkillReadError(
        "E_WEB_SKILL_METADATA_UNAVAILABLE",
        `The verified release declares ${skillId} but the snapshot has no row for it, so no detail can be presented.`,
        503,
      );
    }
    const code = error instanceof McpContextError ? error.code : "";
    if (code === "E_REGISTRY_UNAVAILABLE" || code === "E_VERSION_NOT_FOUND") {
      throw new SkillReadError(
        "E_WEB_SKILL_METADATA_UNAVAILABLE",
        `The recorded metadata for ${skillId} cannot be read, so no detail can be presented.`,
        503,
      );
    }
    // Anything else — including a project-context denial, which this deployment
    // never issues — fails closed rather than surfacing an MCP tool message.
    throw new SkillReadError(
      "E_WEB_SKILL_METADATA_UNAVAILABLE",
      `The recorded metadata for ${skillId} cannot be read, so no detail can be presented.`,
      503,
    );
  }

  if (inspect.version_hash !== versionHash) {
    throw new SkillReadError(
      "E_WEB_SKILL_METADATA_INCOHERENT",
      `The inspected version for ${skillId} is not the version the verified release pins, so no coherent detail can be presented.`,
      503,
    );
  }

  const routing = inspect.manifest.routing;
  const l0 = inspect.l0;

  // 2. File list, taken from the CANONICAL MANIFEST rather than the registry's
  //    `skill_files` rows, and cross-checked against them.
  //
  //    The manifest is the right source because it is the same list
  //    `runGetContentTool` matches `file_path` against, so every path reported
  //    here is a path the content endpoint actually recognises. `skill_files`
  //    additionally records 73 `ega-metadata` `ega.yaml` rows that the canonical
  //    manifest deliberately excludes; those are EGA's own metadata, not released
  //    skill content, and listing them would advertise a path that can never be
  //    retrieved.
  const fileRows = reader.listReleasedSkillFiles(skillId, { limit: MAX_CHILD_ROWS });
  assertManifestFilesPresent(skillId, fileRows, inspect.manifest.files);
  const files = inspect.manifest.files
    .map((entry) =>
      Object.freeze({
        path: entry.path,
        byte_length: entry.byte_size,
        content_digest: entry.blob_hash,
      }),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const contentDigest = skillBodyBlobHash(inspect, skillId);
  const l1Available = coreBlobHash(inspect) !== null && l0.l1_status === "AUTHORED";

  const summary: SkillSummary = Object.freeze({
    skill_id: skillId,
    name: l0.name,
    namespace: l0.namespace,
    description: l0.description,
    domains: l0.domains,
    frameworks: l0.frameworks,
    platforms: l0.platforms,
    triggers: l0.triggers,
    version_hash: versionHash,
    l1_status: l0.l1_status,
    l1_tokens: inspect.token_metadata.l1_tokens,
    l2_tokens: inspect.token_metadata.l2_tokens,
    source_type: inspect.sources[0]?.source_type ?? null,
    provenance_status: inspect.sources.some((source) => source.commit_sha !== null)
      ? "repository-pinned"
      : inspect.sources.length === 0
        ? "unknown"
        : "local-only",
    schema_version: inspect.manifest.schema_version,
    content_digest: contentDigest,
  });

  // 3. Provenance. `SkillSourceRef.revision` is an adopted source revision; no
  //    released skill has one (commit_sha is null for all 114), so `sources` is
  //    empty with a stated reason rather than filled with a synthesised value.
  //    The real observations still travel in `source_observations`.
  const observations = inspect.sources.map((source) =>
    Object.freeze({
      source_type: source.source_type,
      local_path: source.local_path,
      repository: source.repository,
      commit_sha: source.commit_sha,
      repository_path: source.repository_path,
      observed_at: source.observed_at,
    }),
  );
  const pinned = inspect.sources.find((source) => source.commit_sha !== null) ?? null;

  const routingView: SkillRoutingView = Object.freeze({
    domains: routing.domains,
    triggers: routing.triggers,
    // Structurally absent from the canonical manifest. See the module header.
    exclude_patterns: Object.freeze([]),
    priority: null,
    unavailable_fields_reason: ROUTING_ABSENT_FIELDS_REASON,
    frameworks: routing.frameworks,
    platforms: routing.platforms,
    anti_triggers: routing.anti_triggers,
    aliases: routing.aliases,
  });

  return Object.freeze({
    summary,
    routing: routingView,
    sources: Object.freeze([]),
    source_observations: Object.freeze(observations),
    sources_unavailable_reason:
      observations.length === 0
        ? `No source observation is recorded for the released version of ${skillId}.`
        : `No adopted source revision is recorded for ${skillId} in this release: the ${observations.length} recorded source observation(s) carry no repository and no commit sha, so no revision can be reported. The observations themselves are in source_observations.`,
    files: Object.freeze(files),
    history: buildHistory(reader, skillId, versionHash),
    trust_level: inspect.trust_level,
    observed_source_revision: pinned?.commit_sha ?? null,
    source_repository: pinned?.repository ?? null,
    source_commit_sha: pinned?.commit_sha ?? null,
    content: Object.freeze({
      retrieval: "on-demand" as const,
      l1_status: l0.l1_status,
      l1_available: l1Available,
      l1_unavailable_reason: l1Available
        ? null
        : `The release records l1_status MISSING for ${skillId} and its manifest declares no core-role SKILL.core.md, so L1 content genuinely does not exist. A content request for L1 returns the missing-level error; no body, empty string or placeholder is returned instead.`,
      l2_available: true,
      l2_tokens: inspect.token_metadata.l2_tokens,
      l2_size_class: inspect.token_metadata.l2_size_class,
      token_estimator_id: inspect.token_metadata.estimator_id,
    }),
    release: identity,
  });
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The skill detail entry point.
 *
 * Order of operations, and why:
 *
 * 1. **Validate the skill id**, with the same frozen parser both reused tools
 *    apply. An invalid id is refused here, so a malformed, traversal-shaped or
 *    SQL-metacharacter-bearing id never reaches SQLite — and its error does not
 *    depend on artifact state. Same ordering rationale as
 *    `apps/web/server/catalog.ts`, which pins it with a test.
 * 2. **Resolve the config once.** With no argument the config is read from
 *    `process.env` exactly here, so the identity check and the snapshot the
 *    payload is built from come from a single evaluation of the environment
 *    rather than two independently constructed ones.
 * 3. **`assertCatalogServable(config)`.** Throws on `mismatch`, on an
 *    unverifiable artifact, and on a malformed expected digest. Never caught and
 *    never downgraded: serving skill metadata under a stale identity is the
 *    prohibited failure.
 * 4. **`getRegistry(config)`**, which re-asserts the same guard before opening a
 *    read-only handle, so the identity that was checked and the rows that are
 *    read cannot come from different evaluations.
 * 5. Release membership, then the metadata join through `runInspectTool`.
 */
export function getSkillDetail(
  config: Readonly<ServerConfig> | undefined,
  skillId: string,
): SkillDetailView {
  const id = validateSkillId(skillId);
  const resolved = config ?? loadServerConfig();
  const binding = getReleaseIdentityBinding(resolved);
  const identity = assertCatalogServable(resolved);
  const reader = getRegistry(resolved);
  const snapshot = binding.snapshot;
  if (snapshot === null) {
    // Unreachable while `assertCatalogServable` holds; a null snapshot here would
    // mean building a payload from an unverified release. Fail closed.
    throw new SkillReadError(
      "E_WEB_SKILL_METADATA_UNAVAILABLE",
      "No verified release snapshot is available to read skill metadata from.",
      503,
    );
  }
  const versionHash = requireReleased(reader, id);
  return buildDetail(reader, identity, snapshot, id, versionHash);
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read the tool's `structuredContent` with a closed check.
 *
 * `CallToolResult.structuredContent` is typed `unknown` by the protocol package,
 * so the exact success container is verified here rather than cast. A successful
 * result without a readable container is a contract break in this deployment,
 * not a user error.
 */
function readContentOutput(
  result: { readonly structuredContent?: unknown },
  skillId: string,
  level: SkillContentLevel,
): {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly level: GetContentLevel;
  readonly token_count: number;
  readonly content: string;
  readonly file_path?: string;
} {
  const raw: unknown = result.structuredContent;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw refuse("E_WEB_CONTENT_UNAVAILABLE", 503, skillId, level);
  }
  const record = raw as Record<string, unknown>;
  const content = record["content"];
  const tokenCount = record["token_count"];
  if (
    typeof record["skill_id"] !== "string" ||
    typeof record["version_hash"] !== "string" ||
    (record["level"] !== "L1" && record["level"] !== "L2") ||
    typeof content !== "string" ||
    typeof tokenCount !== "number" ||
    !Number.isSafeInteger(tokenCount)
  ) {
    throw refuse("E_WEB_CONTENT_UNAVAILABLE", 503, skillId, level);
  }
  const filePath = record["file_path"];
  if (filePath !== undefined && typeof filePath !== "string") {
    throw refuse("E_WEB_CONTENT_UNAVAILABLE", 503, skillId, level);
  }
  return {
    skill_id: record["skill_id"],
    version_hash: record["version_hash"],
    level: record["level"],
    token_count: tokenCount,
    content,
    ...(typeof filePath === "string" ? { file_path: filePath } : {}),
  };
}

/**
 * On-demand content: the only path in the console that returns a skill body.
 *
 * Everything is validated before the database is touched, then the whole read is
 * delegated to `runGetContentTool` with the verified snapshot's project context.
 * This function contributes no content logic of its own: no blob read, no role
 * check, no budget arithmetic, no truncation.
 *
 * The version is always the one the verified release pins. A `versionHash` that
 * is well-formed but not the pinned one is refused with `404` rather than
 * silently replaced, and `runGetContentTool` itself never falls forward.
 */
export function getSkillContent(
  config: Readonly<ServerConfig> | undefined,
  options: SkillContentOptions,
): SkillContentView {
  const given: unknown = options;
  if (given === null || typeof given !== "object") {
    throw new SkillReadError("E_WEB_CONTENT_REQUEST_INVALID", "content options must be an object");
  }
  const id = validateSkillId(options.skillId);
  const level = validateLevel(options.level);
  const maxTokens = validateMaxTokens(options.maxTokens);
  const filePath = validateFilePath(options.filePath, level);

  const resolved = config ?? loadServerConfig();
  const binding = getReleaseIdentityBinding(resolved);
  const identity = assertCatalogServable(resolved);
  const reader = getRegistry(resolved);
  const snapshot = binding.snapshot;
  if (snapshot === null) {
    throw new SkillReadError(
      "E_WEB_CONTENT_UNAVAILABLE",
      `Content for ${id} cannot be served from this deployment right now.`,
      503,
    );
  }

  const released = reader.releasedVersionHash(id);
  const versionHash = resolveVersionHash(released, options.versionHash);

  let result: { readonly structuredContent?: unknown };
  try {
    result = runGetContentTool(
      {
        skill_id: id,
        version_hash: versionHash,
        level,
        max_tokens: maxTokens,
        ...(filePath === null ? {} : { file_path: filePath }),
      },
      snapshot.context,
    );
  } catch (error) {
    throw translateToolError(error, id, level);
  }

  const output = readContentOutput(result, id, level);
  // The tool echoes its own inputs; if it ever disagreed with what was asked
  // for, the payload would misattribute a body. Refuse rather than relabel.
  if (output.skill_id !== id || output.version_hash !== versionHash || output.level !== level) {
    throw refuse("E_WEB_CONTENT_UNAVAILABLE", 503, id, level);
  }
  if (filePath !== null && output.file_path !== filePath) {
    throw refuse("E_WEB_CONTENT_UNAVAILABLE", 503, id, level);
  }

  return Object.freeze({
    skill_id: output.skill_id,
    version_hash: output.version_hash,
    level: output.level,
    token_count: output.token_count,
    content: output.content,
    requested_max_tokens: maxTokens,
    // Structurally impossible to be true: an over-budget request throws before
    // any content is returned.
    truncated: false as const,
    ...(output.file_path === undefined ? {} : { file_path: output.file_path }),
    release: identity,
  });
}

/**
 * The `max_tokens` bounds this endpoint enforces, re-exported from the frozen
 * tool so a route advertises exactly what it will accept.
 */
export { GET_CONTENT_MAX_TOKENS_MAX, GET_CONTENT_MAX_TOKENS_MIN };
