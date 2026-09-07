// 1.1[G] immutable HubRelease and publication state (EGA-629).
//
// The semantic envelope is deliberately separate from deployment artifacts:
// SQLite bytes, URLs, timestamps, and machine paths can change without
// changing the release identity.  Only the frozen Contract C payload enters
// the JCS/SHA-256 envelope.

import { canonicalizeJson, createEnvelope, sha256Hex, type ArtifactEnvelope } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import type { HubBuildResult, HubBuildSource } from "./builder.js";
import {
  checkAliasMap,
  checkSearchIndexInput,
  checkTokenArtifact,
  deriveAliasMap,
  deriveSearchIndexInput,
  deriveTokenArtifact,
  RELEASE_TOKEN_ESTIMATOR,
  type AliasMapDoc,
  type SearchIndexInputDoc,
  type TokenArtifactDoc,
} from "./release-state.js";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export interface HubReleaseContracts {
  readonly schema: string;
  readonly hashing: number;
  readonly router: number;
  readonly search: number;
  readonly token_estimator: typeof RELEASE_TOKEN_ESTIMATOR;
  readonly importer_build: number;
  readonly hub_contract: string;
  readonly update_contract: string;
  readonly build_contract: string;
}

export interface HubReleaseSource {
  readonly source_id: string;
  readonly source_config_digest: string;
  readonly resolved_commit: string;
  readonly selected_skill_tree_digest: string;
  readonly vendored_snapshot_digest: string;
}

export interface HubReleasePayload {
  readonly hub_id: string;
  readonly skill_versions: Readonly<Record<string, string>>;
  readonly alias_map_digest: string;
  readonly search_index_input_digest: string;
  readonly token_artifact_digest: string;
  readonly adopted_sources: readonly HubReleaseSource[];
  readonly contracts: HubReleaseContracts;
  readonly build: {
    readonly fresh_registry: true;
    readonly import_failures: 0;
    readonly expected_catalog_match: true;
  };
}

export type HubRelease = ArtifactEnvelope & {
  readonly object_type: "ega.hub-release";
  readonly schema_version: 1;
  readonly payload: HubReleasePayload;
};

export interface ReleaseArtifacts {
  readonly aliasMap: AliasMapDoc;
  readonly searchIndexInput: SearchIndexInputDoc;
  readonly tokenArtifact: TokenArtifactDoc;
}

export interface ReleasePackage {
  readonly hub_release_digest: string;
  readonly sqlite_artifact_digest: string;
  readonly snapshot_rows: number;
}

export interface StablePointer {
  readonly hub_id: string;
  readonly stable_release_digest: string;
  readonly cas_version: number;
}

export const DEFAULT_RELEASE_CONTRACTS: HubReleaseContracts = Object.freeze({
  build_contract: "C1",
  hashing: 1,
  hub_contract: "A1",
  importer_build: 1,
  router: 1,
  schema: "v1.0.1",
  search: 1,
  token_estimator: RELEASE_TOKEN_ESTIMATOR,
  update_contract: "B1",
});

function digestJson(value: unknown): string {
  return `sha256:${sha256Hex(canonicalizeJson(value))}`;
}

function fail(code: "E_RELEASE_SCHEMA" | "E_RELEASE_DIGEST" | "E_PACKAGE_BINDING" | "E_STABLE" | "E_BUILD_ATTESTATION", message: string): never {
  throw new HubError(code, message);
}

function sourceForRelease(source: HubBuildSource): HubReleaseSource {
  return {
    resolved_commit: source.resolvedCommit,
    selected_skill_tree_digest: source.selectedSkillTreeDigest,
    source_config_digest: source.sourceConfigDigest,
    source_id: source.sourceId,
    vendored_snapshot_digest: source.vendoredSnapshotDigest,
  };
}

function checkDigest(value: unknown, field: string, code: "E_RELEASE_SCHEMA" | "E_RELEASE_DIGEST" | "E_PACKAGE_BINDING" | "E_STABLE"): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(code, `${field} must match sha256:<64 lowercase hex>`);
}

function checkReleasePayload(payload: unknown): asserts payload is HubReleasePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail("E_RELEASE_SCHEMA", "HubRelease payload must be an object");
  const value = payload as Record<string, unknown>;
  const allowed = [
    "hub_id",
    "skill_versions",
    "alias_map_digest",
    "search_index_input_digest",
    "token_artifact_digest",
    "adopted_sources",
    "contracts",
    "build",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...allowed].sort())) {
    fail("E_RELEASE_SCHEMA", "HubRelease payload has unknown or missing fields");
  }
  if (typeof value["hub_id"] !== "string" || value["hub_id"].length === 0) fail("E_RELEASE_SCHEMA", "hub_id must be non-empty");
  if (value["skill_versions"] === null || typeof value["skill_versions"] !== "object" || Array.isArray(value["skill_versions"])) {
    fail("E_RELEASE_SCHEMA", "skill_versions must be a mapping");
  }
  const versions = value["skill_versions"] as Record<string, unknown>;
  for (const [skillId, version] of Object.entries(versions)) checkDigest(version, `skill_versions.${skillId}`, "E_RELEASE_SCHEMA");
  checkDigest(value["alias_map_digest"], "alias_map_digest", "E_RELEASE_SCHEMA");
  checkDigest(value["search_index_input_digest"], "search_index_input_digest", "E_RELEASE_SCHEMA");
  checkDigest(value["token_artifact_digest"], "token_artifact_digest", "E_RELEASE_SCHEMA");
  if (!Array.isArray(value["adopted_sources"])) fail("E_RELEASE_SCHEMA", "adopted_sources must be a list");
  let previous = "";
  for (const source of value["adopted_sources"] as unknown[]) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) fail("E_RELEASE_SCHEMA", "adopted source must be an object");
    const record = source as Record<string, unknown>;
    const keys = ["source_id", "source_config_digest", "resolved_commit", "selected_skill_tree_digest", "vendored_snapshot_digest"];
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) fail("E_RELEASE_SCHEMA", "adopted source has unknown or missing fields");
    if (typeof record["source_id"] !== "string" || record["source_id"].length === 0 || record["source_id"] <= previous) fail("E_RELEASE_SCHEMA", "adopted_sources must be sorted and unique");
    previous = record["source_id"] as string;
    for (const field of ["source_config_digest", "selected_skill_tree_digest", "vendored_snapshot_digest"])
      checkDigest(record[field], `adopted_sources.${record["source_id"]}.${field}`, "E_RELEASE_SCHEMA");
    if (typeof record["resolved_commit"] !== "string" || !/^[0-9a-f]{40}$/.test(record["resolved_commit"] as string))
      fail("E_RELEASE_SCHEMA", `adopted_sources.${record["source_id"]}.resolved_commit must be 40 lowercase hex`);
  }
  if (value["contracts"] === null || typeof value["contracts"] !== "object" || Array.isArray(value["contracts"])) fail("E_RELEASE_SCHEMA", "contracts must be an object");
  const contracts = value["contracts"] as Record<string, unknown>;
  if (JSON.stringify(Object.keys(contracts).sort()) !== JSON.stringify(Object.keys(DEFAULT_RELEASE_CONTRACTS).sort())) fail("E_RELEASE_SCHEMA", "contracts has unknown or missing fields");
  if (contracts["token_estimator"] !== RELEASE_TOKEN_ESTIMATOR) fail("E_RELEASE_SCHEMA", "contracts.token_estimator must be ega-o200k-v1");
  if (value["build"] === null || typeof value["build"] !== "object" || Array.isArray(value["build"])) fail("E_RELEASE_SCHEMA", "build must be an object");
  const build = value["build"] as Record<string, unknown>;
  if (build["fresh_registry"] !== true || build["import_failures"] !== 0 || build["expected_catalog_match"] !== true) fail("E_BUILD_ATTESTATION", "HubRelease build attestation is not complete");
}

function artifactsFor(build: HubBuildResult): ReleaseArtifacts {
  const aliasMap = deriveAliasMap(build);
  const tokenArtifact = deriveTokenArtifact(build);
  const searchIndexInput = deriveSearchIndexInput(build);
  validateArtifacts(build, { aliasMap, searchIndexInput, tokenArtifact });
  return { aliasMap, searchIndexInput, tokenArtifact };
}

function validateArtifacts(build: HubBuildResult, artifacts: ReleaseArtifacts): void {
  const { aliasMap, searchIndexInput, tokenArtifact } = artifacts;
  checkAliasMap(aliasMap, build);
  checkTokenArtifact(tokenArtifact, Object.fromEntries(build.skills.map((skill) => [skill.skillId, skill.versionHash])));
  checkSearchIndexInput(searchIndexInput, build);
}

/** Emit the semantic HubRelease only after all three release artifacts pass. */
export function createHubRelease(build: HubBuildResult, artifacts: ReleaseArtifacts = artifactsFor(build)): HubRelease {
  validateArtifacts(build, artifacts);
  const skillVersions: Record<string, string> = {};
  for (const skill of [...build.skills].sort((a, b) => (a.skillId < b.skillId ? -1 : 1))) skillVersions[skill.skillId] = skill.versionHash;
  const payload: HubReleasePayload = {
    adopted_sources: build.adoptedSources.map(sourceForRelease),
    alias_map_digest: digestJson(artifacts.aliasMap),
    build: { expected_catalog_match: true, fresh_registry: true, import_failures: 0 },
    contracts: DEFAULT_RELEASE_CONTRACTS,
    hub_id: build.hubId,
    search_index_input_digest: digestJson(artifacts.searchIndexInput),
    skill_versions: skillVersions,
    token_artifact_digest: digestJson(artifacts.tokenArtifact),
  };
  return createEnvelope({ object_type: "ega.hub-release", payload, schema_version: 1 }) as HubRelease;
}

/** Verify the envelope and its semantic bindings against the exact artifacts. */
export function verifyHubRelease(release: unknown, artifacts?: ReleaseArtifacts): asserts release is HubRelease {
  if (release === null || typeof release !== "object" || Array.isArray(release)) fail("E_RELEASE_SCHEMA", "HubRelease must be an object");
  const value = release as Record<string, unknown>;
  if (value["object_type"] !== "ega.hub-release" || value["schema_version"] !== 1) fail("E_RELEASE_SCHEMA", "HubRelease envelope type/version mismatch");
  const expected = createEnvelope({ object_type: "ega.hub-release", payload: value["payload"], schema_version: 1 });
  if (value["digest"] !== expected.digest) fail("E_RELEASE_DIGEST", `HubRelease digest mismatch (want ${expected.digest})`);
  checkReleasePayload(value["payload"]);
  if (artifacts) {
    const payload = value["payload"] as HubReleasePayload;
    if (payload.alias_map_digest !== digestJson(artifacts.aliasMap)) fail("E_RELEASE_DIGEST", "alias_map_digest does not bind the supplied artifact");
    if (payload.search_index_input_digest !== digestJson(artifacts.searchIndexInput)) fail("E_RELEASE_DIGEST", "search_index_input_digest does not bind the supplied artifact");
    if (payload.token_artifact_digest !== digestJson(artifacts.tokenArtifact)) fail("E_RELEASE_DIGEST", "token_artifact_digest does not bind the supplied artifact");
  }
}

/** Artifact metadata is intentionally outside semantic HubRelease identity. */
export function createReleasePackage(release: HubRelease, sqliteArtifactDigest: string, snapshotRows: number): ReleasePackage {
  verifyHubRelease(release);
  checkDigest(sqliteArtifactDigest, "sqlite_artifact_digest", "E_PACKAGE_BINDING");
  if (!Number.isInteger(snapshotRows) || snapshotRows < 0) fail("E_PACKAGE_BINDING", "snapshot_rows must be a non-negative integer");
  const expectedRows = Object.keys(release.payload.skill_versions).length;
  if (snapshotRows !== expectedRows) fail("E_PACKAGE_BINDING", `snapshot_rows must equal the release catalog (${expectedRows})`);
  return { hub_release_digest: release.digest, sqlite_artifact_digest: sqliteArtifactDigest, snapshot_rows: snapshotRows };
}

export function createStablePointer(hubId: string, release: HubRelease, casVersion: number): StablePointer {
  verifyHubRelease(release);
  if (hubId !== release.payload.hub_id || !hubId) fail("E_STABLE", "stable pointer hub_id must match the release");
  if (!Number.isInteger(casVersion) || casVersion < 1) fail("E_STABLE", "cas_version must be a positive integer");
  return { cas_version: casVersion, hub_id: hubId, stable_release_digest: release.digest };
}

/** Compare-and-swap stable publication; versions are monotonic and cannot regress. */
export function casUpdateStable(current: StablePointer | undefined, candidate: StablePointer, expectedCasVersion = current?.cas_version ?? 0): StablePointer {
  if (current && current.cas_version !== expectedCasVersion) fail("E_STABLE", "stable pointer compare-and-swap precondition failed");
  if (candidate.cas_version !== expectedCasVersion + 1) fail("E_STABLE", "stable pointer cas_version must advance exactly once");
  if (current && current.hub_id !== candidate.hub_id) fail("E_STABLE", "stable pointer hub_id cannot change");
  checkDigest(candidate.stable_release_digest, "stable_release_digest", "E_STABLE");
  return candidate;
}

/** Rollback creates another monotonic CAS update to a verified release from
 * the caller's retained-release store. A digest string is not an authority. */
export function rollbackStable(current: StablePointer, retainedRelease: HubRelease, expectedCasVersion = current.cas_version): StablePointer {
  verifyHubRelease(retainedRelease);
  if (retainedRelease.payload.hub_id !== current.hub_id) fail("E_STABLE", "rollback release belongs to a different Hub");
  return casUpdateStable(
    current,
    { cas_version: current.cas_version + 1, hub_id: current.hub_id, stable_release_digest: retainedRelease.digest },
    expectedCasVersion,
  );
}

/** A release referenced by a lock/context/audit record is never eligible for pruning. */
export function isReleaseRetained(releaseDigest: string, references: readonly string[]): boolean {
  checkDigest(releaseDigest, "release digest", "E_STABLE");
  return references.includes(releaseDigest);
}
