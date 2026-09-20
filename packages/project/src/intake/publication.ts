// Contract E2: publication preflight.
//
// A build may inspect adopted content without review metadata. Publication
// may not: this read-only preflight compares the exact catalog produced by a
// fresh Hub build with the latest append-only review for every Skill ID. It
// reports blockers instead of silently dropping unapproved content.

import { canonicalizeJson, createEnvelope, hashBytes, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { buildHub, type HubBuildResult } from "../hub/builder.js";
import { HubError } from "../hub/errors.js";
import { latestReviews, type ReviewRecordDocument } from "./review-store.js";

export const PUBLICATION_OBJECT_TYPE = "ega.publication-preflight" as const;
export const PUBLICATION_SCHEMA_VERSION = 2 as const;

export type PublicationStatus = "READY" | "BLOCKED";

export interface PublicationReview {
  readonly candidate_digest: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly revision: number;
  readonly review_digest: string;
  readonly skill_id: string;
  readonly version_hash: string;
}

export interface PublicationBlocker {
  readonly code: "MISSING_APPROVAL" | "STALE_APPROVAL" | "REJECTED";
  readonly approved_version_hash: string | null;
  readonly review_digest: string | null;
  readonly skill_id: string;
  readonly expected_version_hash: string;
}

export interface PublicationPreflightPayload {
  readonly hub_id: string;
  readonly skill_versions: Readonly<Record<string, string>>;
  readonly reviews: readonly PublicationReview[];
  readonly blockers: readonly PublicationBlocker[];
  readonly approval_set_digest: string;
  readonly status: PublicationStatus;
}

export type PublicationPreflightDocument = ArtifactEnvelope & {
  readonly object_type: "ega.publication-preflight";
  readonly schema_version: 2;
  readonly payload: PublicationPreflightPayload;
};

function reviewProjection(record: ReviewRecordDocument): PublicationReview {
  return {
    candidate_digest: record.payload.candidate_digest,
    decision: record.payload.decision,
    revision: record.payload.revision,
    review_digest: record.digest,
    skill_id: record.payload.skill_id,
    version_hash: record.payload.version_hash,
  };
}

function approvalProjection(reviews: readonly PublicationReview[]): readonly unknown[] {
  return reviews.map((review) => ({
    candidate_digest: review.candidate_digest,
    decision: review.decision,
    revision: review.revision,
    review_digest: review.review_digest,
    skill_id: review.skill_id,
    version_hash: review.version_hash,
  })).sort((left, right) => (left as { skill_id: string }).skill_id.localeCompare((right as { skill_id: string }).skill_id));
}

export function approvalSetDigest(reviews: readonly PublicationReview[]): string {
  return hashBytes(canonicalizeJson(approvalProjection(reviews)));
}

function fail(message: string): never {
  throw new HubError("E_PUBLICATION", `E_PUBLICATION: ${message}`);
}

function sortedSkills(build: HubBuildResult): HubBuildResult["skills"] {
  return [...build.skills].sort((left, right) => left.skillId.localeCompare(right.skillId));
}

/** Build the exact current catalog and check every entry against review CAS state. */
export async function preflightPublication(hubDir: string, suppliedBuild?: HubBuildResult): Promise<PublicationPreflightDocument> {
  const build = suppliedBuild ?? await buildHub(hubDir);
  const latest = latestReviews(hubDir);
  const skills = sortedSkills(build);
  const skillVersions: Record<string, string> = {};
  const reviews: PublicationReview[] = [];
  const blockers: PublicationBlocker[] = [];
  for (const skill of skills) {
    skillVersions[skill.skillId] = skill.versionHash;
    const review = latest.get(skill.skillId);
    if (review !== undefined) reviews.push(reviewProjection(review));
    if (review === undefined) {
      blockers.push({
        approved_version_hash: null,
        code: "MISSING_APPROVAL",
        expected_version_hash: skill.versionHash,
        review_digest: null,
        skill_id: skill.skillId,
      });
    } else if (review.payload.version_hash !== skill.versionHash || review.payload.candidate_digest.length === 0) {
      blockers.push({
        approved_version_hash: review.payload.version_hash,
        code: "STALE_APPROVAL",
        expected_version_hash: skill.versionHash,
        review_digest: review.digest,
        skill_id: skill.skillId,
      });
    } else if (review.payload.decision !== "APPROVED") {
      blockers.push({
        approved_version_hash: review.payload.version_hash,
        code: "REJECTED",
        expected_version_hash: skill.versionHash,
        review_digest: review.digest,
        skill_id: skill.skillId,
      });
    }
  }
  const payload: PublicationPreflightPayload = {
    approval_set_digest: approvalSetDigest(reviews),
    blockers: blockers.sort((left, right) => left.skill_id.localeCompare(right.skill_id)),
    hub_id: build.hubId,
    reviews: reviews.sort((left, right) => left.skill_id.localeCompare(right.skill_id)),
    skill_versions: skillVersions,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
  };
  // `approval_set_digest` is a digest of the semantic review projection, not
  // a caller-supplied claim. The envelope binds the complete preflight too.
  if (payload.status === "BLOCKED" && payload.blockers.length === 0) fail("blocked preflight has no blockers");
  return createEnvelope({ object_type: PUBLICATION_OBJECT_TYPE, payload, schema_version: PUBLICATION_SCHEMA_VERSION }) as PublicationPreflightDocument;
}

/** Verify the immutable publication snapshot carried by a governed candidate. */
export function verifyPublicationPreflight(value: unknown): PublicationPreflightDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || value === null || typeof value !== "object" || Array.isArray(value) || (value as { object_type?: unknown }).object_type !== PUBLICATION_OBJECT_TYPE || (value as { schema_version?: unknown }).schema_version !== PUBLICATION_SCHEMA_VERSION) {
    fail(`preflight envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail("preflight payload is invalid");
  const p = payload as Record<string, unknown>;
  const expected = ["approval_set_digest", "blockers", "hub_id", "reviews", "skill_versions", "status"];
  if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(expected)) fail("preflight payload fields are invalid");
  if (typeof p.hub_id !== "string" || p.hub_id.length === 0 || (p.status !== "READY" && p.status !== "BLOCKED") || !/^sha256:[0-9a-f]{64}$/.test(String(p.approval_set_digest))) fail("preflight identity fields are invalid");
  if (p.skill_versions === null || typeof p.skill_versions !== "object" || Array.isArray(p.skill_versions)) fail("preflight skill_versions is invalid");
  for (const [skillId, versionHash] of Object.entries(p.skill_versions as Record<string, unknown>)) if (typeof skillId !== "string" || typeof versionHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(versionHash)) fail("preflight skill_versions contains an invalid entry");
  if (!Array.isArray(p.reviews) || !Array.isArray(p.blockers)) fail("preflight reviews or blockers are invalid");
  const reviews = p.reviews.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`preflight review ${index} is invalid`);
    const review = raw as Record<string, unknown>;
    if (JSON.stringify(Object.keys(review).sort()) !== JSON.stringify(["candidate_digest", "decision", "review_digest", "revision", "skill_id", "version_hash"])) fail(`preflight review ${index} fields are invalid`);
    if (typeof review.skill_id !== "string" || typeof review.candidate_digest !== "string" || typeof review.review_digest !== "string" || typeof review.version_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(review.candidate_digest) || !/^sha256:[0-9a-f]{64}$/.test(review.review_digest) || !/^sha256:[0-9a-f]{64}$/.test(review.version_hash) || !Number.isSafeInteger(review.revision) || (review.revision as number) < 1 || (review.decision !== "APPROVED" && review.decision !== "REJECTED")) fail(`preflight review ${index} values are invalid`);
    return review as unknown as PublicationReview;
  });
  if (JSON.stringify(reviews.map((review) => review.skill_id)) !== JSON.stringify([...reviews].sort((left, right) => left.skill_id.localeCompare(right.skill_id)).map((review) => review.skill_id))) fail("preflight reviews are not sorted");
  if (new Set(reviews.map((review) => review.skill_id)).size !== reviews.length) fail("preflight reviews contain duplicates");
  if (approvalSetDigest(reviews) !== p.approval_set_digest) fail("preflight approval_set_digest is invalid");
  const blockers = p.blockers as unknown[];
  for (const [index, raw] of blockers.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`preflight blocker ${index} is invalid`);
    const blocker = raw as Record<string, unknown>;
    if (JSON.stringify(Object.keys(blocker).sort()) !== JSON.stringify(["approved_version_hash", "code", "expected_version_hash", "review_digest", "skill_id"])) fail(`preflight blocker ${index} fields are invalid`);
    if (typeof blocker.skill_id !== "string" || typeof blocker.expected_version_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(blocker.expected_version_hash) || (blocker.review_digest !== null && (typeof blocker.review_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(blocker.review_digest))) || (blocker.approved_version_hash !== null && (typeof blocker.approved_version_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(blocker.approved_version_hash))) || !["MISSING_APPROVAL", "STALE_APPROVAL", "REJECTED"].includes(String(blocker.code))) fail(`preflight blocker ${index} values are invalid`);
  }
  const blockerIds = blockers.map((raw) => (raw as { skill_id: string }).skill_id);
  if (JSON.stringify(blockerIds) !== JSON.stringify([...blockerIds].sort()) || new Set(blockerIds).size !== blockerIds.length) fail("preflight blockers are not sorted and unique");
  if ((p.status === "READY" && blockers.length !== 0) || (p.status === "BLOCKED" && blockers.length === 0)) fail("preflight status does not match blockers");
  return value as unknown as PublicationPreflightDocument;
}
