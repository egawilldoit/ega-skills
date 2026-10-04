/**
 * Release history, release detail, and release comparison.
 *
 * ## The honesty rule this module exists to enforce
 *
 * The console can only show a release history if something retained one. In
 * this repository **no retained manifest is committed** (verified: `find -name
 * '*retained*'` returns source + dist + test only), and no control-plane table
 * carries release history either. So the two honest outcomes are:
 *
 * 1. A retained manifest is configured. Then `getReleaseIdentityBinding(config)
 *    .retained` is a *fully verified* set: `loadRetainedReleaseSet` re-verifies
 *    every candidate, every package digest, the hub identity and each release
 *    digest before returning. Its `payload.releases[]`,
 *    `payload.publication_revision` and `payload.deployment_id` are real
 *    deployment facts and are reported as such.
 * 2. No retained manifest is configured. Then there is exactly **one**
 *    verifiable release — the artifact this deployment actually holds — and this
 *    module says so in words (`history_state: "single-verified-release"` plus a
 *    non-null `history_unavailable_reason`) instead of inventing a timeline.
 *
 * There is no third branch. Nothing here synthesises a release, a timestamp, a
 * publication revision, or a diff from incomplete metadata, because a fabricated
 * history is worse than an absent one: it is indistinguishable from a real one
 * to every reader downstream.
 *
 * ## No fallback, ever
 *
 * {@link resolveReleaseSnapshot} mirrors `resolveRetainedRelease`
 * (`packages/mcp/src/retained.ts:191-193`), which throws
 * `E_RELEASE_UNAVAILABLE` rather than substituting the default release. A digest
 * this deployment cannot verify is *unavailable*, and saying so is the whole
 * point. There is deliberately no code path that answers "unknown digest" with
 * the default release's contents.
 *
 * ## What the artifact does not contain (and is therefore not reported)
 *
 * These were verified against the committed `packages/mcp/artifact/`, not
 * assumed:
 *
 * - **No publication timestamp anywhere.** `grep -ohE '"[a-z_]*(at|time|date|
 *   published|created|updated)[a-z_]*"\s*:' packages/mcp/artifact/*.json`
 *   returns only `publication`, `publication_policy_revision`, `status`,
 *   `platforms`, `token_estimator`, `update_contract`, `expected_catalog_match`
 *   and the two `*_release_digest` fields — no date. `hub-release.json`'s
 *   payload is `adopted_sources`, `alias_map_digest`, `build`, `contracts`,
 *   `hub_id`, `search_index_input_digest`, `skill_versions`,
 *   `token_artifact_digest`. The retained manifest's `publication_revision` is a
 *   CAS version, not a clock reading.
 *   → `published_at` is `null` everywhere, with a reason, rather than a
 *   plausible-looking string.
 * - **No immutable-object metadata.** `immutable_objects` has zero writers
 *   anywhere in the repository, so `ReleaseArtifactRef.created_at` has no
 *   source. → `null`, with a reason. `byte_length` *is* real (it is measured
 *   from the verified files) and is reported.
 * - **No stable-pointer row.** `hub_stable_pointers` has no writer either, so
 *   `stable_pointer_updated_at` is `null` with a reason.
 *
 * `apps/web/src/api/contracts.ts` declares `published_at: string` and
 * `created_at: string` as non-nullable. Those declarations cannot be satisfied
 * without fabricating data, so every view here widens exactly those fields to
 * `string | null` via `Omit<..., "published_at">` and pairs each with an
 * explicit `*_unavailable_reason`. Widening through `Omit` rather than by
 * redeclaring the interface keeps the inheritance visible: a reader can see
 * precisely which DTO field is intentionally widened and why.
 *
 * ## Fail closed
 *
 * Every read here calls `assertCatalogServable(config)` first, exactly as
 * `getCatalog` and `getSkillDetail` do. On `mismatch`, on an unverifiable
 * artifact, or on a malformed expected digest, it throws — so no route can serve
 * a release under an identity the deployment does not vouch for. There is no
 * "render it with a warning banner" path.
 *
 * ## What reaches a response
 *
 * Never a secret, an absolute path, SQL text, or a stack trace. Concretely:
 * `HostedReleaseSnapshot.artifactDir` and `.sqlitePath` are absolute and are
 * read here but never copied into a view; `retained.artifact_path` is POSIX
 * *relative* and is safe to report; upstream failure text is passed through the
 * redactor that `release-identity.ts` already applies to identity failures.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  HostedRuntimeError,
  openReadOnlyRegistry,
  resolveRetainedRelease,
  type HostedReleaseSnapshot,
  type ReadOnlyRegistryHandle,
} from "@ega-skills/mcp";
import {
  HubError,
  createReleaseDiff,
  type ReleaseSkillUpdate,
} from "@ega-skills/project";

import type {
  ReleaseArtifactRef,
  ReleaseDiffView,
  ReleaseIdentity,
  ReleaseSummary,
} from "../src/api/contracts.ts";

import { CATALOG_UNSCOPED_WORKSPACE_ID } from "./catalog.ts";
import type { ServerConfig } from "./env.ts";
import { createRegistryReader } from "./registry.ts";
import {
  assertCatalogServable,
  getReleaseIdentityBinding,
  type ReleaseIdentityBinding,
  type ReleaseIdentityDependencies,
} from "./release-identity.ts";

/* -------------------------------------------------------------------------- */
/* Bounds and fixed sentences                                                   */
/* -------------------------------------------------------------------------- */

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Longest accepted release digest. Exactly the canonical form's length. */
export const RELEASE_DIGEST_MAX_LENGTH = 71;

/**
 * The exact sentence the console shows when a comparison names a release whose
 * artifact this deployment does not hold.
 *
 * It is a module constant rather than an inline literal so the HTTP route, the
 * test and the UI all quote the same string, and so a future change to the
 * wording is a single edit that cannot drift between the three.
 *
 * It is deliberately *not* phrased as "no differences". A side that could not be
 * read has no differences to report.
 */
export const RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE =
  "Historical artifact unavailable for full comparison.";

/**
 * Why the history list has exactly one row.
 *
 * Stated in full rather than hinted at, because "one release" and "a release
 * history of one release" are different claims and only the first is true here.
 */
export const RELEASES_NO_RETAINED_HISTORY_REASON =
  "This deployment configures no retained release manifest, so exactly one release is " +
  "verifiable: the artifact this console loads. No other release history is retained " +
  "anywhere it can be read from, and none is invented.";

/** Why `published_at` is absent. Same reason for every release and every view. */
export const RELEASES_NO_PUBLICATION_TIMESTAMP_REASON =
  "The release envelope and the retained manifest record no publication timestamp. " +
  "publication_revision is a monotonic CAS version, not a clock reading, so no date " +
  "is reported rather than one being derived.";

/** Why artifact `created_at` is absent. */
export const RELEASES_NO_IMMUTABLE_OBJECT_METADATA_REASON =
  "No immutable-object row is recorded for this release (immutable_objects has no " +
  "writer in this system), so there is no recorded creation time. byte_length and " +
  "object_digest are measured from the verified files and are real.";

/** Why `stable_pointer_updated_at` is absent. */
export const RELEASES_NO_STABLE_POINTER_REASON =
  "This console reads release artifacts, not the control-plane stable-pointer table, " +
  "and that table has no writer in this system, so there is no pointer timestamp to " +
  "report. is_stable reflects the verified release-identity binding instead.";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A release read that cannot be served honestly.
 *
 * `code` is a stable machine identifier and `status` is the HTTP status a route
 * should use, so no mapping table is needed downstream — the same contract
 * `CatalogError` and `SkillReadError` already provide. `message` names the rule
 * that broke or the digest that could not be resolved; it never carries SQL, a
 * stack trace, an absolute path, or a secret.
 */
export class ReleaseReadError extends Error {
  readonly code: string;
  /** Suggested HTTP status for a route that surfaces this error. */
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ReleaseReadError";
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Result shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where the release list's contents came from.
 *
 * - `retained-manifest`       — a verified retained set supplied the rows, so
 *                               `publication_revision` and `deployment_id` are real.
 * - `single-verified-release` — no manifest; the only verifiable release is the
 *                               artifact itself, and `history_unavailable_reason`
 *                               is non-null.
 */
export type ReleaseHistoryState = "retained-manifest" | "single-verified-release";

/**
 * One verified object backing half of a release.
 *
 * Widens `created_at` to `null` (see the module header) and adds two fields
 * that make the identity unambiguous:
 *
 * - `object_digest` is the digest *other parts of this system compare*: the
 *   semantic `HubRelease` envelope digest for `kind: "release"`, and the SQLite
 *   byte digest for `kind: "sqlite"`. Those are not the same kind of number, so
 *   `object_digest_kind` says which one it is rather than leaving a reader to
 *   assume.
 * - `byte_digest` is always the SHA-256 of the exact file bytes on disk. It is
 *   computed here and is therefore a measurement, not a declared value.
 */
export interface ReleaseArtifactView extends Omit<ReleaseArtifactRef, "created_at"> {
  readonly artifact_kind: "release" | "sqlite";
  readonly created_at: null;
  /** Non-null: `created_at` is always `null`, and this says why. */
  readonly created_at_unavailable_reason: string;
  /** Which digest `object_digest` is. */
  readonly object_digest_kind: "hub-release-envelope" | "sqlite-bytes";
  /** SHA-256 over the exact file bytes on disk. */
  readonly byte_digest: string;
  /** POSIX path relative to the artifact directory. Never absolute. */
  readonly artifact_file: string;
}

/** Row in the release list. Widens `published_at`; see the module header. */
export interface ReleaseSummaryView extends Omit<ReleaseSummary, "published_at"> {
  readonly published_at: null;
  readonly published_at_unavailable_reason: string;
  /**
   * True when this release is the one the deployment's authoritative pointer
   * resolves to — that is, `ReleaseIdentity.status === "stable"`.
   *
   * The DTO documents `is_stable` as "hub_stable_pointers currently points at
   * this digest". That table has no writer, so this binding is what the console
   * can actually observe; naming it here keeps the substitution visible.
   */
  readonly is_stable: boolean;
  /** How `is_stable` was decided. `null` never; it is always stated. */
  readonly is_stable_basis: string;
}

/** One adopted source revision recorded in the `HubRelease` envelope. */
export interface AdoptedSourceView {
  readonly source_id: string;
  /**
   * The revision the release adopted, resolved — a commit sha, never a branch
   * name. Present in the shipped envelope for every adopted source.
   */
  readonly resolved_commit: string;
  readonly selected_skill_tree_digest: string;
  readonly source_config_digest: string;
  readonly vendored_snapshot_digest: string;
}

/** Contract/build metadata the verified envelope carries. */
export interface ReleaseContractView {
  readonly build_contract: string;
  readonly hub_contract: string;
  readonly update_contract: string;
  readonly importer_build: number;
  readonly schema: string;
  readonly hashing: number;
  readonly router: number;
  readonly search: number;
  readonly token_estimator: string;
}

/**
 * Publication bookkeeping that the artifact really records.
 *
 * `candidate.json` and `publication-preflight.json` are verified artifacts: the
 * preflight digest and the approval-set digest are bound into the candidate's
 * `publication` block, and the retained manifest re-verifies the candidate digest
 * for every retained release. `preflight_blockers` is the real list — empty in
 * the shipped artifact, which is the truth and not an assumption.
 */
export interface ReleasePublicationView {
  readonly candidate_digest: string | null;
  readonly release_diff_digest: string | null;
  readonly preflight_digest: string | null;
  readonly approval_set_digest: string | null;
  readonly publication_policy_revision: string | null;
  readonly previous_release_digest: string | null;
  readonly preflight_blocker_count: number;
  readonly preflight_blockers: readonly string[];
  /** Non-null whenever any field above is `null`; names what is missing. */
  readonly unavailable_reason: string | null;
}

/**
 * Audit-visible information, and — equally important — the reason the rest of it
 * is not shown.
 *
 * `audit_events` has no writer anywhere in this repository, so this view reports
 * *no* audit trail. It says so rather than rendering an empty list that a reader
 * could mistake for "no audited activity".
 */
export interface ReleaseAuditView {
  /** Always empty: there is no audit record to read. */
  readonly events: readonly never[];
  readonly events_unavailable_reason: string;
  /** Real governance fact from the verified publication preflight. */
  readonly approval_count: number;
  readonly approval_decisions: readonly string[];
  readonly publication_policy_revision: string | null;
}

/** Everything the console can honestly show about one release. */
export interface ReleaseDetailView extends ReleaseSummaryView {
  readonly artifacts: readonly ReleaseArtifactView[];
  readonly stable_pointer_updated_at: null;
  readonly stable_pointer_unavailable_reason: string;
  readonly adopted_sources: readonly AdoptedSourceView[];
  readonly contracts: ReleaseContractView | null;
  readonly publication: ReleasePublicationView;
  readonly audit: ReleaseAuditView;
  readonly provenance: ReleaseProvenanceView;
  /** POSIX path below the manifest directory. `null` when not retained. */
  readonly retained_artifact_path: string | null;
  readonly retained: boolean;
  /** Retained manifest digests that bind this release. `null` when not retained. */
  readonly retained_candidate_digest: string | null;
  readonly retained_release_package_digest: string | null;
}

/**
 * Provenance summary.
 *
 * The two halves answer different questions and must not be conflated: the
 * envelope's `adopted_sources` records which *repository revision* the hub
 * adopted (and the shipped release has one), while the per-skill
 * `skill_sources` rows record how each skill was observed (and the shipped
 * release records `source_type: "local"` with no repository and no commit for
 * all 114). `adopted_sources` is non-empty while `repository_pinned_skills` is
 * 0 in that release, and both numbers are reported so the discrepancy is visible
 * instead of being smoothed over.
 *
 * The three per-skill counts are `null` — never `0` — when they could not be
 * read, so a count that failed is not rendered as a measurement.
 */
export interface ReleaseProvenanceView {
  /** Hub-level adopted revisions. Empty only when the envelope records none. */
  readonly adopted_sources: readonly AdoptedSourceView[];
  readonly adopted_source_count: number;
  /** Distinct skills whose `skill_sources` row carries a repository AND a commit sha. */
  readonly repository_pinned_skills: number | null;
  /** Distinct skills observed with `source_type: "git"`. */
  readonly git_sourced_skills: number | null;
  /** Distinct skills with at least one `skill_sources` row. */
  readonly total_sourced_skills: number | null;
  /** Non-null exactly when any of the three counts is `null`. */
  readonly unavailable_reason: string | null;
}

/** The release list. */
export interface ReleaseListView {
  /** Always `CATALOG_UNSCOPED_WORKSPACE_ID`: a release artifact names no workspace. */
  readonly workspace_id: string;
  readonly hub_id: string;
  readonly history_state: ReleaseHistoryState;
  /** Non-null exactly when `history_state === "single-verified-release"`. */
  readonly history_unavailable_reason: string | null;
  /** From the retained manifest only. Never derived, never defaulted. */
  readonly publication_revision: string | null;
  /** From the retained manifest only. Never derived, never defaulted. */
  readonly deployment_id: string | null;
  readonly releases: readonly ReleaseSummaryView[];
  readonly release_total: number;
  readonly generated_at: string;
}

/** One comparison request. */
export interface ReleaseComparisonOptions {
  readonly base: string;
  readonly candidate: string;
}

/**
 * The comparison result.
 *
 * Extends the shared {@link ReleaseDiffView} (every DTO field present unchanged)
 * with the payload `createReleaseDiff` actually computes. `status` has a third
 * value beyond the diff document's `UNCHANGED`/`CHANGED`:
 * `UNAVAILABLE`, which is what a comparison whose side could not be read
 * reports. It is never `UNCHANGED`: an unreadable side has no differences.
 */
export interface ReleaseComparisonView extends ReleaseDiffView {
  readonly status: "UNCHANGED" | "CHANGED" | "UNAVAILABLE";
  /** Non-null exactly when `status === "UNAVAILABLE"`. */
  readonly status_reason: string | null;
  readonly hub_id: string | null;
  readonly base_release_digest: string;
  readonly head_release_digest: string;
  /** Version-hash transitions, straight from the verified diff document. */
  readonly updated_skills: readonly ReleaseSkillUpdate[];
  readonly unchanged_count: number;
  readonly base_skill_count: number;
  readonly head_skill_count: number;
  readonly artifact_changes: {
    readonly alias_map: boolean;
    readonly search_index_input: boolean;
    readonly token_artifact: boolean;
    readonly adopted_sources: boolean;
  } | null;
  /**
   * Real notes about the artifact set behind the comparison, or `null` when
   * `artifact_changes` is `null`.
   */
  readonly notes: readonly string[] | null;
  readonly generated_at: string;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validate a release digest. Malformed input is a 400, distinct from a
 * well-formed digest that is simply not retained (a 404 on the detail route, an
 * explicit unavailable state on the comparison).
 */
export function validateReleaseDigest(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ReleaseReadError("E_WEB_RELEASE_DIGEST_INVALID", `${field} must be a string`);
  }
  if (value.length > RELEASE_DIGEST_MAX_LENGTH) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_DIGEST_INVALID",
      `${field} must be at most ${RELEASE_DIGEST_MAX_LENGTH} characters`,
    );
  }
  if (!DIGEST_RE.test(value)) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_DIGEST_INVALID",
      `${field} must match sha256:<64 lowercase hex characters>`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestOrNull(value: unknown): string | null {
  return typeof value === "string" && DIGEST_RE.test(value) ? value : null;
}

/**
 * Redact server filesystem layout from an upstream message.
 *
 * `HostedReleaseSnapshot.artifactDir` is absolute and several upstream loaders
 * interpolate it into their failure text. `describeLoadFailure` in
 * `release-identity.ts` already redacts exactly this; the same rule is applied
 * here so a releases-specific failure cannot be the one path that leaks a
 * directory layout.
 */
function redactPaths(message: string): string {
  return message
    .replace(/(?:\/[A-Za-z0-9._@+-]+)+\/?/g, "<redacted-path>")
    .replace(/[A-Za-z]:\\(?:[^\\\s"'`,;)]+\\)*[^\\\s"'`,;)]*/g, "<redacted-path>");
}

/** Sanitized one-line description of an upstream release failure. */
function describeUpstream(error: unknown): string {
  if (error instanceof HostedRuntimeError || error instanceof ReleaseReadError) {
    return redactPaths(`${error.code}: ${error.message}`);
  }
  if (error instanceof HubError) return redactPaths(`${error.code}: ${error.message}`);
  if (error instanceof Error) return redactPaths(`${error.name}: ${error.message}`);
  return redactPaths(String(error));
}

/** Read one artifact control file from a *verified* artifact directory. */
function readControlFile(artifactDir: string, file: string): unknown {
  try {
    return JSON.parse(readFileSync(join(artifactDir, file), "utf8")) as unknown;
  } catch (error) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_ARTIFACT_UNREADABLE",
      `${file} could not be read from the verified release artifact: ${describeUpstream(error)}`,
      503,
    );
  }
}

/** One measured artifact: byte length and byte digest of the exact file. */
function measureFile(artifactDir: string, file: string): { byte_length: number; byte_digest: string } {
  const path = join(artifactDir, file);
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_ARTIFACT_UNREADABLE",
      `The verified release artifact is missing ${file}: ${describeUpstream(error)}`,
      503,
    );
  }
  return {
    byte_length: stats.size,
    byte_digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Identity for one release                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the `ReleaseIdentity` for one verified snapshot.
 *
 * For the deployment's own release this returns the **binding's** identity
 * object unchanged rather than rebuilding it. That matters for two reasons: the
 * binding is the single evaluation the fail-closed guard already made, so the
 * status reported here cannot disagree with the status the guard checked; and it
 * preserves `unpinned` honestly instead of promoting it to `stable` on the way
 * through the release views.
 *
 * A historical release gets an identity built here, because no binding exists
 * for it. It is `unpinned`, which is the honest status: the release is verified
 * and readable, but nothing claims it is this deployment's current release. It
 * is deliberately not `mismatch` (nothing disagrees) and deliberately not
 * `stable` (nothing vouches for it). This matters because the console refuses to
 * present a release it cannot vouch for as current, and refusing to compare a
 * retained historical release with itself would make the compare route useless.
 *
 * `release-package.json` is re-read only to report `snapshot_rows` and
 * `sqlite_artifact_digest`, the same cross-check `buildIdentity` in
 * `release-identity.ts` performs; a disagreement means the bytes changed after
 * verification, so it fails closed.
 */
function identityForSnapshot(
  binding: ReleaseIdentityBinding,
  snapshot: HostedReleaseSnapshot,
  publicationRevision: string | null,
): ReleaseIdentity {
  const deployment = isDeployment(binding, snapshot.releaseDigest) ? binding.identity : null;
  if (deployment !== null) return deployment;

  const pkg = readControlFile(snapshot.artifactDir, "release-package.json");
  if (!isRecord(pkg)) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_ARTIFACT_UNREADABLE",
      "release-package.json is not an object in the verified release artifact.",
      503,
    );
  }
  const hubReleaseDigest = digestOrNull(pkg["hub_release_digest"]);
  const sqliteDigest = digestOrNull(pkg["sqlite_artifact_digest"]);
  const rows = pkg["snapshot_rows"];
  if (hubReleaseDigest === null || sqliteDigest === null || !Number.isSafeInteger(rows)) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_ARTIFACT_UNREADABLE",
      "release-package.json identity fields are malformed in the verified release artifact.",
      503,
    );
  }
  const actual = snapshot.releaseDigest;
  if (hubReleaseDigest !== actual) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_ARTIFACT_UNREADABLE",
      "The verified release envelope digest and release-package.json disagree for this release.",
      503,
    );
  }

  return Object.freeze({
    release_digest: actual,
    hub_id: snapshot.release.payload.hub_id,
    status: "unpinned",
    skill_count: Object.keys(snapshot.release.payload.skill_versions).length,
    snapshot_rows: rows as number,
    sqlite_artifact_digest: sqliteDigest,
    ...(publicationRevision === null ? {} : { publication_revision: publicationRevision }),
    mismatch_reason:
      `This release is retained and fully verified, but it is not the release this deployment's ` +
      `authoritative pointer names (${actual}). It is reported as history, never as the current release.`,
  });
}

/**
 * Summarise one release.
 *
 * `is_stable` is deliberately *not* derived from `identity.status`: the
 * deployment's own release is `stable`/`unpinned` depending on whether an
 * authoritative expectation is configured, and "is this the current release?" is
 * a different question from "did its digest match?". `isDeploymentRelease`
 * answers the former from the verified binding.
 */
function summarizeRelease(
  identity: ReleaseIdentity,
  publishedAt: null,
  isDeploymentRelease: boolean,
): ReleaseSummaryView {
  return Object.freeze({
    release: identity,
    published_at: publishedAt,
    published_at_unavailable_reason: RELEASES_NO_PUBLICATION_TIMESTAMP_REASON,
    is_stable: isDeploymentRelease,
    is_stable_basis: isDeploymentRelease
      ? "This release is the one the verified release-identity binding resolves to for this deployment."
      : "This release is retained history; the deployment's authoritative pointer names a different release.",
  });
}

/** Read the envelope's `adopted_sources` into the reported shape. */
function readAdoptedSources(snapshot: HostedReleaseSnapshot): readonly AdoptedSourceView[] {
  const raw = snapshot.release.payload.adopted_sources;
  if (!Array.isArray(raw)) return Object.freeze([]);
  const sources: AdoptedSourceView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const sourceId = entry["source_id"];
    const resolvedCommit = entry["resolved_commit"];
    if (typeof sourceId !== "string" || typeof resolvedCommit !== "string") continue;
    sources.push(
      Object.freeze({
        source_id: sourceId,
        resolved_commit: resolvedCommit,
        selected_skill_tree_digest: digestOrNull(entry["selected_skill_tree_digest"]) ?? "",
        source_config_digest: digestOrNull(entry["source_config_digest"]) ?? "",
        vendored_snapshot_digest: digestOrNull(entry["vendored_snapshot_digest"]) ?? "",
      }),
    );
  }
  return Object.freeze(sources);
}

/** The two verified artifacts: the semantic envelope and the SQLite snapshot. */
function readArtifacts(snapshot: HostedReleaseSnapshot): readonly ReleaseArtifactView[] {
  const release = measureFile(snapshot.artifactDir, "hub-release.json");
  const sqlite = measureFile(snapshot.artifactDir, "registry.sqlite");
  const pkg = readControlFile(snapshot.artifactDir, "release-package.json");
  const sqliteDigest = isRecord(pkg) ? digestOrNull(pkg["sqlite_artifact_digest"]) : null;
  if (sqliteDigest === null) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_ARTIFACT_UNREADABLE",
      "release-package.json declares no sqlite_artifact_digest in the verified release artifact.",
      503,
    );
  }
  return Object.freeze([
    Object.freeze({
      artifact_kind: "release" as const,
      object_digest: snapshot.releaseDigest,
      object_digest_kind: "hub-release-envelope" as const,
      byte_digest: release.byte_digest,
      byte_length: release.byte_length,
      artifact_file: "hub-release.json",
      created_at: null,
      created_at_unavailable_reason: RELEASES_NO_IMMUTABLE_OBJECT_METADATA_REASON,
    }),
    Object.freeze({
      artifact_kind: "sqlite" as const,
      object_digest: sqliteDigest,
      object_digest_kind: "sqlite-bytes" as const,
      byte_digest: sqlite.byte_digest,
      byte_length: sqlite.byte_length,
      artifact_file: "registry.sqlite",
      created_at: null,
      created_at_unavailable_reason: RELEASES_NO_IMMUTABLE_OBJECT_METADATA_REASON,
    }),
  ]);
}

/** `payload.contracts`, when the envelope records it. */
function readContracts(snapshot: HostedReleaseSnapshot): ReleaseContractView | null {
  const contracts = snapshot.release.payload.contracts;
  if (!isRecord(contracts)) return null;
  const numeric = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null);
  return Object.freeze({
    build_contract: typeof contracts["build_contract"] === "string" ? contracts["build_contract"] : "",
    hub_contract: typeof contracts["hub_contract"] === "string" ? contracts["hub_contract"] : "",
    update_contract: typeof contracts["update_contract"] === "string" ? contracts["update_contract"] : "",
    importer_build: numeric(contracts["importer_build"]) ?? 0,
    schema: typeof contracts["schema"] === "string" ? contracts["schema"] : "",
    hashing: numeric(contracts["hashing"]) ?? 0,
    router: numeric(contracts["router"]) ?? 0,
    search: numeric(contracts["search"]) ?? 0,
    token_estimator: typeof contracts["token_estimator"] === "string" ? contracts["token_estimator"] : "",
  });
}

/**
 * Publication bookkeeping from `candidate.json` plus `publication-preflight.json`.
 *
 * Both are hashed envelopes, so their facts live under `payload` and their
 * digest at the top level. Every field is optional because the artifact
 * directory this console loads may legitimately not carry a candidate (only a
 * *promotion* candidate is approved; the published artifact itself does not have
 * to ship one). `unavailable_reason` names exactly which half was absent so an
 * empty-looking block is not mistaken for "nothing was recorded".
 */
function readPublication(snapshot: HostedReleaseSnapshot): ReleasePublicationView {
  const candidate = readControlFileOrNull(snapshot.artifactDir, "candidate.json");
  const preflight = readControlFileOrNull(snapshot.artifactDir, "publication-preflight.json");

  const candidatePayload = payloadOf(candidate);
  const block = isRecord(candidatePayload?.["publication"])
    ? (candidatePayload["publication"] as Record<string, unknown>)
    : undefined;
  const preflightPayload = payloadOf(preflight);

  const blockers = Array.isArray(preflightPayload?.["blockers"])
    ? (preflightPayload["blockers"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  const view: ReleasePublicationView = Object.freeze({
    candidate_digest: isRecord(candidate) ? digestOrNull(candidate["digest"]) : null,
    release_diff_digest: block === undefined ? null : digestOrNull(block["release_diff_digest"]),
    preflight_digest: block === undefined ? null : digestOrNull(block["preflight_digest"]),
    approval_set_digest: block === undefined ? null : digestOrNull(block["approval_set_digest"]),
    publication_policy_revision:
      block !== undefined && typeof block["publication_policy_revision"] === "string"
        ? block["publication_policy_revision"]
        : null,
    previous_release_digest:
      block !== undefined ? digestOrNull(block["previous_release_digest"]) : null,
    preflight_blocker_count: preflightPayload === undefined ? 0 : blockers.length,
    preflight_blockers: Object.freeze([...blockers]),
    unavailable_reason: null,
  });

  // `unavailable_reason` names what is missing rather than leaving a block of
  // nulls to be read as "recorded as absent".
  const gaps: string[] = [];
  if (candidate === undefined) gaps.push("candidate.json is not readable from this artifact directory");
  else if (block === undefined) gaps.push("candidate.json carries no publication block");
  if (preflight === undefined) gaps.push("publication-preflight.json is not readable from this artifact directory");

  return Object.freeze({
    ...view,
    unavailable_reason: gaps.length === 0 ? null : gaps.join(" "),
  });
}

/** Read a control file, or `undefined` when it is absent or unreadable. */
function readControlFileOrNull(artifactDir: string, file: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = readControlFile(artifactDir, file);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** The `payload` of a hashed envelope control file, when it has one. */
function payloadOf(envelope: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (envelope === undefined) return undefined;
  const payload = envelope["payload"];
  return isRecord(payload) ? payload : undefined;
}

/** Audit-visible facts. The absent audit trail is stated, not implied. */
function readAudit(snapshot: HostedReleaseSnapshot, publication: ReleasePublicationView): ReleaseAuditView {
  const reviews = readApprovalDecisions(snapshot);
  const approvalCount = reviews.reduce((total, entry) => total + Number(entry.split(":")[1] ?? 0), 0);
  return Object.freeze({
    events: Object.freeze([]) as readonly never[],
    events_unavailable_reason:
      "audit_events has no writer in this system, so no audit trail exists to read for any release. " +
      "The approval counts below come from the verified publication preflight and are a governance " +
      "record of the release, not an audit log.",
    approval_count: approvalCount,
    approval_decisions: reviews,
    publication_policy_revision: publication.publication_policy_revision,
  });
}

/** `decision:count` pairs from the verified preflight, sorted for determinism. */
function readApprovalDecisions(snapshot: HostedReleaseSnapshot): readonly string[] {
  const payload = payloadOf(readControlFileOrNull(snapshot.artifactDir, "publication-preflight.json"));
  // The audit reason already states that no audit trail exists; a preflight that
  // cannot be read simply yields no approval counts, and `approval_count: 0`
  // alongside `events_unavailable_reason` is not a measurement of zero approvals
  // — it is the absence of a readable preflight.
  if (payload === undefined || !Array.isArray(payload["reviews"])) return Object.freeze([]);
  const decisions = new Map<string, number>();
  for (const review of payload["reviews"] as unknown[]) {
    if (!isRecord(review)) continue;
    const decision = review["decision"];
    if (typeof decision !== "string") continue;
    decisions.set(decision, (decisions.get(decision) ?? 0) + 1);
  }
  return Object.freeze(
    [...decisions.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([decision, count]) => `${decision}:${count}`),
  );
}

/* -------------------------------------------------------------------------- */
/* Per-skill provenance counts                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Count real `skill_sources` observations for a release.
 *
 * This module contributes **no SQL at all**. The counts are read through
 * `createRegistryReader` over `openReadOnlyRegistry(snapshot.context)` — the same
 * two calls `getRegistry` makes in `apps/web/server/registry.ts`, and the
 * documented extension point for "construct a reader over an explicitly verified
 * snapshot". Doing it that way is what makes the read safe rather than merely
 * parameterised:
 *
 * - `openReadOnlyRegistry` sets `pragma query_only = ON` and *verifies the pragma
 *   took*, so a write through this handle fails at the SQLite layer.
 * - `listReleasedSkillSources` binds every value as a `?` parameter; the only
 *   interpolated identifier in the whole console is the verified FTS corpus name,
 *   which a browser request can never supply.
 * - A reader is built for the *resolved* snapshot, so a historical release's
 *   provenance is counted from that release's own bytes rather than from the
 *   deployment's current handle. Using `getRegistry(config)` here would have read
 *   the wrong release's rows for every non-default digest.
 *
 * The three counts answer three different questions and are kept separate because
 * the shipped release makes the difference visible: it records
 * `source_type: "local"` with no repository and no commit for all 114 skills, so
 * `repository_pinned_skills` is 0 and `git_sourced_skills` is 0, even though the
 * `HubRelease` envelope records an adopted source with a `resolved_commit`.
 * Collapsing those into one "provenance" number would hide the distinction.
 *
 * A failure to read is reported as `null` counts plus a reason, never as zeros:
 * the architecture forbids presenting an absent measurement as a measured zero.
 */
function readProvenance(snapshot: HostedReleaseSnapshot): ReleaseProvenanceView {
  const adopted = readAdoptedSources(snapshot);
  let handle: ReadOnlyRegistryHandle | null = null;
  try {
    handle = openReadOnlyRegistry(snapshot.context);
    const reader = createRegistryReader(snapshot, handle);
    if (!reader.queryOnly) {
      return Object.freeze({
        adopted_sources: adopted,
        adopted_source_count: adopted.length,
        repository_pinned_skills: null,
        git_sourced_skills: null,
        total_sourced_skills: null,
        unavailable_reason:
          "The read-only registry handle did not report query_only enforcement, so no per-skill provenance was read. Zero is not reported in place of an unreadable count.",
      });
    }
    const total = new Set<string>();
    const git = new Set<string>();
    const pinned = new Set<string>();
    for (const skillId of reader.listReleasedSkillIds()) {
      for (const row of reader.listReleasedSkillSources(skillId)) {
        total.add(skillId);
        if (row.source_type !== "git") continue;
        git.add(skillId);
        if (row.repository !== null && row.commit_sha !== null) pinned.add(skillId);
      }
    }
    return Object.freeze({
      adopted_sources: adopted,
      adopted_source_count: adopted.length,
      repository_pinned_skills: pinned.size,
      git_sourced_skills: git.size,
      total_sourced_skills: total.size,
      unavailable_reason: null,
    });
  } catch (error) {
    return Object.freeze({
      adopted_sources: adopted,
      adopted_source_count: adopted.length,
      repository_pinned_skills: null,
      git_sourced_skills: null,
      total_sourced_skills: null,
      unavailable_reason: `Per-skill provenance could not be read from this release's verified snapshot: ${describeUpstream(error)}`,
    });
  } finally {
    handle?.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Snapshot resolution — the no-fallback core                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve one release digest to a verified snapshot, or fail.
 *
 * Mirrors `resolveRetainedRelease` (`packages/mcp/src/retained.ts:191-193`),
 * which throws `E_RELEASE_UNAVAILABLE` instead of substituting the default.
 * Three outcomes, and the third one does not exist:
 *
 * 1. A retained set is configured: the digest must be one of its entries.
 * 2. No retained set: the only digest that resolves is the one this deployment
 *    actually loaded. Anything else is unavailable.
 * 3. Never — an unknown digest is answered with the default release.
 *
 * Every snapshot this returns came out of `loadHostedReleaseSnapshot` (either
 * directly or via `loadRetainedReleaseSet`, which calls it per entry), so
 * "verified" is a structural property of the return value, not a claim.
 */
function resolveReleaseSnapshot(binding: ReleaseIdentityBinding, releaseDigest: string): HostedReleaseSnapshot {
  if (binding.retained !== null) {
    try {
      return resolveRetainedRelease(binding.retained, releaseDigest);
    } catch (error) {
      throw new ReleaseReadError(
        "E_WEB_RELEASE_UNAVAILABLE",
        `Release ${releaseDigest} is not retained by this deployment's retained release manifest. ${describeUpstream(error)}`,
        404,
      );
    }
  }
  const snapshot = binding.snapshot;
  if (snapshot !== null && snapshot.releaseDigest === releaseDigest) return snapshot;
  throw new ReleaseReadError(
    "E_WEB_RELEASE_UNAVAILABLE",
    `Release ${releaseDigest} is not held by this deployment. This deployment serves exactly one verified release and no retained release manifest, so no other digest can be resolved.`,
    404,
  );
}

/* -------------------------------------------------------------------------- */
/* Public entry points                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The release history — as much of it as this deployment can actually prove.
 *
 * Order, and why it is this order:
 *
 * 1. Validate nothing first (there are no request options here), then
 *    `assertCatalogServable(config)`. On `mismatch` or an unverifiable artifact
 *    it throws, so a release list is never served under an identity the
 *    deployment does not vouch for. This is the fail-closed rule, not a warning.
 * 2. `getReleaseIdentityBinding(config, dependencies)` — the *same* evaluation
 *    the guard just used, so the guard and the rows cannot come from different
 *    evaluations of the environment.
 * 3. Rows come from `binding.retained.payload.releases[]` when a manifest is
 *    configured (each of which `loadRetainedReleaseSet` verified), and from the
 *    single verified snapshot otherwise — with the absence stated in words.
 *
 * `dependencies` exists only so a test can inject a retained set; production
 * always passes `undefined` and reads `process.env` exactly once, inside
 * `loadServerConfig()`.
 */
export function getReleases(
  config?: Readonly<ServerConfig>,
  dependencies?: ReleaseIdentityDependencies,
): ReleaseListView {
  assertCatalogServable(config, dependencies);
  const resolved = config ?? undefined;
  const binding = getReleaseIdentityBinding(resolved, dependencies);
  const snapshot = binding.snapshot;
  if (snapshot === null) {
    // Unreachable while `assertCatalogServable` holds. Refusing is cheaper than
    // building a history around a release nobody verified.
    throw new ReleaseReadError(
      "E_WEB_RELEASE_UNVERIFIED",
      `No verified release snapshot is available: ${binding.unavailable_reason ?? "no verified release identity."}`,
      503,
    );
  }

  const hubId = snapshot.release.payload.hub_id;
  const publicationRevision =
    binding.retained === null
      ? null
      : String(binding.retained.manifest.payload.publication_revision);
  const deploymentId =
    binding.retained === null ? null : binding.retained.manifest.payload.deployment_id;

  if (binding.retained === null) {
    const identity = identityForSnapshot(binding, snapshot, publicationRevision);
    return Object.freeze({
      workspace_id: CATALOG_UNSCOPED_WORKSPACE_ID,
      hub_id: hubId,
      history_state: "single-verified-release" as const,
      history_unavailable_reason: RELEASES_NO_RETAINED_HISTORY_REASON,
      publication_revision: null,
      deployment_id: null,
      releases: Object.freeze([summarizeRelease(identity, null, true)]),
      release_total: 1,
      generated_at: new Date().toISOString(),
    });
  }

  const retained = binding.retained;
  const entries = retained.manifest.payload.releases;
  const defaultDigest = retained.manifest.payload.default_release_digest;
  const releases: ReleaseSummaryView[] = [];
  for (const entry of entries) {
    // Every retained entry was verified by `loadRetainedReleaseSet`, including
    // its release digest, so this map lookup cannot miss and cannot substitute.
    const entrySnapshot = retained.snapshots.get(entry.release_digest);
    if (entrySnapshot === undefined) {
      throw new ReleaseReadError(
        "E_WEB_RELEASE_UNVERIFIED",
        `The retained release manifest lists release ${entry.release_digest} but the verified set does not contain it.`,
        503,
      );
    }
    const identity = identityForSnapshot(binding, entrySnapshot, publicationRevision);
    releases.push(summarizeRelease(identity, null, entry.release_digest === defaultDigest));
  }

  return Object.freeze({
    workspace_id: CATALOG_UNSCOPED_WORKSPACE_ID,
    hub_id: hubId,
    history_state: "retained-manifest" as const,
    history_unavailable_reason: null,
    publication_revision: publicationRevision,
    deployment_id: deploymentId,
    releases: Object.freeze(releases),
    release_total: releases.length,
    generated_at: new Date().toISOString(),
  });
}

/**
 * Everything the console can honestly show about one release.
 *
 * Resolved through {@link resolveReleaseSnapshot}, so an unknown digest is a
 * deterministic `E_WEB_RELEASE_UNAVAILABLE` 404 and never the default release's
 * contents. `assertCatalogServable` runs first, so a mismatched deployment
 * identity refuses the whole route.
 */
export function getReleaseDetail(
  config: Readonly<ServerConfig> | undefined,
  releaseDigest: string,
  dependencies?: ReleaseIdentityDependencies,
): ReleaseDetailView {
  const digest = validateReleaseDigest(releaseDigest, "releaseDigest");
  assertCatalogServable(config, dependencies);
  const binding = getReleaseIdentityBinding(config, dependencies);
  const snapshot = resolveReleaseSnapshot(binding, digest);
  const retainedEntry =
    binding.retained === null
      ? undefined
      : binding.retained.manifest.payload.releases.find((entry) => entry.release_digest === digest);
  const publicationRevision =
    binding.retained === null
      ? null
      : String(binding.retained.manifest.payload.publication_revision);
  const isDeploymentRelease = isDeployment(binding, digest);
  const identity = identityForSnapshot(binding, snapshot, publicationRevision);
  const publication = readPublication(snapshot);
  const summary = summarizeRelease(identity, null, isDeploymentRelease);

  return Object.freeze({
    ...summary,
    artifacts: readArtifacts(snapshot),
    stable_pointer_updated_at: null,
    stable_pointer_unavailable_reason: RELEASES_NO_STABLE_POINTER_REASON,
    adopted_sources: readAdoptedSources(snapshot),
    contracts: readContracts(snapshot),
    publication,
    audit: readAudit(snapshot, publication),
    provenance: readProvenance(snapshot),
    retained: retainedEntry !== undefined,
    // POSIX-relative, as the retained manifest stores it. Never resolved to an
    // absolute path, which is why it is safe to report.
    retained_artifact_path: retainedEntry?.artifact_path ?? null,
    retained_candidate_digest: retainedEntry?.candidate_digest ?? null,
    retained_release_package_digest: retainedEntry?.release_package_digest ?? null,
  });
}

/**
 * Compare two releases through the frozen Contract R1 implementation.
 *
 * `createReleaseDiff` is reused unchanged: it re-verifies both envelopes and
 * already refuses a cross-Hub comparison (`packages/project/src/hub/release-diff.ts:88`).
 * This function adds no comparison logic of its own — it resolves the two sides,
 * refuses rather than substitutes, computes the *unchanged* set (which
 * `ReleaseDiffPayload` has no field for), and self-checks the arithmetic.
 *
 * Order:
 *
 * 1. Both digests are validated. Malformed input is a 400 and never reaches a
 *    snapshot lookup.
 * 2. `assertCatalogServable(config)` — fail closed on `mismatch`.
 * 3. Each side is resolved independently. A side that cannot be resolved yields
 *    `status: "UNAVAILABLE"` with
 *    {@link RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE} in its `*_unavailable_reason`
 *    and **empty** id lists — never `UNCHANGED`, never a one-sided diff, because
 *    half a comparison reads as "no changes on the missing side".
 * 4. Both sides resolve → `createReleaseDiff`.
 *
 * `base` and `candidate` map to the DTO's `base` and `head` respectively; the
 * DTO's field names are kept so a client decoder written against
 * `contracts.ts` keeps working.
 */
export function getReleaseComparison(
  config: Readonly<ServerConfig> | undefined,
  options: ReleaseComparisonOptions,
  dependencies?: ReleaseIdentityDependencies,
): ReleaseComparisonView {
  const base = validateReleaseDigest(options.base, "base");
  const candidate = validateReleaseDigest(options.candidate, "candidate");
  assertCatalogServable(config, dependencies);
  const binding = getReleaseIdentityBinding(config, dependencies);
  const generatedAt = new Date().toISOString();

  const baseResult = tryResolve(binding, base);
  const headResult = tryResolve(binding, candidate);

  if (baseResult === null || headResult === null) {
    // An unreadable side is an explicit state, never a partial diff.
    return Object.freeze({
      base: baseResult === null ? null : identityForSnapshot(binding, baseResult, null),
      head: headResult === null ? null : identityForSnapshot(binding, headResult, null),
      base_unavailable_reason: baseResult === null ? RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE : null,
      head_unavailable_reason: headResult === null ? RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE : null,
      added_skill_ids: Object.freeze([]),
      removed_skill_ids: Object.freeze([]),
      changed_skill_ids: Object.freeze([]),
      unchanged_skill_ids: Object.freeze([]),
      status: "UNAVAILABLE" as const,
      status_reason:
        baseResult === null && headResult === null
          ? `Neither side of the comparison could be resolved. ${RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE}`
          : baseResult === null
            ? `The base release ${base} could not be resolved. ${RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE}`
            : `The candidate release ${candidate} could not be resolved. ${RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE}`,
      hub_id: null,
      base_release_digest: base,
      head_release_digest: candidate,
      updated_skills: Object.freeze([]) as readonly ReleaseSkillUpdate[],
      unchanged_count: 0,
      base_skill_count: 0,
      head_skill_count: 0,
      artifact_changes: null,
      notes: Object.freeze([
        "No id list is reported because one side of the comparison could not be read. An empty list here means unavailable, not unchanged.",
      ]),
      generated_at: generatedAt,
    });
  }

  let diff;
  try {
    diff = createReleaseDiff(baseResult.release, headResult.release);
  } catch (error) {
    if (error instanceof HubError) {
      // The contract refusal, surfaced as a conflict rather than silently
      // producing a diff the contract says is meaningless.
      throw new ReleaseReadError(
        "E_WEB_RELEASE_HUB_MISMATCH",
        `The two releases cannot be compared: ${describeUpstream(error)}`,
        409,
      );
    }
    throw error;
  }

  const payload = diff.payload;
  const baseVersions = baseResult.release.payload.skill_versions;
  const headVersions = headResult.release.payload.skill_versions;
  const changed = new Set(payload.updated_skills.map((entry) => entry.skill_id));
  const added = new Set(payload.added_skill_ids);
  const removed = new Set(payload.removed_skill_ids);
  const unchanged: string[] = [];
  for (const skillId of Object.keys(baseVersions).sort()) {
    const baseHash = baseVersions[skillId];
    if (baseHash === undefined) continue;
    if (changed.has(skillId) || added.has(skillId) || removed.has(skillId)) continue;
    if (headVersions[skillId] !== baseHash) {
      // The diff document says every changed id is in `updated_skills`. If that
      // ever stopped being true the view would under-report changes, so refuse.
      throw new ReleaseReadError(
        "E_WEB_RELEASE_DIFF_INCONSISTENT",
        `The verified release diff does not account for skill ${skillId}; refusing to report a comparison that may be incomplete.`,
        503,
      );
    }
    unchanged.push(skillId);
  }

  // Self-check: the four buckets must partition both sides exactly. A mismatch
  // means a skill was silently dropped, which is the one failure mode a diff
  // view must never have.
  const baseCount = Object.keys(baseVersions).length;
  const headCount = Object.keys(headVersions).length;
  const accounted = added.size + removed.size + changed.size + unchanged.length;
  if (accounted !== baseCount || baseCount - removed.size !== headCount - added.size) {
    throw new ReleaseReadError(
      "E_WEB_RELEASE_DIFF_INCONSISTENT",
      "The verified release diff does not partition both releases; refusing to report a comparison that may be incomplete.",
      503,
    );
  }

  const notes: string[] = [];
  notes.push(
    `Unchanged is computed from the verified skill_versions map: an id present in both releases with an identical version hash. ${unchanged.length} of ${baseCount} base skills are unchanged.`,
  );
  notes.push(
    `artifact_changes are the Contract R1 booleans over the semantic envelope digests (alias_map, search_index_input, token_artifact, adopted_sources). SQLite bytes are deliberately not part of release identity.`,
  );
  notes.push(
    "Per-skill provenance change cannot be reported from release identities alone: skill_sources rows are not part of the semantic envelope. Read the two releases' skill detail to compare observed provenance.",
  );

  return Object.freeze({
    base: identityForSnapshot(binding, baseResult, null),
    head: identityForSnapshot(binding, headResult, null),
    base_unavailable_reason: null,
    head_unavailable_reason: null,
    added_skill_ids: Object.freeze([...payload.added_skill_ids]),
    removed_skill_ids: Object.freeze([...payload.removed_skill_ids]),
    changed_skill_ids: Object.freeze([...changed].sort()),
    unchanged_skill_ids: Object.freeze(unchanged),
    status: payload.status,
    status_reason: null,
    hub_id: payload.hub_id,
    base_release_digest: payload.base_release_digest,
    head_release_digest: payload.candidate_release_digest,
    updated_skills: Object.freeze([...payload.updated_skills]),
    unchanged_count: unchanged.length,
    base_skill_count: baseCount,
    head_skill_count: headCount,
    artifact_changes: Object.freeze({ ...payload.artifact_changes }),
    notes: Object.freeze(notes),
    generated_at: generatedAt,
  });
}

/** Is this digest the release the deployment's own binding resolved to? */
function isDeployment(binding: ReleaseIdentityBinding, releaseDigest: string): boolean {
  return binding.snapshot !== null && binding.snapshot.releaseDigest === releaseDigest;
}

/** Resolve, or `null` — the comparison path's non-throwing probe. */
function tryResolve(
  binding: ReleaseIdentityBinding,
  releaseDigest: string,
): HostedReleaseSnapshot | null {
  try {
    return resolveReleaseSnapshot(binding, releaseDigest);
  } catch {
    return null;
  }
}
