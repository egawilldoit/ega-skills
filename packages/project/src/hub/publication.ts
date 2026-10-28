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

export interface PublicationObservation {
  readonly team_id: string;
  readonly project_id: string;
  readonly production_branch: string;
  readonly canonical_alias: string;
  /** True when Vercel Git integration can deploy the production branch. */
  readonly git_production_auto_deploy: boolean;
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
      approval_record: text(p["approval_record"], "approval_record"),
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
  if (observed.git_production_auto_deploy) block("E_PLATFORM_GUARD", "Vercel Git auto-deploy is enabled for the production branch; staging would assign the public domain automatically");
  if (observed.production_aliases.length !== 1 || observed.production_aliases[0] !== expected.canonical_alias) block("E_PLATFORM_GUARD", "additional production aliases can reach the deployment outside this gate");
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
