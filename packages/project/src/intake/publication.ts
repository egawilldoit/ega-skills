// Contract E2: publication preflight.
//
// A build may inspect adopted content without review metadata. Publication
// may not: this read-only preflight compares the exact catalog produced by a
// fresh Hub build with the latest append-only review for every Skill ID. It
// reports blockers instead of silently dropping unapproved content.

import { canonicalizeJson, createEnvelope, hashBytes, type ArtifactEnvelope } from "@ega-skills/hashing";
import { buildHub, type HubBuildResult } from "../hub/builder.js";
import { HubError } from "../hub/errors.js";
import { latestReviews, type ReviewRecordDocument } from "./review-store.js";

export const PUBLICATION_OBJECT_TYPE = "ega.publication-preflight" as const;
export const PUBLICATION_SCHEMA_VERSION = 1 as const;

export type PublicationStatus = "READY" | "BLOCKED";

export interface PublicationReview {
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
  readonly schema_version: 1;
  readonly payload: PublicationPreflightPayload;
};

function reviewProjection(record: ReviewRecordDocument): PublicationReview {
  return {
    decision: record.payload.decision,
    revision: record.payload.revision,
    review_digest: record.digest,
    skill_id: record.payload.skill_id,
    version_hash: record.payload.version_hash,
  };
}

function fail(message: string): never {
  throw new HubError("E_PUBLICATION", `E_PUBLICATION: ${message}`);
}

function sortedSkills(build: HubBuildResult): HubBuildResult["skills"] {
  return [...build.skills].sort((left, right) => left.skillId.localeCompare(right.skillId));
}

/** Build the exact current catalog and check every entry against review CAS state. */
export async function preflightPublication(hubDir: string): Promise<PublicationPreflightDocument> {
  const build = await buildHub(hubDir);
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
    approval_set_digest: hashBytes(canonicalizeJson(reviews.map((review) => ({
      decision: review.decision,
      revision: review.revision,
      review_digest: review.review_digest,
      skill_id: review.skill_id,
      version_hash: review.version_hash,
    })).sort((left, right) => left.skill_id.localeCompare(right.skill_id)))),
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
