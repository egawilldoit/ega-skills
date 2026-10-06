// Contract R1: relocatable, immutable release candidates.
//
// A candidate contains the exact files produced by Contract C. Export copies
// those files only; it never fetches or rebuilds the Hub's moving sources.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { createEnvelope, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { getCacheBlob, getSkillVersion } from "@ega-skills/registry";
import { sha256Hex } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import { verifyReleaseProjection } from "./release-state.js";
import { createReleasePackage, verifyHubRelease, type HubRelease, type ReleaseArtifacts, type ReleasePackage } from "./release.js";
import { verifyReleaseDiff, type ReleaseDiffDocument } from "./release-diff.js";
import type { HubReleaseBuildResult } from "./release-build.js";
import { verifyPublicationPreflight, type PublicationPreflightDocument } from "../intake/publication.js";

export const RELEASE_CANDIDATE_OBJECT_TYPE = "ega.release-candidate" as const;
export const RELEASE_CANDIDATE_SCHEMA_VERSION = 2 as const;
export const LEGACY_RELEASE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_POLICY_REVISION = "R1-approval-v2" as const;

export interface PublicationBindings {
  readonly preflight_digest: string;
  readonly approval_set_digest: string;
  readonly previous_release_digest: string;
  readonly release_diff_digest: string;
  readonly publication_policy_revision: typeof PUBLICATION_POLICY_REVISION;
}

const CANDIDATE_FILES = Object.freeze({
  alias_map: "alias-map.json",
  cache: "cache/sha256",
  hub_release: "hub-release.json",
  registry: "registry.sqlite",
  release_package: "release-package.json",
  search_index_input: "search-index-input.json",
  token_artifact: "token-artifact.json",
});

const CANDIDATE_RECEIPTS = ["release-diff.json", "publication-preflight.json"] as const;

export interface ReleaseCandidatePayload {
  readonly hub_id: string;
  readonly release_digest: string;
  readonly sqlite_artifact_digest: string;
  readonly snapshot_rows: number;
  readonly fts_table: string;
  readonly files: typeof CANDIDATE_FILES;
  readonly publication: PublicationBindings;
}

export type ReleaseCandidateDocument = ArtifactEnvelope & {
  readonly object_type: "ega.release-candidate";
  readonly schema_version: 2;
  readonly payload: ReleaseCandidatePayload;
};

export interface LegacyReleaseCandidatePayload {
  readonly hub_id: string;
  readonly release_digest: string;
  readonly sqlite_artifact_digest: string;
  readonly snapshot_rows: number;
  readonly fts_table: string;
  readonly files: typeof CANDIDATE_FILES;
}

export type LegacyReleaseCandidateDocument = ArtifactEnvelope & {
  readonly object_type: "ega.release-candidate";
  readonly schema_version: 1;
  readonly payload: LegacyReleaseCandidatePayload;
};

export type AnyReleaseCandidateDocument = ReleaseCandidateDocument | LegacyReleaseCandidateDocument;

export interface VerifiedReleaseCandidate {
  readonly candidate: AnyReleaseCandidateDocument;
  readonly release: HubRelease;
  readonly releasePackage: ReleasePackage;
  readonly directory: string;
}

function fail(message: string): never {
  throw new HubError("E_PACKAGE_BINDING", `release candidate: ${message}`);
}

function json(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${name} has unknown or missing fields`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"));
}

function ensureFreshDestination(path: string): void {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isDirectory() || readdirSync(path).length > 0) fail(`destination must be a new empty directory: ${path}`);
  fail(`destination must not already exist: ${path}`);
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
    else fail(`candidate contains unsupported filesystem entry: ${from}`);
  }
}

function copyCandidateFiles(source: string, destination: string): void {
  for (const file of [CANDIDATE_FILES.alias_map, CANDIDATE_FILES.hub_release, CANDIDATE_FILES.registry, CANDIDATE_FILES.release_package, CANDIDATE_FILES.search_index_input, CANDIDATE_FILES.token_artifact]) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    writeFileSync(join(destination, file), readFileSync(join(source, file)));
  }
  copyDirectory(join(source, CANDIDATE_FILES.cache), join(destination, CANDIDATE_FILES.cache));
  for (const receipt of CANDIDATE_RECEIPTS) {
    if (existsSync(join(source, receipt))) writeFileSync(join(destination, receipt), readFileSync(join(source, receipt)));
  }
}

function writeCandidateDirectory(
  build: Pick<HubReleaseBuildResult, "release" | "releasePackage" | "ftsTable" | "registryHome">,
  destination: string,
  candidate: AnyReleaseCandidateDocument,
  sidecars: { readonly preflight?: PublicationPreflightDocument; readonly releaseDiff?: ReleaseDiffDocument } = {},
): VerifiedReleaseCandidate {
  const root = resolve(destination);
  mkdirSync(dirname(root), { recursive: true });
  ensureFreshDestination(root);
  const temp = mkdtempSync(join(dirname(root), ".ega-release-candidate-"));
  try {
    copyCandidateFiles(build.registryHome, temp);
    if (candidate.schema_version === RELEASE_CANDIDATE_SCHEMA_VERSION) {
      if (sidecars.preflight === undefined || sidecars.releaseDiff === undefined) fail("governed candidate requires publication sidecars");
      writeFileSync(join(temp, "publication-preflight.json"), `${JSON.stringify(sidecars.preflight, null, 2)}\n`);
      writeFileSync(join(temp, "release-diff.json"), `${JSON.stringify(sidecars.releaseDiff, null, 2)}\n`);
    }
    writeFileSync(join(temp, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);
    renameSync(temp, root);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return verifyReleaseCandidate(root);
}

/** Materialize a governed, approval-bound candidate atomically. */
export function writeReleaseCandidate(
  build: Pick<HubReleaseBuildResult, "release" | "releasePackage" | "ftsTable" | "registryHome">,
  destination: string,
  candidate: ReleaseCandidateDocument,
  publication: { readonly preflight: PublicationPreflightDocument; readonly releaseDiff: ReleaseDiffDocument },
): VerifiedReleaseCandidate {
  return writeCandidateDirectory(build, destination, candidate, publication);
}

/** Materialize a retained artifact-only candidate for legacy serving tests and migration tools. */
export function writeArtifactCandidate(
  build: Pick<HubReleaseBuildResult, "release" | "releasePackage" | "ftsTable" | "registryHome">,
  destination: string,
  candidate: LegacyReleaseCandidateDocument,
): VerifiedReleaseCandidate {
  return writeCandidateDirectory(build, destination, candidate);
}

function verifyCandidateEnvelope(value: unknown): AnyReleaseCandidateDocument {
  const checked = verifyEnvelope(value);
  if (!checked.ok) fail(`candidate envelope is invalid: ${checked.message}`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("candidate envelope is not an object");
  const record = value as Record<string, unknown>;
  if (record.object_type !== RELEASE_CANDIDATE_OBJECT_TYPE || (record.schema_version !== LEGACY_RELEASE_CANDIDATE_SCHEMA_VERSION && record.schema_version !== RELEASE_CANDIDATE_SCHEMA_VERSION)) fail("candidate envelope type/version mismatch");
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail("candidate payload is not an object");
  const p = payload as Record<string, unknown>;
  exactKeys(p, record.schema_version === RELEASE_CANDIDATE_SCHEMA_VERSION ? ["hub_id", "release_digest", "sqlite_artifact_digest", "snapshot_rows", "fts_table", "files", "publication"] : ["hub_id", "release_digest", "sqlite_artifact_digest", "snapshot_rows", "fts_table", "files"], "candidate payload");
  if (typeof p.hub_id !== "string" || p.hub_id.length === 0) fail("hub_id is invalid");
  for (const field of ["release_digest", "sqlite_artifact_digest"]) if (typeof p[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p[field] as string)) fail(`${field} is invalid`);
  if (!Number.isSafeInteger(p.snapshot_rows) || (p.snapshot_rows as number) < 0) fail("snapshot_rows is invalid");
  if (typeof p.fts_table !== "string" || !/^release_fts_[0-9a-f]{64}$/.test(p.fts_table)) fail("fts_table is invalid");
  if (p.files === null || typeof p.files !== "object" || Array.isArray(p.files)) fail("files is invalid");
  const files = p.files as Record<string, unknown>;
  exactKeys(files, Object.keys(CANDIDATE_FILES), "candidate files");
  for (const [key, expected] of Object.entries(CANDIDATE_FILES)) if (files[key] !== expected) fail(`candidate files.${key} is not ${expected}`);
  if (record.schema_version === RELEASE_CANDIDATE_SCHEMA_VERSION) {
    const publication = p.publication;
    if (publication === null || typeof publication !== "object" || Array.isArray(publication)) fail("publication bindings are invalid");
    const binding = publication as Record<string, unknown>;
    exactKeys(binding, ["approval_set_digest", "preflight_digest", "previous_release_digest", "publication_policy_revision", "release_diff_digest"], "publication bindings");
    for (const field of ["approval_set_digest", "preflight_digest", "previous_release_digest", "release_diff_digest"]) if (typeof binding[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(binding[field] as string)) fail(`publication.${field} is invalid`);
    if (binding.publication_policy_revision !== PUBLICATION_POLICY_REVISION) fail("publication policy revision is invalid");
  }
  return value as unknown as ReleaseCandidateDocument;
}

/** Create the exact receipt stored beside a Contract C build. */
export function createReleaseCandidate(
  build: Pick<HubReleaseBuildResult, "release" | "releasePackage" | "ftsTable">,
  publication: { readonly preflight: PublicationPreflightDocument; readonly previousReleaseDigest: string; readonly releaseDiff: ReleaseDiffDocument },
): ReleaseCandidateDocument {
  verifyHubRelease(build.release);
  const preflight = verifyPublicationPreflight(publication.preflight);
  const releaseDiff = verifyReleaseDiff(publication.releaseDiff);
  if (preflight.payload.status !== "READY" || preflight.payload.blockers.length !== 0) fail("publication preflight is not READY");
  if (preflight.payload.hub_id !== build.release.payload.hub_id || JSON.stringify(preflight.payload.skill_versions) !== JSON.stringify(build.release.payload.skill_versions)) fail("publication preflight does not match the release");
  if (releaseDiff.payload.hub_id !== build.release.payload.hub_id || releaseDiff.payload.candidate_release_digest !== build.release.digest || releaseDiff.payload.base_release_digest !== publication.previousReleaseDigest) fail("release diff does not match the publication inputs");
  if (!/^sha256:[0-9a-f]{64}$/.test(publication.previousReleaseDigest)) fail("previous release digest is invalid");
  const expected = createReleasePackage(build.release, build.releasePackage.sqlite_artifact_digest, build.releasePackage.snapshot_rows);
  if (JSON.stringify(expected) !== JSON.stringify(build.releasePackage)) fail("release package does not bind the release");
  return createEnvelope({
    object_type: RELEASE_CANDIDATE_OBJECT_TYPE,
    payload: {
      files: CANDIDATE_FILES,
      fts_table: build.ftsTable,
      hub_id: build.release.payload.hub_id,
      release_digest: build.release.digest,
      snapshot_rows: build.releasePackage.snapshot_rows,
      sqlite_artifact_digest: build.releasePackage.sqlite_artifact_digest,
      publication: {
        approval_set_digest: preflight.payload.approval_set_digest,
        preflight_digest: preflight.digest,
        previous_release_digest: publication.previousReleaseDigest,
        publication_policy_revision: PUBLICATION_POLICY_REVISION,
        release_diff_digest: releaseDiff.digest,
      },
    },
    schema_version: RELEASE_CANDIDATE_SCHEMA_VERSION,
  }) as ReleaseCandidateDocument;
}

/** Create a legacy artifact-only candidate; it is never accepted by governed export. */
export function createArtifactCandidate(build: Pick<HubReleaseBuildResult, "release" | "releasePackage" | "ftsTable">): LegacyReleaseCandidateDocument {
  verifyHubRelease(build.release);
  const expected = createReleasePackage(build.release, build.releasePackage.sqlite_artifact_digest, build.releasePackage.snapshot_rows);
  if (JSON.stringify(expected) !== JSON.stringify(build.releasePackage)) fail("release package does not bind the release");
  return createEnvelope({
    object_type: RELEASE_CANDIDATE_OBJECT_TYPE,
    payload: {
      files: CANDIDATE_FILES,
      fts_table: build.ftsTable,
      hub_id: build.release.payload.hub_id,
      release_digest: build.release.digest,
      snapshot_rows: build.releasePackage.snapshot_rows,
      sqlite_artifact_digest: build.releasePackage.sqlite_artifact_digest,
    },
    schema_version: LEGACY_RELEASE_CANDIDATE_SCHEMA_VERSION,
  }) as LegacyReleaseCandidateDocument;
}

/** Verify all semantic, SQLite, release-FTS, and content-addressed bindings. */
export function verifyReleaseCandidate(directory: string, candidatePath = join(directory, "candidate.json")): VerifiedReleaseCandidate {
  const root = resolve(directory);
  const candidate = verifyCandidateEnvelope(json(resolve(candidatePath)));
  const release = json(join(root, CANDIDATE_FILES.hub_release)) as HubRelease;
  const releasePackage = json(join(root, CANDIDATE_FILES.release_package)) as ReleasePackage;
  verifyHubRelease(release);
  if (candidate.payload.release_digest !== release.digest || candidate.payload.hub_id !== release.payload.hub_id) fail("candidate does not bind hub-release.json");
  if (releasePackage.hub_release_digest !== release.digest || releasePackage.sqlite_artifact_digest !== candidate.payload.sqlite_artifact_digest || releasePackage.snapshot_rows !== candidate.payload.snapshot_rows) fail("release package does not match candidate");
  if (candidate.schema_version === RELEASE_CANDIDATE_SCHEMA_VERSION) {
    const preflight = verifyPublicationPreflight(json(join(root, "publication-preflight.json")));
    const releaseDiff = verifyReleaseDiff(json(join(root, "release-diff.json")));
    const publication = candidate.payload.publication;
    if (preflight.digest !== publication.preflight_digest || preflight.payload.approval_set_digest !== publication.approval_set_digest || releaseDiff.digest !== publication.release_diff_digest || releaseDiff.payload.candidate_release_digest !== release.digest || releaseDiff.payload.base_release_digest !== publication.previous_release_digest) fail("publication sidecars do not match candidate bindings");
    if (preflight.payload.status !== "READY" || preflight.payload.blockers.length !== 0 || preflight.payload.hub_id !== release.payload.hub_id || JSON.stringify(preflight.payload.skill_versions) !== JSON.stringify(release.payload.skill_versions)) fail("publication preflight is not an exact READY snapshot of the release");
    const releaseSkills = Object.entries(release.payload.skill_versions);
    if (preflight.payload.reviews.length !== releaseSkills.length || preflight.payload.reviews.some((review) => review.decision !== "APPROVED" || review.version_hash !== release.payload.skill_versions[review.skill_id] || review.candidate_digest.length === 0)) fail("publication approval snapshot does not approve every release skill");
    for (const [skillId] of releaseSkills) if (!preflight.payload.reviews.some((review) => review.skill_id === skillId)) fail(`publication approval snapshot is missing ${skillId}`);
  }
  const artifacts = {
    aliasMap: json(join(root, CANDIDATE_FILES.alias_map)) as ReleaseArtifacts["aliasMap"],
    searchIndexInput: json(join(root, CANDIDATE_FILES.search_index_input)) as ReleaseArtifacts["searchIndexInput"],
    tokenArtifact: json(join(root, CANDIDATE_FILES.token_artifact)) as ReleaseArtifacts["tokenArtifact"],
  } satisfies ReleaseArtifacts;
  verifyHubRelease(release, artifacts);
  const sqlitePath = join(root, CANDIDATE_FILES.registry);
  if (`sha256:${sha256Hex(readFileSync(sqlitePath))}` !== candidate.payload.sqlite_artifact_digest) fail("SQLite artifact digest mismatch");
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("SQLite integrity check failed");
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(candidate.payload.fts_table);
    if (!table) fail("release FTS table is missing");
    const rows = db.prepare(`SELECT count(*) AS count FROM ${candidate.payload.fts_table}`).get() as { count: number };
    if (rows.count !== candidate.payload.snapshot_rows) fail("release FTS row count mismatch");
    verifyReleaseProjection(db, release.payload, candidate.payload.fts_table);
    const cacheDir = join(root, CANDIDATE_FILES.cache);
    for (const [skillId, versionHash] of Object.entries(release.payload.skill_versions)) {
      const version = getSkillVersion(db, skillId, versionHash);
      const manifest = JSON.parse(version.manifestJson) as { files?: readonly { blob_hash?: unknown }[] };
      if (!Array.isArray(manifest.files)) fail(`manifest for ${skillId} has no files`);
      for (const file of manifest.files) {
        if (typeof file.blob_hash !== "string") fail(`manifest blob missing for ${skillId}`);
        getCacheBlob(cacheDir, file.blob_hash);
      }
    }
  } finally {
    db.close();
  }
  return { candidate, directory: root, release, releasePackage };
}

/** Copy a verified candidate to one fresh destination without source access. */
function exportCandidate(candidatePath: string, outputDirectory: string, allowLegacy: boolean): VerifiedReleaseCandidate {
  const candidateFile = resolve(candidatePath);
  const sourceDirectory = dirname(candidateFile);
  const verified = verifyReleaseCandidate(sourceDirectory, candidateFile);
  if (!allowLegacy && verified.candidate.schema_version !== RELEASE_CANDIDATE_SCHEMA_VERSION) fail("legacy artifact-only candidate requires explicit legacy export");
  const destination = resolve(outputDirectory);
  if (inside(sourceDirectory, destination) || inside(destination, sourceDirectory)) fail("export destination overlaps candidate source");
  mkdirSync(dirname(destination), { recursive: true });
  ensureFreshDestination(destination);
  const temp = mkdtempSync(join(dirname(destination), ".ega-release-export-"));
  try {
    copyCandidateFiles(sourceDirectory, temp);
    writeFileSync(join(temp, "candidate.json"), readFileSync(candidateFile));
    renameSync(temp, destination);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return verifyReleaseCandidate(destination, join(destination, "candidate.json"));
}

/** Export only a governed, approval-bound publication candidate. */
export function exportReleaseCandidate(candidatePath: string, outputDirectory: string): VerifiedReleaseCandidate {
  return exportCandidate(candidatePath, outputDirectory, false);
}

/** Explicit legacy path for retained artifact-only releases. */
export function exportLegacyReleaseCandidate(candidatePath: string, outputDirectory: string): VerifiedReleaseCandidate {
  return exportCandidate(candidatePath, outputDirectory, true);
}

export { CANDIDATE_FILES, CANDIDATE_RECEIPTS };
