// Contract I1/R1 v3 governed candidate. No candidate can be created without
// the existing READY publication preflight; this is not a projection path.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { createEnvelope, sha256Hex, verifyEnvelope } from "@ega-skills/hashing";
import { getCacheBlob, getSkillVersion } from "@ega-skills/registry";
import { verifyPublicationPreflight, type PublicationPreflightDocument } from "../intake/publication.js";
import { HubError } from "./errors.js";
import { type InvocationHubReleaseBuildResult } from "./invocation-build.js";
import { parseInvocationPolicy, type InvocationPolicy } from "./invocation-policy.js";
import { verifyInvocationRelease, verifyInvocationTransition, type InvocationHubRelease } from "./invocation-release.js";
import { verifyInvocationReleaseDiff, type InvocationReleaseDiff } from "./invocation-release-diff.js";
import { CANDIDATE_FILES, PUBLICATION_POLICY_REVISION, type PublicationBindings } from "./release-candidate.js";
import { verifyReleaseProjection } from "./release-state.js";
import { type HubRelease, type ReleaseArtifacts, type ReleasePackage } from "./release.js";

const FILES = Object.freeze({ ...CANDIDATE_FILES, invocation_policy: "invocation-policy.json", previous_hub_release: "previous-hub-release.json" });
export interface InvocationCandidatePayload {
  readonly hub_id: string; readonly release_digest: string; readonly sqlite_artifact_digest: string;
  readonly snapshot_rows: number; readonly fts_table: string; readonly files: typeof FILES; readonly publication: PublicationBindings;
}
export interface InvocationCandidate {
  readonly object_type: "ega.release-candidate"; readonly schema_version: 3; readonly digest: string; readonly payload: InvocationCandidatePayload;
}
function fail(message: string): never { throw new HubError("E_PACKAGE_BINDING", `I1 candidate: ${message}`); }
function keys(value: unknown, expected: readonly string[], field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...expected].sort())) fail(`${field} has missing or unknown fields`);
  return record;
}
function json(path: string): unknown {
  if (!lstatSync(path).isFile()) fail(`expected a regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
function checkPreflight(value: unknown, release: InvocationHubRelease): PublicationPreflightDocument {
  const result = verifyPublicationPreflight(value);
  const p = result.payload;
  if (p.status !== "READY" || p.blockers.length !== 0 || p.hub_id !== release.payload.hub_id ||
      JSON.stringify(p.skill_versions) !== JSON.stringify(release.payload.skill_versions)) fail("preflight is not an exact READY snapshot");
  const entries = Object.entries(release.payload.skill_versions);
  if (p.reviews.length !== entries.length || p.reviews.some((review) => review.decision !== "APPROVED" || release.payload.skill_versions[review.skill_id] !== review.version_hash)) fail("preflight does not approve every selected version");
  return result;
}
function validateInputs(release: InvocationHubRelease, policy: InvocationPolicy, previous: unknown, preflight: unknown, diff: unknown) {
  verifyInvocationRelease(release, policy);
  const checkedPreflight = checkPreflight(preflight, release);
  const checkedDiff = verifyInvocationReleaseDiff(diff, { release: previous }, { release, policy });
  return { preflight: checkedPreflight, diff: checkedDiff };
}

export function createInvocationCandidate(build: InvocationHubReleaseBuildResult, policy: InvocationPolicy, previous: unknown, preflight: PublicationPreflightDocument, diff: InvocationReleaseDiff, previousPolicy?: InvocationPolicy): InvocationCandidate {
  const checked = validateInputs(build.release, policy, previous, preflight, diff);
  verifyInvocationTransition({ release: previous as HubRelease | InvocationHubRelease, ...(previousPolicy === undefined ? {} : { policy: previousPolicy }) }, { release: build.release, policy });
  const p = build.releasePackage;
  if (p.hub_release_digest !== build.release.digest || p.snapshot_rows !== Object.keys(build.release.payload.skill_versions).length || !/^sha256:[0-9a-f]{64}$/.test(p.sqlite_artifact_digest) || build.ftsTable !== `release_fts_${build.release.digest.slice(7)}`) fail("build package does not match release");
  return createEnvelope({ object_type: "ega.release-candidate", schema_version: 3, payload: {
    files: FILES, fts_table: build.ftsTable, hub_id: build.release.payload.hub_id, release_digest: build.release.digest,
    snapshot_rows: p.snapshot_rows, sqlite_artifact_digest: p.sqlite_artifact_digest,
    publication: { approval_set_digest: checked.preflight.payload.approval_set_digest, preflight_digest: checked.preflight.digest,
      previous_release_digest: checked.diff.payload.base_release_digest, release_diff_digest: checked.diff.digest, publication_policy_revision: PUBLICATION_POLICY_REVISION },
  } }) as InvocationCandidate;
}

/** Verify candidate, sidecars and every release-scoped physical artifact. */
export function verifyInvocationCandidate(directory: string): { candidate: InvocationCandidate; release: InvocationHubRelease; policy: InvocationPolicy; directory: string } {
  const root = resolve(directory);
  rejectLinks(root);
  const raw = json(join(root, "candidate.json"));
  const envelope = keys(raw, ["object_type", "schema_version", "digest", "payload"], "candidate");
  if (envelope.object_type !== "ega.release-candidate" || envelope.schema_version !== 3 || !verifyEnvelope(raw).ok) fail("invalid candidate envelope");
  const p = keys(envelope.payload, ["hub_id", "release_digest", "sqlite_artifact_digest", "snapshot_rows", "fts_table", "files", "publication"], "payload");
  if (JSON.stringify(keys(p.files, Object.keys(FILES), "files")) !== JSON.stringify(FILES)) {
    const files = p.files as Record<string, unknown>;
    if (Object.entries(FILES).some(([key, expected]) => files[key] !== expected)) fail("invalid candidate paths");
  }
  const publication = keys(p.publication, ["approval_set_digest", "preflight_digest", "previous_release_digest", "release_diff_digest", "publication_policy_revision"], "publication");
  for (const value of [p.release_digest, p.sqlite_artifact_digest, publication.approval_set_digest, publication.preflight_digest, publication.previous_release_digest, publication.release_diff_digest]) if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail("invalid digest");
  if (publication.publication_policy_revision !== PUBLICATION_POLICY_REVISION || !Number.isSafeInteger(p.snapshot_rows) || (p.snapshot_rows as number) < 0) fail("invalid publication or row count");
  const policyPath = join(root, FILES.invocation_policy);
  if (!lstatSync(policyPath).isFile()) fail("policy is not a regular file");
  const policy = parseInvocationPolicy(readFileSync(policyPath, "utf8"));
  const release = json(join(root, FILES.hub_release));
  verifyInvocationRelease(release, policy);
  const previous = json(join(root, FILES.previous_hub_release));
  const checked = validateInputs(release, policy, previous, json(join(root, "publication-preflight.json")), json(join(root, "release-diff.json")));
  if (p.hub_id !== release.payload.hub_id || p.release_digest !== release.digest || p.fts_table !== `release_fts_${release.digest.slice(7)}` ||
      p.snapshot_rows !== Object.keys(release.payload.skill_versions).length || publication.preflight_digest !== checked.preflight.digest ||
      publication.approval_set_digest !== checked.preflight.payload.approval_set_digest || publication.release_diff_digest !== checked.diff.digest ||
      publication.previous_release_digest !== checked.diff.payload.base_release_digest) fail("release or sidecar binding mismatch");
  const artifact = json(join(root, FILES.release_package)) as ReleasePackage;
  keys(artifact, ["hub_release_digest", "sqlite_artifact_digest", "snapshot_rows"], "release package");
  if (artifact.hub_release_digest !== release.digest || artifact.sqlite_artifact_digest !== p.sqlite_artifact_digest || artifact.snapshot_rows !== p.snapshot_rows) fail("release package mismatch");
  const artifacts: ReleaseArtifacts = { aliasMap: json(join(root, FILES.alias_map)) as ReleaseArtifacts["aliasMap"], searchIndexInput: json(join(root, FILES.search_index_input)) as ReleaseArtifacts["searchIndexInput"], tokenArtifact: json(join(root, FILES.token_artifact)) as ReleaseArtifacts["tokenArtifact"] };
  verifyInvocationRelease(release, policy, artifacts);
  const sqlite = join(root, FILES.registry);
  if (!lstatSync(sqlite).isFile() || `sha256:${sha256Hex(readFileSync(sqlite))}` !== p.sqlite_artifact_digest) fail("SQLite digest mismatch");
  const db = new Database(sqlite, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("SQLite integrity check failed");
    const fts = p.fts_table as string;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(fts)) fail("release FTS missing");
    const rows = db.prepare(`SELECT count(*) AS count FROM ${fts}`).get() as { count: number };
    if (rows.count !== p.snapshot_rows) fail("release FTS count mismatch");
    verifyReleaseProjection(db, release.payload, fts);
    for (const [skill, version] of Object.entries(release.payload.skill_versions)) {
      const manifest = JSON.parse(getSkillVersion(db, skill, version).manifestJson) as { files?: readonly { blob_hash?: unknown }[] };
      if (!Array.isArray(manifest.files)) fail(`manifest missing files for ${skill}`);
      for (const file of manifest.files) {
        if (typeof file.blob_hash !== "string") fail(`manifest missing blob for ${skill}`);
        getCacheBlob(join(root, FILES.cache), file.blob_hash);
      }
    }
  } finally { db.close(); }
  return { candidate: raw as InvocationCandidate, release, policy, directory: root };
}

function rejectLinks(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) fail(`symlink forbidden: ${path}`);
  if (entry.isDirectory()) for (const child of readdirSync(path)) rejectLinks(join(path, child));
  else if (!entry.isFile()) fail(`nonregular candidate entry: ${path}`);
}
function copyRegular(source: string, destination: string): void {
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) fail(`symlink forbidden: ${source}`);
  if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of readdirSync(source)) copyRegular(join(source, child), join(destination, child));
  } else if (entry.isFile()) writeFileSync(destination, readFileSync(source));
  else fail(`nonregular candidate entry: ${source}`);
}

/** Atomically materialize a candidate and verify it before returning it. */
export function writeInvocationCandidate(build: InvocationHubReleaseBuildResult, destination: string, candidate: InvocationCandidate, previous: unknown, preflight: PublicationPreflightDocument, diff: InvocationReleaseDiff): ReturnType<typeof verifyInvocationCandidate> {
  const root = resolve(destination);
  if (existsSync(root)) fail("destination already exists");
  const rel = relative(resolve(build.registryHome), root);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) fail("destination is inside the build directory");
  mkdirSync(dirname(root), { recursive: true });
  const temp = mkdtempSync(join(dirname(root), ".ega-i1-candidate-"));
  try {
    for (const file of Object.values(FILES).filter((value) => value !== FILES.previous_hub_release)) {
      const source = join(build.registryHome, file);
      rejectLinks(source);
      mkdirSync(dirname(join(temp, file)), { recursive: true });
      copyRegular(source, join(temp, file));
    }
    for (const [file, value] of [["candidate.json", candidate], [FILES.previous_hub_release, previous], ["publication-preflight.json", preflight], ["release-diff.json", diff]] as const) writeFileSync(join(temp, file), `${JSON.stringify(value, null, 2)}\n`);
    verifyInvocationCandidate(temp);
    renameSync(temp, root);
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  return verifyInvocationCandidate(root);
}

/** Export the already verified candidate without consulting moving sources. */
export function exportInvocationCandidate(sourceDirectory: string, destination: string): ReturnType<typeof verifyInvocationCandidate> {
  const source = resolve(sourceDirectory);
  const root = resolve(destination);
  verifyInvocationCandidate(source);
  const sourceToRoot = relative(source, root);
  const rootToSource = relative(root, source);
  const inside = (path: string) => path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
  if (inside(sourceToRoot) || inside(rootToSource)) fail("export destination overlaps candidate source");
  if (existsSync(root)) fail("destination already exists");
  mkdirSync(dirname(root), { recursive: true });
  const temp = mkdtempSync(join(dirname(root), ".ega-i1-export-"));
  try {
    copyRegular(source, temp);
    verifyInvocationCandidate(temp);
    renameSync(temp, root);
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  return verifyInvocationCandidate(root);
}
