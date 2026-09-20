// Contract E1: Hub-local, append-only intake review decisions.
//
// Review records are deliberately outside every content root. They identify
// the exact candidate digest, Skill ID, and version hash being reviewed; they
// do not mutate source bytes and an actor field is audit metadata, not an
// authority assertion. A Hub lock plus an expected revision gives reviewers
// compare-and-swap semantics without introducing a second database.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEnvelope, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { parseCanonicalSkillId } from "@ega-skills/registry";
import { HubError } from "../hub/errors.js";
import { acquireHubLock } from "../hub/apply.js";
import { requireReadableJournal, writeFileAtomic } from "../hub/journal.js";
import { SHA256_RE } from "../hub/guards.js";
import { verifyAdoptionPlan, type AdoptionCandidate, type AdoptionPlanDocument } from "./adoption-plan.js";

export const REVIEW_OBJECT_TYPE = "ega.intake-review" as const;
export const REVIEW_SCHEMA_VERSION = 1 as const;

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
}

interface ReviewCandidate {
  readonly candidate_digest: string;
  readonly candidate: AdoptionCandidate;
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

/** Read and verify the complete append-only review history. */
export function readReviewRecords(hubPath: string): readonly ReviewRecordDocument[] {
  const hubDir = resolve(hubPath);
  requireReadableJournal(hubDir);
  const records = reviewFiles(hubDir).map((path) => ({ path, record: verifyReview(readJson(path), path) }));
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
      if (stored !== reviewPath(hubDir, skillId, current.payload.revision)) fail(`review history path is invalid for ${skillId}`);
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

function candidateEntries(candidate: AdoptionPlanDocument): ReviewCandidate[] {
  const verified = verifyAdoptionPlan(candidate);
  if (verified.payload.status !== "READY") fail("only READY adoption plans can be reviewed");
  if (verified.payload.candidates.length === 0) fail("adoption plan contains no valid candidates");
  return verified.payload.candidates.map((entry) => ({ candidate: entry, candidate_digest: verified.digest }));
}

function currentRevision(latest: ReadonlyMap<string, ReviewRecordDocument>, skillId: string): number {
  return latest.get(skillId)?.payload.revision ?? 0;
}

/**
 * Append one decision per candidate in an exact A1 plan. The whole command
 * uses one CAS revision and either appends all records or none.
 */
export function writeCandidateReview(input: {
  readonly hubDir: string;
  readonly candidate: AdoptionPlanDocument;
  readonly decision: ReviewDecision;
  readonly expectedRevision: number;
  readonly actor?: string;
  readonly reason?: string;
}): ReviewWriteResult {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) fail("expected revision must be a non-negative integer");
  const entries = candidateEntries(input.candidate);
  const hubDir = resolve(input.hubDir);
  requireReadableJournal(hubDir);
  const lock = acquireHubLock(hubDir);
  try {
    const latest = latestReviews(hubDir);
    for (const entry of entries) {
      const revision = currentRevision(latest, entry.candidate.skill_id);
      if (revision !== input.expectedRevision) {
        throw new HubError("E_REVIEW", `E_REVIEW_STALE: ${entry.candidate.skill_id} expected revision ${input.expectedRevision}, current revision ${revision}`);
      }
    }
    const actor = input.actor ?? "local";
    const reason = input.reason ?? (input.decision === "APPROVED" ? "manual review" : "manual rejection");
    if (actor.length === 0 || actor.length > 256 || reason.length === 0 || reason.length > 4096) fail("actor or reason is invalid");
    const records: ReviewRecordDocument[] = [];
    for (const entry of entries) {
      const previous = latest.get(entry.candidate.skill_id);
      const payload: ReviewRecordPayload = {
        actor,
        candidate_digest: entry.candidate_digest,
        decision: input.decision,
        previous_review_digest: previous?.digest ?? null,
        reason,
        revision: (previous?.payload.revision ?? 0) + 1,
        skill_id: entry.candidate.skill_id,
        version_hash: entry.candidate.version_hash,
      };
      const record = createEnvelope({ object_type: REVIEW_OBJECT_TYPE, payload, schema_version: REVIEW_SCHEMA_VERSION }) as ReviewRecordDocument;
      const path = reviewPath(hubDir, entry.candidate.skill_id, payload.revision);
      if (existsSync(path)) throw new HubError("E_REVIEW", `E_REVIEW_CONFLICT: review record already exists at ${path}`);
      mkdirSync(reviewDirectory(hubDir, entry.candidate.skill_id), { recursive: true });
      writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      records.push(record);
    }
    return { records, revision: records[0]?.payload.revision ?? input.expectedRevision };
  } finally {
    lock.release();
  }
}

/** Require every exact candidate in a plan to have the matching approval. */
export function requireCandidateApproval(hubPath: string, candidate: AdoptionPlanDocument): void {
  const latest = latestReviews(hubPath);
  for (const entry of candidateEntries(candidate)) {
    const review = latest.get(entry.candidate.skill_id);
    if (review === undefined || review.payload.decision !== "APPROVED" || review.payload.candidate_digest !== entry.candidate_digest || review.payload.version_hash !== entry.candidate.version_hash) {
      fail(`candidate ${entry.candidate.skill_id}@${entry.candidate.version_hash} is not approved for ${entry.candidate_digest}`);
    }
  }
}
