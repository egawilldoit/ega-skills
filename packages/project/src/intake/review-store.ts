// Contract E1: Hub-local, append-only intake review decisions.
//
// Review records are deliberately outside every content root. They identify
// the exact candidate digest, Skill ID, and version hash being reviewed; they
// do not mutate source bytes and an actor field is audit metadata, not an
// authority assertion. A Hub lock plus an expected revision gives reviewers
// compare-and-swap semantics without introducing a second database.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeJson, createEnvelope, hashBytes, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { parseCanonicalSkillId } from "@ega-skills/registry";
import { HubError } from "../hub/errors.js";
import { acquireHubLock } from "../hub/apply.js";
import { requireReadableJournal, writeFileAtomic } from "../hub/journal.js";
import { SHA256_RE } from "../hub/guards.js";
import { readHubIntakeState, verifyAdoptionPlan, type AdoptionCandidate } from "./adoption-plan.js";
import { readReviewableCandidate, type IntakeCandidateDocument } from "./candidate.js";

export const REVIEW_OBJECT_TYPE = "ega.intake-review" as const;
export const REVIEW_SCHEMA_VERSION = 1 as const;
export const REVIEW_BATCH_OBJECT_TYPE = "ega.intake-review-batch" as const;
export const REVIEW_BATCH_SCHEMA_VERSION = 1 as const;

export type ReviewDecision = "APPROVED" | "REJECTED";

export interface ReviewRecordPayload {
  readonly candidate_digest: string;
  readonly skill_id: string;
  readonly version_hash: string;
  readonly decision: ReviewDecision;
  readonly revision: number;
  readonly previous_review_digest: string | null;
  readonly actor: string;
  readonly reason: string;
}

export type ReviewRecordDocument = ArtifactEnvelope & {
  readonly object_type: "ega.intake-review";
  readonly schema_version: 1;
  readonly payload: ReviewRecordPayload;
};

export interface ReviewWriteResult {
  readonly records: readonly ReviewRecordDocument[];
  readonly revision: number;
  readonly request_id: string;
}

export interface ReviewBatchDecision {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly expected_revision: number;
  readonly revision: number;
  readonly previous_review_digest: string | null;
  readonly decision: ReviewDecision;
}

export interface ReviewBatchPayload {
  readonly candidate_digest: string;
  readonly decisions: readonly ReviewBatchDecision[];
  readonly actor: string;
  readonly reason: string;
  readonly request_id: string;
}

export type ReviewBatchDocument = ArtifactEnvelope & {
  readonly object_type: typeof REVIEW_BATCH_OBJECT_TYPE;
  readonly schema_version: typeof REVIEW_BATCH_SCHEMA_VERSION;
  readonly payload: ReviewBatchPayload;
};

interface ReviewCandidate {
  readonly candidate_digest: string;
  readonly candidate: { readonly skill_id: string; readonly version_hash: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function fail(message: string): never {
  throw new HubError("E_REVIEW", `E_REVIEW: ${message}`);
}

function skillParts(skillId: string): { readonly namespace: string; readonly name: string } {
  try {
    return parseCanonicalSkillId(skillId);
  } catch (error) {
    fail(`invalid Skill ID ${skillId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function reviewDirectory(hubDir: string, skillId: string): string {
  const parts = skillParts(skillId);
  return join(resolve(hubDir), "intake", "approvals", parts.namespace, parts.name);
}

function reviewPath(hubDir: string, skillId: string, revision: number): string {
  return join(reviewDirectory(hubDir, skillId), `r${String(revision).padStart(6, "0")}.json`);
}

function batchDirectory(hubDir: string): string {
  return join(resolve(hubDir), "intake", "review-batches");
}

function batchPath(hubDir: string, requestId: string): string {
  return join(batchDirectory(hubDir), `b-${requestId}.json`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`review record ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyReview(value: unknown, path: string): ReviewRecordDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isRecord(value) || value.object_type !== REVIEW_OBJECT_TYPE || value.schema_version !== REVIEW_SCHEMA_VERSION) {
    fail(`${path} has an invalid review envelope: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!isRecord(payload) || !exactKeys(payload, ["candidate_digest", "skill_id", "version_hash", "decision", "revision", "previous_review_digest", "actor", "reason"])) {
    fail(`${path} has invalid review fields`);
  }
  if (typeof payload.candidate_digest !== "string" || !SHA256_RE.test(payload.candidate_digest)) fail(`${path} candidate_digest is invalid`);
  if (typeof payload.skill_id !== "string") fail(`${path} skill_id is invalid`);
  skillParts(payload.skill_id);
  if (typeof payload.version_hash !== "string" || !SHA256_RE.test(payload.version_hash)) fail(`${path} version_hash is invalid`);
  if (payload.decision !== "APPROVED" && payload.decision !== "REJECTED") fail(`${path} decision is invalid`);
  if (!Number.isInteger(payload.revision) || (payload.revision as number) < 1) fail(`${path} revision is invalid`);
  if (payload.previous_review_digest !== null && (typeof payload.previous_review_digest !== "string" || !SHA256_RE.test(payload.previous_review_digest))) {
    fail(`${path} previous_review_digest is invalid`);
  }
  if (typeof payload.actor !== "string" || payload.actor.length === 0 || payload.actor.length > 256) fail(`${path} actor is invalid`);
  if (typeof payload.reason !== "string" || payload.reason.length === 0 || payload.reason.length > 4096) fail(`${path} reason is invalid`);
  return value as unknown as ReviewRecordDocument;
}

function verifyBatch(value: unknown, path: string): ReviewBatchDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isRecord(value) || value.object_type !== REVIEW_BATCH_OBJECT_TYPE || value.schema_version !== REVIEW_BATCH_SCHEMA_VERSION) {
    fail(`${path} has an invalid review batch envelope: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!isRecord(payload) || !exactKeys(payload, ["candidate_digest", "decisions", "actor", "reason", "request_id"])) fail(`${path} has invalid review batch fields`);
  if (typeof payload.candidate_digest !== "string" || !SHA256_RE.test(payload.candidate_digest)) fail(`${path} candidate_digest is invalid`);
  if (typeof payload.actor !== "string" || payload.actor.length === 0 || payload.actor.length > 256) fail(`${path} actor is invalid`);
  if (typeof payload.reason !== "string" || payload.reason.length === 0 || payload.reason.length > 4096) fail(`${path} reason is invalid`);
  if (typeof payload.request_id !== "string" || !SHA256_RE.test(payload.request_id)) fail(`${path} request_id is invalid`);
  if (!Array.isArray(payload.decisions) || payload.decisions.length === 0) fail(`${path} decisions must be non-empty`);
  let previousSkill = "";
  for (const raw of payload.decisions) {
    if (!isRecord(raw) || !exactKeys(raw, ["skill_id", "version_hash", "expected_revision", "revision", "previous_review_digest", "decision"])) fail(`${path} has an invalid decision entry`);
    if (typeof raw.skill_id !== "string") fail(`${path} decision skill_id is invalid`);
    skillParts(raw.skill_id);
    if (raw.skill_id <= previousSkill) fail(`${path} decisions must be sorted and unique`);
    previousSkill = raw.skill_id;
    if (typeof raw.version_hash !== "string" || !SHA256_RE.test(raw.version_hash)) fail(`${path} decision version_hash is invalid`);
    if (!Number.isInteger(raw.expected_revision) || (raw.expected_revision as number) < 0) fail(`${path} decision expected_revision is invalid`);
    if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) fail(`${path} decision revision is invalid`);
    if (raw.previous_review_digest !== null && (typeof raw.previous_review_digest !== "string" || !SHA256_RE.test(raw.previous_review_digest))) fail(`${path} decision previous_review_digest is invalid`);
    if (raw.decision !== "APPROVED" && raw.decision !== "REJECTED") fail(`${path} decision decision is invalid`);
  }
  return value as unknown as ReviewBatchDocument;
}

function projectBatch(batch: ReviewBatchDocument, decision: ReviewBatchDecision): ReviewRecordDocument {
  const payload: ReviewRecordPayload = {
    actor: batch.payload.actor,
    candidate_digest: batch.payload.candidate_digest,
    decision: decision.decision,
    previous_review_digest: decision.previous_review_digest,
    reason: batch.payload.reason,
    revision: decision.revision,
    skill_id: decision.skill_id,
    version_hash: decision.version_hash,
  };
  // This is a committed projection identity, not a separately stored E1
  // envelope. Including the batch digest prevents a projection from being
  // confused with an independently authored review record.
  const identity = createEnvelope({
    object_type: "ega.intake-review-entry",
    payload: { batch_digest: batch.digest, entry: payload },
    schema_version: 1,
  });
  return { digest: identity.digest, object_type: REVIEW_OBJECT_TYPE, payload, schema_version: REVIEW_SCHEMA_VERSION };
}

function reviewFiles(hubDir: string): string[] {
  const root = join(resolve(hubDir), "intake", "approvals");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const namespace of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!namespace.isDirectory() || namespace.isSymbolicLink()) fail(`invalid review namespace directory ${namespace.name}`);
    const namespacePath = join(root, namespace.name);
    for (const name of readdirSync(namespacePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!name.isDirectory() || name.isSymbolicLink()) fail(`invalid review skill directory ${namespace.name}/${name.name}`);
      const skillPath = join(namespacePath, name.name);
      for (const record of readdirSync(skillPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!record.isFile() || record.isSymbolicLink() || !/^r[0-9]{6}\.json$/.test(record.name)) {
          fail(`invalid review record entry ${namespace.name}/${name.name}/${record.name}`);
        }
        files.push(join(skillPath, record.name));
      }
    }
  }
  return files;
}

function reviewBatchFiles(hubDir: string): string[] {
  const root = batchDirectory(hubDir);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".pending" || entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !/^b-[0-9a-f]{64}\.json$/.test(entry.name)) fail(`invalid review batch entry ${entry.name}`);
    files.push(join(root, entry.name));
  }
  return files;
}

/** Read and verify the complete append-only review history. */
export function readReviewRecords(hubPath: string): readonly ReviewRecordDocument[] {
  const hubDir = resolve(hubPath);
  requireReadableJournal(hubDir);
  const records = reviewFiles(hubDir).map((path) => ({ path, record: verifyReview(readJson(path), path) }));
  const batches = reviewBatchFiles(hubDir).flatMap((path) => {
    const batch = verifyBatch(readJson(path), path);
    return batch.payload.decisions.map((decision) => ({ path, record: projectBatch(batch, decision) }));
  });
  records.push(...batches);
  const bySkill = new Map<string, ReviewRecordDocument[]>();
  for (const { record } of records) {
    const list = bySkill.get(record.payload.skill_id) ?? [];
    list.push(record);
    bySkill.set(record.payload.skill_id, list);
  }
  for (const [skillId, list] of bySkill) {
    list.sort((left, right) => left.payload.revision - right.payload.revision);
    for (let index = 0; index < list.length; index += 1) {
      const current = list[index] as ReviewRecordDocument;
      const expectedRevision = index + 1;
      if (current.payload.revision !== expectedRevision) fail(`review history for ${skillId} is not contiguous`);
      const previous = list[index - 1];
      if (current.payload.previous_review_digest !== (previous?.digest ?? null)) fail(`review history for ${skillId} has a broken digest chain`);
      const stored = records.find(({ record }) => record === current)?.path;
      if (stored !== reviewPath(hubDir, skillId, current.payload.revision) && !stored?.startsWith(batchDirectory(hubDir))) fail(`review history path is invalid for ${skillId}`);
    }
  }
  return records.map(({ record }) => record).sort((left, right) => left.payload.skill_id.localeCompare(right.payload.skill_id) || left.payload.revision - right.payload.revision);
}

export function latestReviews(hubPath: string): ReadonlyMap<string, ReviewRecordDocument> {
  const latest = new Map<string, ReviewRecordDocument>();
  for (const record of readReviewRecords(hubPath)) {
    const previous = latest.get(record.payload.skill_id);
    if (previous === undefined || previous.payload.revision < record.payload.revision) latest.set(record.payload.skill_id, record);
  }
  return latest;
}

function candidateEntries(hubDir: string, candidate: IntakeCandidateDocument): ReviewCandidate[] {
  const view = readReviewableCandidate(candidate, hubDir);
  if (view.kind === "SOURCE_ADOPTION" && verifyAdoptionPlan(candidate).payload.status !== "READY") fail("only READY adoption plans can be reviewed");
  if (view.entries.length === 0) fail("candidate contains no valid entries");
  const entries = view.entries.map((entry) => ({ candidate: entry, candidate_digest: view.digest }));
  entries.sort((left, right) => left.candidate.skill_id.localeCompare(right.candidate.skill_id));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.candidate.skill_id === entries[index]?.candidate.skill_id) fail("candidate contains duplicate Skill IDs");
  }
  return entries;
}

function currentRevision(latest: ReadonlyMap<string, ReviewRecordDocument>, skillId: string): number {
  return latest.get(skillId)?.payload.revision ?? 0;
}

/**
 * Append one immutable batch decision for every candidate in an exact A1 plan.
 * The whole command uses per-skill CAS revisions and either commits all
 * projections or none.
 */
export function writeCandidateReview(input: {
  readonly hubDir: string;
  readonly candidate: IntakeCandidateDocument;
  readonly decision: ReviewDecision;
  readonly expectedRevision?: number;
  readonly expectedRevisions?: Readonly<Record<string, number>>;
  readonly actor?: string;
  readonly reason?: string;
  /** Test-only crash injection around the single batch rename. */
  readonly faultAfter?: "BEFORE_RENAME" | "AFTER_RENAME";
}): ReviewWriteResult {
  const hubDir = resolve(input.hubDir);
  const entries = candidateEntries(hubDir, input.candidate);
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) fail("expected revision must be a non-negative integer");
  if (input.expectedRevision !== undefined && input.expectedRevisions !== undefined) fail("expected-revision and expected-revisions are mutually exclusive");
  requireReadableJournal(hubDir);
  const lock = acquireHubLock(hubDir);
  try {
    const currentState = readHubIntakeState(hubDir);
    const candidateView = readReviewableCandidate(input.candidate, hubDir);
    if (candidateView.kind === "OWNED_DERIVATIVE" && candidateView.baseline_digest !== currentState.baselineDigest) fail("candidate baseline is stale");
    const latest = latestReviews(hubDir);
    const expected = new Map<string, number>();
    if (input.expectedRevisions !== undefined) {
      const keys = Object.keys(input.expectedRevisions).sort();
      const candidateKeys = entries.map((entry) => entry.candidate.skill_id);
      if (JSON.stringify(keys) !== JSON.stringify(candidateKeys)) fail("expected-revisions keys must exactly match candidate Skill IDs");
      for (const skillId of candidateKeys) {
        const revision = input.expectedRevisions[skillId];
        if (!Number.isInteger(revision) || (revision as number) < 0) fail(`expected revision for ${skillId} must be a non-negative integer`);
        expected.set(skillId, revision as number);
      }
    } else if (input.expectedRevision !== undefined) {
      for (const entry of entries) expected.set(entry.candidate.skill_id, input.expectedRevision);
    } else {
      fail("an expected revision is required");
    }
    const actor = input.actor ?? "local";
    const reason = input.reason ?? (input.decision === "APPROVED" ? "manual review" : "manual rejection");
    if (actor.length === 0 || actor.length > 256 || reason.length === 0 || reason.length > 4096) fail("actor or reason is invalid");
    const requestId = hashBytes(canonicalizeJson({
      actor,
      candidate_digest: entries[0]?.candidate_digest,
      decision: input.decision,
      entries: entries.map((entry) => ({ skill_id: entry.candidate.skill_id, version_hash: entry.candidate.version_hash, expected_revision: expected.get(entry.candidate.skill_id) })),
      reason,
    }));
    // A client may retry after losing the response to the atomic rename. The
    // deterministic request id makes that retry return the already committed
    // result without weakening CAS for a different request.
    for (const path of reviewBatchFiles(hubDir)) {
      const batch = verifyBatch(readJson(path), path);
      if (batch.payload.request_id === requestId) {
        const records = batch.payload.decisions.map((decision) => projectBatch(batch, decision));
        return { records, request_id: requestId, revision: records[0]?.payload.revision ?? 0 };
      }
    }
    for (const entry of entries) {
      const revision = currentRevision(latest, entry.candidate.skill_id);
      const expectedRevision = expected.get(entry.candidate.skill_id) as number;
      if (revision !== expectedRevision) {
        throw new HubError("E_REVIEW", `E_REVIEW_STALE: ${entry.candidate.skill_id} expected revision ${expectedRevision}, current revision ${revision}`);
      }
    }
    const decisions: ReviewBatchDecision[] = entries.map((entry) => {
      const previous = latest.get(entry.candidate.skill_id);
      return {
        decision: input.decision,
        previous_review_digest: previous?.digest ?? null,
        expected_revision: expected.get(entry.candidate.skill_id) as number,
        revision: (previous?.payload.revision ?? 0) + 1,
        skill_id: entry.candidate.skill_id,
        version_hash: entry.candidate.version_hash,
      };
    });
    const batch = createEnvelope({
      object_type: REVIEW_BATCH_OBJECT_TYPE,
      payload: {
        actor,
        candidate_digest: entries[0]?.candidate_digest as string,
        decisions,
        reason,
        request_id: requestId,
      } satisfies ReviewBatchPayload,
      schema_version: REVIEW_BATCH_SCHEMA_VERSION,
    }) as ReviewBatchDocument;
    const path = batchPath(hubDir, requestId.replace(/^sha256:/, ""));
    if (input.faultAfter === "BEFORE_RENAME") throw new Error("test fault before review batch rename");
    const batchRoot = batchDirectory(hubDir);
    mkdirSync(batchRoot, { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(batch, null, 2)}\n`);
    if (input.faultAfter === "AFTER_RENAME") throw new Error("test fault after review batch rename");
    const records = decisions.map((decision) => projectBatch(batch, decision));
    return { records, request_id: requestId, revision: records[0]?.payload.revision ?? 0 };
  } finally {
    lock.release();
  }
}

/** Require every exact candidate in a plan to have the matching approval. */
export function requireCandidateApproval(hubPath: string, candidate: IntakeCandidateDocument): void {
  const latest = latestReviews(hubPath);
  for (const entry of candidateEntries(resolve(hubPath), candidate)) {
    const review = latest.get(entry.candidate.skill_id);
    if (review === undefined || review.payload.decision !== "APPROVED" || review.payload.candidate_digest !== entry.candidate_digest || review.payload.version_hash !== entry.candidate.version_hash) {
      fail(`candidate ${entry.candidate.skill_id}@${entry.candidate.version_hash} is not approved for ${entry.candidate_digest}`);
    }
  }
}
