// Contract R1: deterministic semantic release comparison.
//
// SQLite bytes and transport paths are deliberately absent. A release diff
// answers what changes in the immutable HubRelease identity, not how a build
// happened to be serialized on disk.

import { canonicalizeJson, createEnvelope, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import { verifyHubRelease, type HubRelease } from "./release.js";

export const RELEASE_DIFF_OBJECT_TYPE = "ega.release-diff" as const;
export const RELEASE_DIFF_SCHEMA_VERSION = 1 as const;

export interface ReleaseSkillUpdate {
  readonly skill_id: string;
  readonly previous_version_hash: string;
  readonly candidate_version_hash: string;
}

export interface ReleaseDiffPayload {
  readonly hub_id: string;
  readonly base_release_digest: string;
  readonly candidate_release_digest: string;
  readonly added_skill_ids: readonly string[];
  readonly removed_skill_ids: readonly string[];
  readonly updated_skills: readonly ReleaseSkillUpdate[];
  readonly artifact_changes: {
    readonly alias_map: boolean;
    readonly search_index_input: boolean;
    readonly token_artifact: boolean;
    readonly adopted_sources: boolean;
  };
  readonly status: "UNCHANGED" | "CHANGED";
}

export type ReleaseDiffDocument = ArtifactEnvelope & {
  readonly object_type: "ega.release-diff";
  readonly schema_version: 1;
  readonly payload: ReleaseDiffPayload;
};

export function verifyReleaseDiff(value: unknown): ReleaseDiffDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || value === null || typeof value !== "object" || Array.isArray(value) || (value as { object_type?: unknown }).object_type !== RELEASE_DIFF_OBJECT_TYPE || (value as { schema_version?: unknown }).schema_version !== RELEASE_DIFF_SCHEMA_VERSION) {
    throw new HubError("E_RELEASE_SCHEMA", `release diff: envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new HubError("E_RELEASE_SCHEMA", "release diff: payload is invalid");
  const p = payload as Record<string, unknown>;
  const expected = ["added_skill_ids", "artifact_changes", "base_release_digest", "candidate_release_digest", "hub_id", "removed_skill_ids", "status", "updated_skills"];
  if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(expected)) throw new HubError("E_RELEASE_SCHEMA", "release diff: payload fields are invalid");
  for (const field of ["base_release_digest", "candidate_release_digest"]) if (typeof p[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p[field] as string)) throw new HubError("E_RELEASE_SCHEMA", `release diff: ${field} is invalid`);
  if (typeof p.hub_id !== "string" || p.hub_id.length === 0 || (p.status !== "CHANGED" && p.status !== "UNCHANGED")) throw new HubError("E_RELEASE_SCHEMA", "release diff: identity is invalid");
  for (const field of ["added_skill_ids", "removed_skill_ids"]) {
    if (!Array.isArray(p[field]) || (p[field] as unknown[]).some((entry) => typeof entry !== "string")) throw new HubError("E_RELEASE_SCHEMA", `release diff: ${field} is invalid`);
    const ids = p[field] as string[];
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort()) || new Set(ids).size !== ids.length) throw new HubError("E_RELEASE_SCHEMA", `release diff: ${field} is not sorted and unique`);
  }
  if (!Array.isArray(p.updated_skills)) throw new HubError("E_RELEASE_SCHEMA", "release diff: updated_skills is invalid");
  const updates = p.updated_skills as unknown[];
  for (const [index, raw] of updates.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HubError("E_RELEASE_SCHEMA", `release diff: updated_skills[${index}] is invalid`);
    const update = raw as Record<string, unknown>;
    if (JSON.stringify(Object.keys(update).sort()) !== JSON.stringify(["candidate_version_hash", "previous_version_hash", "skill_id"]) || typeof update.skill_id !== "string" || typeof update.previous_version_hash !== "string" || typeof update.candidate_version_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(update.previous_version_hash) || !/^sha256:[0-9a-f]{64}$/.test(update.candidate_version_hash)) throw new HubError("E_RELEASE_SCHEMA", `release diff: updated_skills[${index}] is invalid`);
  }
  if (JSON.stringify(updates.map((entry) => (entry as { skill_id: string }).skill_id)) !== JSON.stringify([...updates].sort((left, right) => (left as { skill_id: string }).skill_id.localeCompare((right as { skill_id: string }).skill_id)).map((entry) => (entry as { skill_id: string }).skill_id))) throw new HubError("E_RELEASE_SCHEMA", "release diff: updated_skills is not sorted");
  const changes = p.artifact_changes;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes) || JSON.stringify(Object.keys(changes).sort()) !== JSON.stringify(["adopted_sources", "alias_map", "search_index_input", "token_artifact"]) || Object.values(changes as Record<string, unknown>).some((entry) => typeof entry !== "boolean")) throw new HubError("E_RELEASE_SCHEMA", "release diff: artifact_changes is invalid");
  return value as unknown as ReleaseDiffDocument;
}

function fail(message: string): never {
  throw new HubError("E_RELEASE_SCHEMA", `release diff: ${message}`);
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function sourcesDigest(release: HubRelease): string {
  return new TextDecoder().decode(canonicalizeJson(release.payload.adopted_sources));
}

/** Compare two already-verified semantic releases. */
export function createReleaseDiff(base: HubRelease, candidate: HubRelease): ReleaseDiffDocument {
  verifyHubRelease(base);
  verifyHubRelease(candidate);
  if (base.payload.hub_id !== candidate.payload.hub_id) fail("base and candidate belong to different Hubs");
  const baseIds = new Set(Object.keys(base.payload.skill_versions));
  const candidateIds = new Set(Object.keys(candidate.payload.skill_versions));
  const addedSkillIds = sortedIds([...candidateIds].filter((id) => !baseIds.has(id)));
  const removedSkillIds = sortedIds([...baseIds].filter((id) => !candidateIds.has(id)));
  const updatedSkills = sortedIds([...baseIds].filter((id) => candidateIds.has(id) && base.payload.skill_versions[id] !== candidate.payload.skill_versions[id]))
    .map((skillId) => ({
      candidate_version_hash: candidate.payload.skill_versions[skillId] as string,
      previous_version_hash: base.payload.skill_versions[skillId] as string,
      skill_id: skillId,
    }));
  const artifactChanges = {
    adopted_sources: sourcesDigest(base) !== sourcesDigest(candidate),
    alias_map: base.payload.alias_map_digest !== candidate.payload.alias_map_digest,
    search_index_input: base.payload.search_index_input_digest !== candidate.payload.search_index_input_digest,
    token_artifact: base.payload.token_artifact_digest !== candidate.payload.token_artifact_digest,
  } as const;
  const changed = base.digest !== candidate.digest || addedSkillIds.length > 0 || removedSkillIds.length > 0 || updatedSkills.length > 0 || Object.values(artifactChanges).some(Boolean);
  return createEnvelope({
    object_type: RELEASE_DIFF_OBJECT_TYPE,
    payload: {
      added_skill_ids: addedSkillIds,
      artifact_changes: artifactChanges,
      base_release_digest: base.digest,
      candidate_release_digest: candidate.digest,
      hub_id: base.payload.hub_id,
      removed_skill_ids: removedSkillIds,
      status: changed ? "CHANGED" : "UNCHANGED",
      updated_skills: updatedSkills,
    },
    schema_version: RELEASE_DIFF_SCHEMA_VERSION,
  }) as ReleaseDiffDocument;
}
