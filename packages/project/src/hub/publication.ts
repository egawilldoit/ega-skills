// Contract R1/R2 production publication gate.
//
// Contract R2 governs the durable retained-release promotion path, but the
// hosted service is activated by moving a Vercel production alias. That surface
// is last-write-wins and has no compare-and-swap operation. This module makes
// every supported promotion pass one reviewable gate before any alias mutation:
//
//   * the exact R1/I1 candidate and its owner approval are bound by digest;
//   * the expected predecessor release and deployment are checked against the
//     live alias and the live served identity;
//   * only platform states that cannot bypass the gate are accepted (Git
//     production auto-deploy disabled, no alternate production aliases, all
//     deployment checks concluded successfully);
//   * the publisher identity is pinned; and
//   * the promoted result is re-observed and recorded in a rollback receipt.
//
// What this module deliberately does not claim: Vercel offers no conditional
// alias write. Serialization is therefore enforced by the exclusive publisher
// lease plus the live re-read immediately before promotion, and any platform
// principal that can promote outside that lease is a residual risk. The gate
// refuses to run when such a path is observable. See
// docs/operations/RELEASE-2.0-RUNBOOK.md.

import { createEnvelope, verifyEnvelope } from "@ega-skills/hashing";

export class PublicationGateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicationGateError";
    this.code = code;
  }
}

export const PUBLICATION_APPROVAL_OBJECT_TYPE = "ega.production-publication-approval" as const;
export const PUBLICATION_APPROVAL_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_RECEIPT_OBJECT_TYPE = "ega.production-publication-receipt" as const;
export const PUBLICATION_RECEIPT_SCHEMA_VERSION = 1 as const;

/**
 * The first governed release is preceded by a runtime that predates the
 * readiness-identity endpoint. A separate, owner-authorized migration deploys
 * the reviewed runtime with the *unchanged* retained artifact, so the publisher
 * can observe a real digest before the first semantic release change. This is
 * not a publication receipt and never enters the publication revision chain.
 */
export const BASELINE_MIGRATION_AUTHORIZATION_OBJECT_TYPE = "ega.baseline-runtime-migration-authorization" as const;
export const BASELINE_MIGRATION_AUTHORIZATION_SCHEMA_VERSION = 3 as const;
export const BASELINE_MIGRATION_RECEIPT_OBJECT_TYPE = "ega.baseline-runtime-migration-receipt" as const;
export const BASELINE_MIGRATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const BASELINE_MIGRATION_SCOPE = "runtime-readiness-only" as const;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DEPLOYMENT_RE = /^dpl_[A-Za-z0-9]{8,}$/;
const ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface PublicationPublisher {
  /** Human/EGA subject that owns the release decision. */
  readonly owner_subject: string;
  /** Vercel account that is permitted to execute the promotion. */
  readonly vercel_user_id: string;
  readonly team_id: string;
  readonly project_id: string;
}

export interface PublicationApprovalPayload {
  readonly hub_id: string;
  readonly release_digest: string;
  readonly candidate_digest: string;
  readonly previous_release_digest: string;
  /** Policy digest for an I1 release; the empty string for a legacy release. */
  readonly policy_digest: string;
  readonly source_snapshot_digest: string;
  readonly skill_versions: Readonly<Record<string, string>>;
  readonly approved_by: string;
  /** Stable reference to the recorded owner decision (issue/comment URL/id). */
  readonly approval_record: string;
  readonly approved_at: string;
  readonly publisher: PublicationPublisher;
}

export type PublicationApproval = {
  readonly object_type: typeof PUBLICATION_APPROVAL_OBJECT_TYPE;
  readonly schema_version: typeof PUBLICATION_APPROVAL_SCHEMA_VERSION;
  readonly payload: PublicationApprovalPayload;
  readonly digest: string;
};

/**
 * Vercel assigns automatic deployment aliases in addition to the canonical
 * production alias. They are production-reachable, so the gate must account
 * for them instead of pretending only one alias exists. Recognition is
 * deliberately narrow: the canonical alias, or a generated alias whose label
 * is derived from the exact project name and either the authorized production
 * branch or the deployment's immutable Git ref, ending in Vercel's eight-hex
 * assignment suffix. Unknown names, custom domains and redirects stay blocked.
 */
const VERCEL_MANAGED_SUFFIX = ".vercel.app";
const VERCEL_ALIAS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function aliasSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Vercel's branch segment: `release/2.0` becomes `release-20`. */
function branchSlug(value: string): string {
  return value.toLowerCase().replace(/\./g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ProductionAliasContext {
  readonly canonical_alias: string;
  readonly project_name: string;
  /** The authorized production branch plus the observed deployment Git ref. */
  readonly branches: readonly string[];
}

export function isRecognizedProductionAlias(alias: string, context: ProductionAliasContext): boolean {
  if (alias === context.canonical_alias) return true;
  if (typeof alias !== "string" || !alias.endsWith(VERCEL_MANAGED_SUFFIX)) return false;
  const label = alias.slice(0, -VERCEL_MANAGED_SUFFIX.length);
  if (!VERCEL_ALIAS_LABEL.test(label)) return false;
  const project = aliasSlug(context.project_name);
  if (!project) return false;
  const suffixed = "[a-z0-9-]+-[0-9a-f]{8}";
  if (new RegExp(`^${escapeRegExp(project)}-(?!git-)${suffixed}$`).test(label)) return true;
  return context.branches.map(branchSlug).filter(Boolean).some((branch) =>
    new RegExp(`^${escapeRegExp(project)}-git-${escapeRegExp(branch)}-${suffixed}$`).test(label));
}

/** Every observed production alias must be canonical or narrowly recognized. */
export function productionAliasesAreRecognized(
  aliases: readonly string[] | undefined,
  context: ProductionAliasContext,
  canonicalAlias: string,
): boolean {
  if (!Array.isArray(aliases) || aliases.length === 0) return false;
  if (new Set(aliases).size !== aliases.length) return false;
  if (!aliases.includes(canonicalAlias)) return false;
  return aliases.every((alias) => isRecognizedProductionAlias(alias, context));
}

function observedAliasContext(observed: { readonly project_name?: string; readonly production_branch: string; readonly deployment_source_ref?: string }, canonicalAlias: string): ProductionAliasContext {
  return {
    branches: [observed.production_branch, observed.deployment_source_ref].filter((value): value is string => typeof value === "string" && value.length > 0),
    canonical_alias: canonicalAlias,
    project_name: observed.project_name ?? "",
  };
}

export interface GitAutoDeployControl {
  readonly kind: "runtime-config";
  readonly deployment_enabled: false;
  readonly source_commit: string;
  readonly config_digest: string;
}

/**
 * A project-api `git.deploymentEnabled: false` is direct evidence. Vercel does
 * not expose that field on every project read, so the publisher may instead
 * verify the exact reviewed runtime's `packages/mcp/vercel.json` and bind its
 * digest and source commit. Anything else stays blocked.
 */
export function gitAutoDeployIsDisabled(
  observed: { readonly git_production_auto_deploy: boolean; readonly git_auto_deploy_control?: GitAutoDeployControl },
  expected: { readonly runtime_source_commit?: string; readonly runtime_vercel_config_digest?: string },
): boolean {
  if (observed.git_production_auto_deploy === false) return true;
  const control = observed.git_auto_deploy_control;
  return control?.kind === "runtime-config" && control.deployment_enabled === false &&
    typeof expected.runtime_source_commit === "string" && control.source_commit === expected.runtime_source_commit &&
    typeof expected.runtime_vercel_config_digest === "string" && control.config_digest === expected.runtime_vercel_config_digest;
}

export interface PublicationObservation {
  readonly team_id: string;
  readonly project_id: string;
  readonly production_branch: string;
  /** Vercel project name, used only to recognize generated aliases. */
  readonly project_name?: string;
  /** Immutable Git ref of the production deployment, when Vercel reports it. */
  readonly deployment_source_ref?: string;
  readonly canonical_alias: string;
  /** True when Vercel Git integration can deploy the production branch. */
  readonly git_production_auto_deploy: boolean;
  /** Exact runtime-config evidence when the project API omits the field. */
  readonly git_auto_deploy_control?: GitAutoDeployControl;
  /** Aliases that can reach a production deployment (canonical + custom). */
  readonly production_aliases: readonly string[];
  readonly alias_target_deployment_id: string;
  readonly served_deployment_id: string;
  readonly served_release_digest: string;
  readonly deployment_ready_state: string;
  readonly deployment_checks_state: "succeeded" | "failed" | "pending" | "none";
}

export interface PublicationExpectation {
  readonly team_id: string;
  readonly project_id: string;
  readonly production_branch: string;
  readonly canonical_alias: string;
  readonly runtime_source_commit?: string;
  readonly runtime_vercel_config_digest?: string;
  readonly predecessor_release_digest: string;
  readonly predecessor_deployment_id: string;
  readonly expected_revision: number;
  readonly publisher_vercel_user_id: string;
  readonly now: string;
  readonly max_approval_age_ms: number;
}

export interface PublicationCandidateIdentity {
  readonly hub_id: string;
  readonly release_digest: string;
  readonly candidate_digest: string;
  readonly previous_release_digest: string;
  readonly policy_digest: string;
  /** Vendored snapshot of the single governed source; empty for legacy releases. */
  readonly source_snapshot_digest: string;
  readonly skill_versions: Readonly<Record<string, string>>;
}

export type ProductionPublicationBlockerCode =
  | "E_APPROVAL_INVALID"
  | "E_APPROVAL_STALE"
  | "E_APPROVAL_IDENTITY_MISMATCH"
  | "E_CANDIDATE_MISMATCH"
  | "E_PREDECESSOR_MISMATCH"
  | "E_ALIAS_DRIFT"
  | "E_PLATFORM_GUARD"
  | "E_DEPLOYMENT_NOT_READY"
  | "E_CHECKS_NOT_PASSED";

export interface ProductionPublicationBlocker {
  readonly code: ProductionPublicationBlockerCode;
  readonly message: string;
}

export interface ProductionPublicationAssessment {
  readonly status: "READY" | "BLOCKED";
  readonly blockers: readonly ProductionPublicationBlocker[];
  readonly approval_digest: string;
  readonly release_digest: string;
  readonly candidate_digest: string;
  readonly previous_release_digest: string;
}

function fail(message: string, code = "E_PUBLICATION_SCHEMA"): never {
  throw new PublicationGateError(code, `production publication: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(`${name} has missing or unknown fields`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) fail(`${name} must be a non-empty string`);
  return value;
}

/**
 * An approval record is a concrete GitHub issue or pull-request record in the
 * release repository. This does not authenticate the decision; it prevents an
 * arbitrary string from being presented as the recorded authority.
 */
function approvalRecord(value: unknown): string {
  const record = text(value, "approval_record");
  if (!/^https:\/\/github\.com\/egawilldoit\/ega-skills\/(?:issues|pull)\/[0-9]+(?:#issuecomment-[0-9]+)?$/.test(record)) {
    fail("approval_record must be an issue or pull request record in egawilldoit/ega-skills");
  }
  return record;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${name} must match sha256:<64 lowercase hex>`);
  return value;
}

function deploymentId(value: unknown, name: string): string {
  if (typeof value !== "string" || !DEPLOYMENT_RE.test(value)) fail(`${name} must be a Vercel deployment id`);
  return value;
}

function alias(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 253 || !ALIAS_RE.test(value)) fail(`${name} must be a bare DNS alias`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !UTC_RE.test(value) || Number.isNaN(Date.parse(value))) fail(`${name} must be an RFC3339 UTC timestamp`);
  return value;
}

function publisher(value: unknown): PublicationPublisher {
  if (!isObject(value)) fail("publisher must be an object");
  exactKeys(value, ["owner_subject", "project_id", "team_id", "vercel_user_id"], "publisher");
  return {
    owner_subject: text(value["owner_subject"], "publisher.owner_subject"),
    project_id: text(value["project_id"], "publisher.project_id"),
    team_id: text(value["team_id"], "publisher.team_id"),
    vercel_user_id: text(value["vercel_user_id"], "publisher.vercel_user_id"),
  };
}

function skillVersions(value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value) || Object.keys(value).length === 0) fail("skill_versions must be a non-empty object");
  const entries = Object.entries(value);
  const sorted = entries.map(([id]) => id).sort();
  if (JSON.stringify(entries.map(([id]) => id)) !== JSON.stringify(sorted)) fail("skill_versions must be sorted by skill id");
  const result: Record<string, string> = {};
  for (const [id, hash] of entries) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,255}$/.test(id)) fail(`skill_versions contains an invalid id: ${id}`);
    result[id] = digest(hash, `skill_versions[${id}]`);
  }
  return result;
}

/** Verify the exact owner-approval envelope that authorizes one release. */
export function verifyPublicationApproval(value: unknown): PublicationApproval {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isObject(value) || value["object_type"] !== PUBLICATION_APPROVAL_OBJECT_TYPE || value["schema_version"] !== PUBLICATION_APPROVAL_SCHEMA_VERSION) {
    fail(`approval envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  exactKeys(value, ["digest", "object_type", "payload", "schema_version"], "approval envelope");
  if (!isObject(value["payload"])) fail("approval payload must be an object");
  const p = value["payload"];
  exactKeys(p, [
    "approval_record",
    "approved_at",
    "approved_by",
    "candidate_digest",
    "hub_id",
    "policy_digest",
    "previous_release_digest",
    "publisher",
    "release_digest",
    "skill_versions",
    "source_snapshot_digest",
  ], "approval payload");
  const policy = p["policy_digest"];
  if (typeof policy !== "string" || (policy !== "" && !DIGEST_RE.test(policy))) fail("policy_digest must be empty or a digest");
  const snapshot = p["source_snapshot_digest"];
  if (typeof snapshot !== "string" || (snapshot !== "" && !DIGEST_RE.test(snapshot))) fail("source_snapshot_digest must be empty or a digest");
  return {
    digest: digest(value["digest"], "approval digest"),
    object_type: PUBLICATION_APPROVAL_OBJECT_TYPE,
    payload: {
      approval_record: approvalRecord(p["approval_record"]),
      approved_at: timestamp(p["approved_at"], "approved_at"),
      approved_by: text(p["approved_by"], "approved_by"),
      candidate_digest: digest(p["candidate_digest"], "candidate_digest"),
      hub_id: text(p["hub_id"], "hub_id"),
      policy_digest: policy,
      previous_release_digest: digest(p["previous_release_digest"], "previous_release_digest"),
      publisher: publisher(p["publisher"]),
      release_digest: digest(p["release_digest"], "release_digest"),
      skill_versions: skillVersions(p["skill_versions"]),
      source_snapshot_digest: snapshot,
    },
    schema_version: PUBLICATION_APPROVAL_SCHEMA_VERSION,
  };
}

export function createPublicationApproval(payload: PublicationApprovalPayload): PublicationApproval {
  const raw = createEnvelope({
    object_type: PUBLICATION_APPROVAL_OBJECT_TYPE,
    payload,
    schema_version: PUBLICATION_APPROVAL_SCHEMA_VERSION,
  });
  return verifyPublicationApproval(raw);
}

function sameVersions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Pure gate. It never performs I/O and never mutates state, so the exact same
 * assessment is used by the stage step, the promote step and tests.
 */
export function assessProductionPublication(input: {
  readonly approval: unknown;
  readonly candidate: PublicationCandidateIdentity;
  readonly observation: PublicationObservation;
  readonly expected: PublicationExpectation;
}): ProductionPublicationAssessment {
  const blockers: ProductionPublicationBlocker[] = [];
  const block = (code: ProductionPublicationBlockerCode, message: string) => blockers.push({ code, message });

  let approval: PublicationApproval | undefined;
  try {
    approval = verifyPublicationApproval(input.approval);
  } catch (error) {
    block("E_APPROVAL_INVALID", error instanceof Error ? error.message : String(error));
  }

  const candidate = input.candidate;
  const observed = input.observation;
  const expected = input.expected;

  if (approval) {
    const p = approval.payload;
    if (p.hub_id !== candidate.hub_id) block("E_CANDIDATE_MISMATCH", "approval Hub does not match the candidate");
    if (p.release_digest !== candidate.release_digest || p.candidate_digest !== candidate.candidate_digest || p.previous_release_digest !== candidate.previous_release_digest) {
      block("E_CANDIDATE_MISMATCH", "approval does not bind the exact candidate, release and predecessor");
    }
    if (p.policy_digest !== candidate.policy_digest) block("E_CANDIDATE_MISMATCH", "approval policy digest does not match the candidate");
    if (p.source_snapshot_digest !== candidate.source_snapshot_digest) block("E_CANDIDATE_MISMATCH", "approval source snapshot does not match the candidate provenance");
    if (!sameVersions(p.skill_versions, candidate.skill_versions)) block("E_CANDIDATE_MISMATCH", "approval skill versions do not match the candidate release");
    if (p.publisher.team_id !== expected.team_id || p.publisher.project_id !== expected.project_id) block("E_APPROVAL_IDENTITY_MISMATCH", "approval publisher team/project does not match the target");
    if (p.publisher.vercel_user_id !== expected.publisher_vercel_user_id) block("E_APPROVAL_IDENTITY_MISMATCH", "executing Vercel identity is not the approved publisher");
    if (p.approved_by !== p.publisher.owner_subject) block("E_APPROVAL_IDENTITY_MISMATCH", "approval actor and publisher owner differ");
    const approvedAt = Date.parse(p.approved_at);
    const now = Date.parse(expected.now);
    if (!Number.isFinite(now)) fail("expected.now is not a timestamp");
    if (approvedAt > now + 5 * 60_000) block("E_APPROVAL_STALE", "approval timestamp is in the future");
    else if (now - approvedAt > expected.max_approval_age_ms) block("E_APPROVAL_STALE", "approval is older than the accepted window");
  }

  if (candidate.previous_release_digest !== expected.predecessor_release_digest) block("E_PREDECESSOR_MISMATCH", "candidate predecessor is not the expected production release");
  if (observed.served_release_digest !== expected.predecessor_release_digest) block("E_PREDECESSOR_MISMATCH", "live production release is not the expected predecessor");
  if (observed.alias_target_deployment_id !== expected.predecessor_deployment_id) block("E_PREDECESSOR_MISMATCH", "production alias does not point at the expected predecessor deployment");
  if (observed.served_deployment_id !== expected.predecessor_deployment_id) block("E_PREDECESSOR_MISMATCH", "served deployment is not the expected predecessor deployment");
  if (observed.team_id !== expected.team_id) block("E_PLATFORM_GUARD", "Vercel team identity mismatch");
  if (observed.project_id !== expected.project_id) block("E_PLATFORM_GUARD", "Vercel project identity mismatch");
  if (observed.production_branch !== expected.production_branch) block("E_PLATFORM_GUARD", "Vercel production branch mismatch");
  if (observed.canonical_alias !== expected.canonical_alias) block("E_ALIAS_DRIFT", "canonical production alias mismatch");
  if (!gitAutoDeployIsDisabled(observed, expected)) block("E_PLATFORM_GUARD", "Vercel Git auto-deploy is not observably disabled for the production branch; staging would assign the public domain automatically");
  if (!productionAliasesAreRecognized(observed.production_aliases, observedAliasContext(observed, expected.canonical_alias), expected.canonical_alias)) {
    block("E_PLATFORM_GUARD", "a production alias is unknown, redirected, duplicated or outside the recognized Vercel-managed set");
  }
  if (observed.deployment_ready_state !== "READY") block("E_DEPLOYMENT_NOT_READY", "the predecessor deployment is not READY");
  if (observed.deployment_checks_state !== "succeeded") block("E_CHECKS_NOT_PASSED", "deployment checks have not concluded successfully; force-promotion is forbidden");

  return {
    approval_digest: approval?.digest ?? "",
    blockers,
    candidate_digest: candidate.candidate_digest,
    previous_release_digest: candidate.previous_release_digest,
    release_digest: candidate.release_digest,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
  };
}

export interface PublicationReceiptPayload {
  readonly action: "PROMOTE" | "ROLLBACK";
  readonly status: "SUCCEEDED" | "FAILED";
  readonly hub_id: string;
  readonly release_digest: string;
  readonly candidate_digest: string;
  readonly previous_release_digest: string;
  readonly policy_digest: string;
  readonly approval_digest: string;
  readonly previous_revision: number;
  readonly publication_revision: number;
  readonly deployment_id: string;
  readonly previous_deployment_id: string;
  readonly canonical_alias: string;
  readonly actor: PublicationPublisher;
  readonly completed_at: string;
  readonly detail: string;
}

export type PublicationReceipt = {
  readonly object_type: typeof PUBLICATION_RECEIPT_OBJECT_TYPE;
  readonly schema_version: typeof PUBLICATION_RECEIPT_SCHEMA_VERSION;
  readonly payload: PublicationReceiptPayload;
  readonly digest: string;
};

export function createPublicationReceipt(payload: PublicationReceiptPayload): PublicationReceipt {
  return createEnvelope({
    object_type: PUBLICATION_RECEIPT_OBJECT_TYPE,
    payload,
    schema_version: PUBLICATION_RECEIPT_SCHEMA_VERSION,
  }) as PublicationReceipt;
}

/** Verify a receipt and, when chained, enforce monotonic revision and predecessor. */
export function verifyPublicationReceipt(value: unknown, previous?: unknown): PublicationReceipt {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isObject(value) || value["object_type"] !== PUBLICATION_RECEIPT_OBJECT_TYPE || value["schema_version"] !== PUBLICATION_RECEIPT_SCHEMA_VERSION) {
    fail(`receipt envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  exactKeys(value, ["digest", "object_type", "payload", "schema_version"], "receipt envelope");
  if (!isObject(value["payload"])) fail("receipt payload must be an object");
  const p = value["payload"];
  exactKeys(p, [
    "action",
    "actor",
    "approval_digest",
    "candidate_digest",
    "canonical_alias",
    "completed_at",
    "deployment_id",
    "detail",
    "hub_id",
    "policy_digest",
    "previous_deployment_id",
    "previous_release_digest",
    "previous_revision",
    "publication_revision",
    "release_digest",
    "status",
  ], "receipt payload");
  if (p["action"] !== "PROMOTE" && p["action"] !== "ROLLBACK") fail("receipt action is invalid");
  if (p["status"] !== "SUCCEEDED" && p["status"] !== "FAILED") fail("receipt status is invalid");
  for (const field of ["previous_revision", "publication_revision"]) {
    if (!Number.isSafeInteger(p[field]) || (p[field] as number) < 0) fail(`receipt ${field} is invalid`);
  }
  if (p["status"] === "SUCCEEDED" && (p["publication_revision"] as number) !== (p["previous_revision"] as number) + 1) fail("a successful receipt must advance the publication revision exactly once");
  if (p["status"] === "FAILED" && (p["publication_revision"] as number) !== (p["previous_revision"] as number)) fail("a failed receipt is side evidence and must not advance the publication revision");
  const receipt: PublicationReceipt = {
    digest: digest(value["digest"], "receipt digest"),
    object_type: PUBLICATION_RECEIPT_OBJECT_TYPE,
    payload: {
      action: p["action"],
      actor: publisher(p["actor"]),
      approval_digest: digest(p["approval_digest"], "approval_digest"),
      candidate_digest: digest(p["candidate_digest"], "candidate_digest"),
      canonical_alias: alias(p["canonical_alias"], "canonical_alias"),
      completed_at: timestamp(p["completed_at"], "completed_at"),
      deployment_id: deploymentId(p["deployment_id"], "deployment_id"),
      detail: text(p["detail"], "detail"),
      hub_id: text(p["hub_id"], "hub_id"),
      policy_digest: typeof p["policy_digest"] === "string" && (p["policy_digest"] === "" || DIGEST_RE.test(p["policy_digest"])) ? p["policy_digest"] : fail("policy_digest is invalid"),
      previous_deployment_id: deploymentId(p["previous_deployment_id"], "previous_deployment_id"),
      previous_release_digest: digest(p["previous_release_digest"], "previous_release_digest"),
      previous_revision: p["previous_revision"] as number,
      publication_revision: p["publication_revision"] as number,
      release_digest: digest(p["release_digest"], "release_digest"),
      status: p["status"],
    },
    schema_version: PUBLICATION_RECEIPT_SCHEMA_VERSION,
  };
  if (previous !== undefined) {
    const prior = verifyPublicationReceipt(previous);
    if (prior.payload.hub_id !== receipt.payload.hub_id || prior.payload.canonical_alias !== receipt.payload.canonical_alias ||
        JSON.stringify(prior.payload.actor) !== JSON.stringify(receipt.payload.actor)) fail("receipt chain crosses a Hub, alias or publisher boundary");
    if (prior.payload.publication_revision !== receipt.payload.previous_revision) fail("receipt chain revision is not contiguous");
    if (prior.payload.release_digest !== receipt.payload.previous_release_digest) fail("receipt chain predecessor does not match the prior release");
    if (prior.payload.deployment_id !== receipt.payload.previous_deployment_id) fail("receipt chain predecessor does not match the prior deployment");
  }
  return receipt;
}

/* -------------------------------------------------------------------------- */
/* Baseline runtime migration                                                  */
/* -------------------------------------------------------------------------- */

const COMMIT_RE = /^[0-9a-f]{40}$/;

function commitSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !COMMIT_RE.test(value)) fail(`${name} must be a full lowercase 40-hex Git commit`);
  return value;
}

export interface BaselineMigrationAuthorizationPayload {
  readonly scope: typeof BASELINE_MIGRATION_SCOPE;
  readonly hub_id: string;
  /** Exact retained 117-skill release that must continue to be served. */
  readonly baseline_release_digest: string;
  /** Exact retained candidate envelope that produced that release. */
  readonly baseline_candidate_digest: string;
  /** Physical artifact-tree digest of the retained artifact directory. */
  readonly baseline_artifact_tree_digest: string;
  /**
   * Physical artifact-tree digest of the main-branch candidate that supplies
   * the runtime source. It is verified and never deployed; only the retained
   * baseline artifact above is placed in the deployment.
   */
  readonly candidate_artifact_tree_digest: string;
  /** Exact approved 126-skill release digest at the runtime source. */
  readonly candidate_release_digest: string;
  /** Digest of `packages/mcp/vercel.json` at the runtime source commit. */
  readonly runtime_vercel_config_digest: string;
  /** Commit that produced the currently serving legacy deployment. */
  readonly predecessor_source_commit: string;
  /** Reviewed runtime commit; must equal `migration_source_commit`. */
  readonly reviewed_runtime_commit: string;
  /** Reviewed main-reachable runtime commit that is deployed. */
  readonly migration_source_commit: string;
  /**
   * The legacy deployment predates deployment checks. "succeeded" requires a
   * real successful check; "absent-accepted" is an explicit owner acceptance of
   * a pre-check immutable deployment that is READY and serves the verified
   * artifact. Neither value accepts a failed or pending check.
   */
  readonly legacy_deployment_checks: "succeeded" | "absent-accepted";
  readonly predecessor_deployment_id: string;
  readonly canonical_alias: string;
  readonly production_branch: string;
  readonly publisher: PublicationPublisher;
  readonly approved_by: string;
  readonly approval_record: string;
  readonly approved_at: string;
}

export type BaselineMigrationAuthorization = {
  readonly object_type: typeof BASELINE_MIGRATION_AUTHORIZATION_OBJECT_TYPE;
  readonly schema_version: typeof BASELINE_MIGRATION_AUTHORIZATION_SCHEMA_VERSION;
  readonly payload: BaselineMigrationAuthorizationPayload;
  readonly digest: string;
};

/** Verify the exact owner authorization for one runtime-only migration. */
export function verifyBaselineMigrationAuthorization(value: unknown): BaselineMigrationAuthorization {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isObject(value) || value["object_type"] !== BASELINE_MIGRATION_AUTHORIZATION_OBJECT_TYPE ||
      value["schema_version"] !== BASELINE_MIGRATION_AUTHORIZATION_SCHEMA_VERSION) {
    fail(`baseline migration authorization is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  exactKeys(value, ["digest", "object_type", "payload", "schema_version"], "baseline migration authorization envelope");
  if (!isObject(value["payload"])) fail("baseline migration authorization payload must be an object");
  const p = value["payload"];
  exactKeys(p, [
    "approval_record",
    "approved_at",
    "approved_by",
    "baseline_artifact_tree_digest",
    "baseline_candidate_digest",
    "baseline_release_digest",
    "canonical_alias",
    "candidate_artifact_tree_digest",
    "candidate_release_digest",
    "hub_id",
    "legacy_deployment_checks",
    "migration_source_commit",
    "predecessor_deployment_id",
    "predecessor_source_commit",
    "production_branch",
    "reviewed_runtime_commit",
    "runtime_vercel_config_digest",
    "publisher",
    "scope",
  ], "baseline migration authorization payload");
  if (p["scope"] !== BASELINE_MIGRATION_SCOPE) fail("baseline migration authorization scope is not runtime-readiness-only");
  if (p["legacy_deployment_checks"] !== "succeeded" && p["legacy_deployment_checks"] !== "absent-accepted") {
    fail("legacy_deployment_checks must be succeeded or absent-accepted");
  }
  const verifiedApprovalRecord = approvalRecord(p["approval_record"]);
  return {
    digest: digest(value["digest"], "authorization digest"),
    object_type: BASELINE_MIGRATION_AUTHORIZATION_OBJECT_TYPE,
    payload: {
      approval_record: verifiedApprovalRecord,
      approved_at: timestamp(p["approved_at"], "approved_at"),
      approved_by: text(p["approved_by"], "approved_by"),
      baseline_artifact_tree_digest: digest(p["baseline_artifact_tree_digest"], "baseline_artifact_tree_digest"),
      baseline_candidate_digest: digest(p["baseline_candidate_digest"], "baseline_candidate_digest"),
      baseline_release_digest: digest(p["baseline_release_digest"], "baseline_release_digest"),
      canonical_alias: alias(p["canonical_alias"], "canonical_alias"),
      candidate_artifact_tree_digest: digest(p["candidate_artifact_tree_digest"], "candidate_artifact_tree_digest"),
      candidate_release_digest: digest(p["candidate_release_digest"], "candidate_release_digest"),
      hub_id: text(p["hub_id"], "hub_id"),
      legacy_deployment_checks: p["legacy_deployment_checks"],
      migration_source_commit: commitSha(p["migration_source_commit"], "migration_source_commit"),
      predecessor_deployment_id: deploymentId(p["predecessor_deployment_id"], "predecessor_deployment_id"),
      predecessor_source_commit: commitSha(p["predecessor_source_commit"], "predecessor_source_commit"),
      production_branch: text(p["production_branch"], "production_branch"),
      publisher: publisher(p["publisher"]),
      reviewed_runtime_commit: commitSha(p["reviewed_runtime_commit"], "reviewed_runtime_commit"),
      runtime_vercel_config_digest: digest(p["runtime_vercel_config_digest"], "runtime_vercel_config_digest"),
      scope: BASELINE_MIGRATION_SCOPE,
    },
    schema_version: BASELINE_MIGRATION_AUTHORIZATION_SCHEMA_VERSION,
  };
}

export function createBaselineMigrationAuthorization(payload: BaselineMigrationAuthorizationPayload): BaselineMigrationAuthorization {
  const raw = createEnvelope({
    object_type: BASELINE_MIGRATION_AUTHORIZATION_OBJECT_TYPE,
    payload,
    schema_version: BASELINE_MIGRATION_AUTHORIZATION_SCHEMA_VERSION,
  });
  return verifyBaselineMigrationAuthorization(raw);
}

export interface BaselineMigrationObservation {
  readonly team_id: string;
  readonly project_id: string;
  readonly production_branch: string;
  /** Vercel project name, used only to recognize generated aliases. */
  readonly project_name?: string;
  /** Immutable Git ref of the live deployment, when Vercel reports it. */
  readonly deployment_source_ref?: string;
  readonly canonical_alias: string;
  readonly git_production_auto_deploy: boolean;
  /** Exact runtime-config evidence when the project API omits the field. */
  readonly git_auto_deploy_control?: GitAutoDeployControl;
  readonly production_aliases: readonly string[];
  readonly alias_target_deployment_id: string;
  readonly served_deployment_id: string;
  readonly deployment_ready_state: string;
  readonly deployment_checks_state: "succeeded" | "failed" | "pending" | "none";
  /** Vercel's immutable source-commit metadata for the serving deployment. */
  readonly deployment_source_commit: string;
  /** Shape of the live /readyz response; only "legacy" is migratable. */
  readonly legacy_readyz: "legacy" | "digest" | "unavailable";
  readonly served_release_digest?: string;
}

export interface BaselineMigrationExpectation {
  readonly team_id: string;
  readonly project_id: string;
  readonly production_branch: string;
  readonly canonical_alias: string;
  readonly predecessor_deployment_id: string;
  readonly predecessor_release_digest: string;
  readonly baseline_candidate_digest: string;
  readonly baseline_artifact_tree_digest: string;
  readonly candidate_artifact_tree_digest: string;
  readonly candidate_release_digest: string;
  readonly predecessor_source_commit: string;
  readonly reviewed_runtime_commit: string;
  readonly migration_source_commit: string;
  /** Same as migration_source_commit; used for config-control binding. */
  readonly runtime_source_commit?: string;
  readonly runtime_vercel_config_digest: string;
  readonly legacy_deployment_checks: "succeeded" | "absent-accepted";
  readonly publisher_vercel_user_id: string;
  readonly now: string;
  readonly max_approval_age_ms: number;
}

export type BaselineMigrationBlockerCode =
  | "E_BASELINE_AUTHORIZATION_INVALID"
  | "E_BASELINE_AUTHORIZATION_STALE"
  | "E_BASELINE_IDENTITY_MISMATCH"
  | "E_BASELINE_SOURCE_MISMATCH"
  | "E_BASELINE_PREDECESSOR_MISMATCH"
  | "E_BASELINE_LEGACY_STATE"
  | "E_BASELINE_PLATFORM_GUARD"
  | "E_BASELINE_DEPLOYMENT_NOT_READY"
  | "E_BASELINE_CHECKS_NOT_PASSED";

export interface BaselineMigrationAssessment {
  readonly status: "READY" | "BLOCKED";
  readonly blockers: readonly { readonly code: BaselineMigrationBlockerCode; readonly message: string }[];
  readonly authorization_digest: string;
  readonly release_digest: string;
  readonly candidate_digest: string;
  readonly artifact_tree_digest: string;
}

/**
 * Pure baseline-migration gate. The migration is legitimate only when every
 * one of these is simultaneously true:
 *
 *   * the owner authorized exactly this migration source, predecessor source,
 *     candidate, artifact tree and publisher;
 *   * the live alias targets the recorded legacy deployment, that deployment
 *     is READY with successful checks, and its immutable source commit is the
 *     recorded predecessor commit;
 *   * the live `/readyz` is the legacy shape. A runtime that already reports a
 *     digest must use the normal publisher, and an unavailable probe is not
 *     evidence;
 *   * Git production auto-deploy is disabled and every production alias is
 *     either the canonical alias or a narrowly recognized, direct Vercel
 *     automatic alias on the same deployment.
 *
 * A missing or substituted fact blocks; no optional field is inferred.
 */
export function assessBaselineMigration(input: {
  readonly authorization: unknown;
  readonly observation: BaselineMigrationObservation;
  readonly expected: BaselineMigrationExpectation;
}): BaselineMigrationAssessment {
  const blockers: { code: BaselineMigrationBlockerCode; message: string }[] = [];
  const block = (code: BaselineMigrationBlockerCode, message: string) => blockers.push({ code, message });
  const expected = input.expected;
  const observed = input.observation;

  let authorization: BaselineMigrationAuthorization | undefined;
  try {
    authorization = verifyBaselineMigrationAuthorization(input.authorization);
  } catch (error) {
    block("E_BASELINE_AUTHORIZATION_INVALID", error instanceof Error ? error.message : String(error));
  }

  if (authorization) {
    const p = authorization.payload;
    if (p.hub_id !== "personal") block("E_BASELINE_IDENTITY_MISMATCH", "baseline migration Hub is not the retained personal Hub");
    if (p.baseline_release_digest !== expected.predecessor_release_digest) block("E_BASELINE_PREDECESSOR_MISMATCH", "authorization baseline release is not the expected predecessor release");
    if (p.baseline_candidate_digest !== expected.baseline_candidate_digest) block("E_BASELINE_SOURCE_MISMATCH", "authorization candidate does not match the retained candidate");
    if (p.baseline_artifact_tree_digest !== expected.baseline_artifact_tree_digest) block("E_BASELINE_SOURCE_MISMATCH", "authorization artifact tree does not match the retained artifact");
    if (p.candidate_artifact_tree_digest !== expected.candidate_artifact_tree_digest) block("E_BASELINE_SOURCE_MISMATCH", "authorization runtime artifact tree does not match the untouched main candidate");
    if (p.candidate_release_digest !== expected.candidate_release_digest) block("E_BASELINE_SOURCE_MISMATCH", "authorization runtime release does not match the approved main candidate");
    if (p.runtime_vercel_config_digest !== expected.runtime_vercel_config_digest) block("E_BASELINE_SOURCE_MISMATCH", "authorization runtime Vercel config digest does not match");
    if (p.predecessor_source_commit !== expected.predecessor_source_commit) block("E_BASELINE_SOURCE_MISMATCH", "authorization predecessor source commit does not match");
    if (p.reviewed_runtime_commit !== expected.reviewed_runtime_commit) block("E_BASELINE_SOURCE_MISMATCH", "authorization reviewed runtime commit does not match");
    if (p.migration_source_commit !== expected.migration_source_commit) block("E_BASELINE_SOURCE_MISMATCH", "authorization migration source commit does not match");
    if (p.migration_source_commit !== p.reviewed_runtime_commit) block("E_BASELINE_SOURCE_MISMATCH", "authorization migration source is not the exact reviewed runtime commit");
    if (p.legacy_deployment_checks !== expected.legacy_deployment_checks) block("E_BASELINE_CHECKS_NOT_PASSED", "authorization legacy check policy does not match the target");
    if (p.predecessor_deployment_id !== expected.predecessor_deployment_id) block("E_BASELINE_PREDECESSOR_MISMATCH", "authorization predecessor deployment does not match");
    if (p.canonical_alias !== expected.canonical_alias) block("E_BASELINE_IDENTITY_MISMATCH", "authorization canonical alias does not match");
    if (p.production_branch !== expected.production_branch) block("E_BASELINE_IDENTITY_MISMATCH", "authorization production branch does not match");
    if (p.publisher.team_id !== expected.team_id || p.publisher.project_id !== expected.project_id) block("E_BASELINE_IDENTITY_MISMATCH", "authorization publisher team/project does not match the target");
    if (p.publisher.vercel_user_id !== expected.publisher_vercel_user_id) block("E_BASELINE_IDENTITY_MISMATCH", "executing Vercel identity is not the approved publisher");
    if (p.approved_by !== p.publisher.owner_subject) block("E_BASELINE_IDENTITY_MISMATCH", "authorization actor and publisher owner differ");
    const approvedAt = Date.parse(p.approved_at);
    const now = Date.parse(expected.now);
    if (!Number.isFinite(now)) fail("expected.now is not a timestamp");
    if (approvedAt > now + 5 * 60_000) block("E_BASELINE_AUTHORIZATION_STALE", "authorization timestamp is in the future");
    else if (now - approvedAt > expected.max_approval_age_ms) block("E_BASELINE_AUTHORIZATION_STALE", "authorization is older than the accepted window");
  }

  if (observed.team_id !== expected.team_id) block("E_BASELINE_IDENTITY_MISMATCH", "Vercel team identity mismatch");
  if (observed.project_id !== expected.project_id) block("E_BASELINE_IDENTITY_MISMATCH", "Vercel project identity mismatch");
  if (observed.production_branch !== expected.production_branch) block("E_BASELINE_IDENTITY_MISMATCH", "Vercel production branch mismatch");
  if (observed.canonical_alias !== expected.canonical_alias) block("E_BASELINE_PLATFORM_GUARD", "canonical production alias mismatch");
  if (observed.alias_target_deployment_id !== expected.predecessor_deployment_id) block("E_BASELINE_PREDECESSOR_MISMATCH", "production alias does not target the recorded legacy deployment");
  if (observed.served_deployment_id !== expected.predecessor_deployment_id) block("E_BASELINE_PREDECESSOR_MISMATCH", "the deployment that answered the probe is not the recorded legacy deployment");
  if (observed.deployment_source_commit !== expected.predecessor_source_commit) block("E_BASELINE_SOURCE_MISMATCH", "the serving deployment's immutable source commit is not the recorded predecessor commit");
  if (observed.legacy_readyz !== "legacy") {
    block("E_BASELINE_LEGACY_STATE", observed.legacy_readyz === "digest"
      ? "the live runtime already reports a release digest; use the normal publisher"
      : "the live runtime is not the exact legacy readiness shape; 200 alone is not predecessor proof");
  }
  if (observed.served_release_digest !== undefined) block("E_BASELINE_LEGACY_STATE", "legacy readiness must not carry a release digest");
  if (!gitAutoDeployIsDisabled(observed, { runtime_source_commit: expected.runtime_source_commit ?? expected.migration_source_commit, runtime_vercel_config_digest: expected.runtime_vercel_config_digest })) {
    block("E_BASELINE_PLATFORM_GUARD", "Vercel Git auto-deploy is not observably disabled for the production branch");
  }
  if (!productionAliasesAreRecognized(observed.production_aliases, observedAliasContext(observed, expected.canonical_alias), expected.canonical_alias)) {
    block("E_BASELINE_PLATFORM_GUARD", "a production alias is unknown, redirected, duplicated or outside the recognized Vercel-managed set");
  }
  if (observed.deployment_ready_state !== "READY") block("E_BASELINE_DEPLOYMENT_NOT_READY", "the legacy deployment is not READY");
  if (expected.legacy_deployment_checks === "succeeded") {
    if (observed.deployment_checks_state !== "succeeded") block("E_BASELINE_CHECKS_NOT_PASSED", "the legacy deployment checks have not concluded successfully");
  } else if (observed.deployment_checks_state !== "none") {
    block("E_BASELINE_CHECKS_NOT_PASSED", "the legacy deployment checks are present but not successful; absent-accepted does not accept failed or pending checks");
  }

  return {
    artifact_tree_digest: expected.baseline_artifact_tree_digest,
    authorization_digest: authorization?.digest ?? "",
    blockers,
    candidate_digest: expected.baseline_candidate_digest,
    release_digest: expected.predecessor_release_digest,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
  };
}

export interface BaselineMigrationReceiptPayload {
  readonly action: "BASELINE_RUNTIME_MIGRATION";
  readonly status: "SUCCEEDED" | "FAILED";
  readonly hub_id: string;
  readonly release_digest: string;
  readonly candidate_digest: string;
  readonly artifact_tree_digest: string;
  readonly predecessor_deployment_id: string;
  readonly deployment_id: string;
  readonly predecessor_source_commit: string;
  readonly migration_source_commit: string;
  readonly authorization_digest: string;
  readonly canonical_alias: string;
  readonly actor: PublicationPublisher;
  readonly completed_at: string;
  readonly detail: string;
}

export type BaselineMigrationReceipt = {
  readonly object_type: typeof BASELINE_MIGRATION_RECEIPT_OBJECT_TYPE;
  readonly schema_version: typeof BASELINE_MIGRATION_RECEIPT_SCHEMA_VERSION;
  readonly payload: BaselineMigrationReceiptPayload;
  readonly digest: string;
};

export function createBaselineMigrationReceipt(payload: BaselineMigrationReceiptPayload): BaselineMigrationReceipt {
  return createEnvelope({
    object_type: BASELINE_MIGRATION_RECEIPT_OBJECT_TYPE,
    payload,
    schema_version: BASELINE_MIGRATION_RECEIPT_SCHEMA_VERSION,
  }) as BaselineMigrationReceipt;
}

export function verifyBaselineMigrationReceipt(value: unknown): BaselineMigrationReceipt {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isObject(value) || value["object_type"] !== BASELINE_MIGRATION_RECEIPT_OBJECT_TYPE ||
      value["schema_version"] !== BASELINE_MIGRATION_RECEIPT_SCHEMA_VERSION) {
    fail(`baseline migration receipt is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  exactKeys(value, ["digest", "object_type", "payload", "schema_version"], "baseline migration receipt envelope");
  if (!isObject(value["payload"])) fail("baseline migration receipt payload must be an object");
  const p = value["payload"];
  exactKeys(p, [
    "action",
    "actor",
    "artifact_tree_digest",
    "authorization_digest",
    "canonical_alias",
    "completed_at",
    "candidate_digest",
    "deployment_id",
    "detail",
    "hub_id",
    "migration_source_commit",
    "predecessor_deployment_id",
    "predecessor_source_commit",
    "release_digest",
    "status",
  ], "baseline migration receipt payload");
  if (p["action"] !== "BASELINE_RUNTIME_MIGRATION") fail("baseline migration receipt action is invalid");
  if (p["status"] !== "SUCCEEDED" && p["status"] !== "FAILED") fail("baseline migration receipt status is invalid");
  return {
    digest: digest(value["digest"], "receipt digest"),
    object_type: BASELINE_MIGRATION_RECEIPT_OBJECT_TYPE,
    payload: {
      action: "BASELINE_RUNTIME_MIGRATION",
      actor: publisher(p["actor"]),
      artifact_tree_digest: digest(p["artifact_tree_digest"], "artifact_tree_digest"),
      authorization_digest: digest(p["authorization_digest"], "authorization_digest"),
      canonical_alias: alias(p["canonical_alias"], "canonical_alias"),
      candidate_digest: digest(p["candidate_digest"], "candidate_digest"),
      completed_at: timestamp(p["completed_at"], "completed_at"),
      deployment_id: deploymentId(p["deployment_id"], "deployment_id"),
      detail: text(p["detail"], "detail"),
      hub_id: text(p["hub_id"], "hub_id"),
      migration_source_commit: commitSha(p["migration_source_commit"], "migration_source_commit"),
      predecessor_deployment_id: deploymentId(p["predecessor_deployment_id"], "predecessor_deployment_id"),
      predecessor_source_commit: commitSha(p["predecessor_source_commit"], "predecessor_source_commit"),
      release_digest: digest(p["release_digest"], "release_digest"),
      status: p["status"],
    },
    schema_version: BASELINE_MIGRATION_RECEIPT_SCHEMA_VERSION,
  };
}
