import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { createEnvelope, sha256Hex } from "@ega-skills/hashing";
import {
  casUpdateStable,
  createStablePointer,
  type StablePointer,
  verifyReleaseCandidate,
  writeFileAtomic,
} from "@ega-skills/project";
import { HostedRuntimeError, loadHostedReleaseSnapshot, type HostedReleaseSnapshot } from "./hosted.js";

export const RETAINED_MANIFEST_OBJECT_TYPE = "ega.retained-release-manifest" as const;
export const RETAINED_MANIFEST_SCHEMA_VERSION = 1 as const;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface RetainedReleaseEntry {
  readonly release_digest: string;
  /** POSIX relative path below the manifest directory. */
  readonly artifact_path: string;
  /** Exact R1 candidate envelope approved for deployment. */
  readonly candidate_digest: string;
  readonly release_package_digest: string;
}

export interface RetainedManifestPayload {
  readonly hub_id: string;
  readonly publication_revision: number;
  readonly deployment_id: string;
  readonly default_release_digest: string;
  readonly releases: readonly RetainedReleaseEntry[];
}

export interface RetainedManifest {
  readonly object_type: typeof RETAINED_MANIFEST_OBJECT_TYPE;
  readonly schema_version: typeof RETAINED_MANIFEST_SCHEMA_VERSION;
  readonly payload: RetainedManifestPayload;
  readonly digest: string;
}

export interface RetainedReleaseSet {
  readonly manifestPath: string;
  readonly manifest: RetainedManifest;
  readonly defaultSnapshot: HostedReleaseSnapshot;
  readonly snapshots: ReadonlyMap<string, HostedReleaseSnapshot>;
}

export interface RetainedPromotionOptions {
  readonly manifestPath: string;
  /** Path to the exact R1 candidate.json being promoted. */
  readonly candidatePath: string;
  /** Caller-supplied identity must match candidate.json; never inferred from deployment metadata. */
  readonly candidateDigest: string;
  readonly expectedRevision: number;
  readonly deploymentId: string;
}

function fail(message: string): never {
  throw new HostedRuntimeError("E_RETAINED_INVALID", message);
}

function stale(message: string): never {
  throw new HostedRuntimeError("E_RETAINED_STALE", message);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${name} has invalid fields`);
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${name} must match sha256:<64 lowercase hex>`);
  return value;
}

function entry(value: unknown): RetainedReleaseEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("retained release entry must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["artifact_path", "candidate_digest", "release_digest", "release_package_digest"], "retained release entry");
  if (typeof record.artifact_path !== "string" || record.artifact_path.length === 0 || record.artifact_path.includes("\\") || record.artifact_path.startsWith("/") || record.artifact_path.split("/").includes("..")) {
    fail("retained artifact_path must be a non-empty POSIX relative path");
  }
  return {
    artifact_path: record.artifact_path,
    candidate_digest: digest(record.candidate_digest, "candidate_digest"),
    release_digest: digest(record.release_digest, "release_digest"),
    release_package_digest: digest(record.release_package_digest, "release_package_digest"),
  };
}

function payload(value: unknown): RetainedManifestPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("retained manifest payload must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["default_release_digest", "deployment_id", "hub_id", "publication_revision", "releases"], "retained manifest payload");
  if (typeof record.hub_id !== "string" || record.hub_id.length === 0) fail("hub_id must be non-empty");
  if (typeof record.deployment_id !== "string" || record.deployment_id.length === 0) fail("deployment_id must be non-empty");
  if (!Number.isSafeInteger(record.publication_revision) || (record.publication_revision as number) < 1) fail("publication_revision must be a positive safe integer");
  const defaultDigest = digest(record.default_release_digest, "default_release_digest");
  if (!Array.isArray(record.releases) || record.releases.length === 0) fail("releases must be non-empty");
  const releases = (record.releases as unknown[]).map(entry);
  for (let index = 1; index < releases.length; index += 1) {
    if ((releases[index - 1]?.release_digest ?? "") >= (releases[index]?.release_digest ?? "")) fail("releases must be sorted and unique by release_digest");
  }
  if (!releases.some((release) => release.release_digest === defaultDigest)) fail("default release must be retained");
  return {
    default_release_digest: defaultDigest,
    deployment_id: record.deployment_id,
    hub_id: record.hub_id,
    publication_revision: record.publication_revision as number,
    releases,
  };
}

export function createRetainedManifest(input: RetainedManifestPayload): RetainedManifest {
  const normalized = payload({ ...input, releases: [...input.releases].sort((a, b) => a.release_digest.localeCompare(b.release_digest)) });
  return createEnvelope({
    object_type: RETAINED_MANIFEST_OBJECT_TYPE,
    payload: normalized,
    schema_version: RETAINED_MANIFEST_SCHEMA_VERSION,
  }) as RetainedManifest;
}

export function verifyRetainedManifest(value: unknown): asserts value is RetainedManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("retained manifest must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["digest", "object_type", "payload", "schema_version"], "retained manifest");
  if (record.object_type !== RETAINED_MANIFEST_OBJECT_TYPE || record.schema_version !== RETAINED_MANIFEST_SCHEMA_VERSION) fail("retained manifest type/version mismatch");
  const normalizedPayload = payload(record.payload);
  const expected = createRetainedManifest(normalizedPayload);
  if (record.digest !== expected.digest) fail(`retained manifest digest mismatch (want ${expected.digest})`);
}

function readManifest(manifestPath: string): RetainedManifest {
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    verifyRetainedManifest(value);
    return value;
  } catch (error) {
    if (error instanceof HostedRuntimeError) throw error;
    fail(`retained manifest cannot be read: ${String(error)}`);
  }
}

function confinedArtifactPath(manifestPath: string, artifactPath: string): string {
  const root = realpathSync(dirname(manifestPath));
  const candidate = resolve(root, ...artifactPath.split("/"));
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) fail("retained artifact path escapes the manifest directory");
  if (!existsSync(candidate)) fail(`retained artifact is missing: ${artifactPath}`);
  if (lstatSync(candidate).isSymbolicLink()) fail("retained artifact path must not be a symbolic link");
  const realCandidate = realpathSync(candidate);
  if (!realCandidate.startsWith(`${root}${sep}`)) fail("retained artifact path escapes the manifest directory");
  return realCandidate;
}

function packageDigest(artifactDir: string): string {
  const path = resolve(artifactDir, "release-package.json");
  if (!existsSync(path)) fail("retained artifact is missing release-package.json");
  return `sha256:${sha256Hex(readFileSync(path))}`;
}

export function loadRetainedReleaseSet(manifestPathInput: string): RetainedReleaseSet {
  const manifestPath = resolve(manifestPathInput);
  const manifest = readManifest(manifestPath);
  const snapshots = new Map<string, HostedReleaseSnapshot>();
  for (const retained of manifest.payload.releases) {
    const artifactDir = confinedArtifactPath(manifestPath, retained.artifact_path);
    let verifiedCandidate;
    try {
      verifiedCandidate = verifyReleaseCandidate(artifactDir);
    } catch (error) {
      fail(`retained candidate is invalid for ${retained.release_digest}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (verifiedCandidate.candidate.digest !== retained.candidate_digest) fail(`retained candidate digest mismatch for ${retained.release_digest}`);
    const snapshot = loadHostedReleaseSnapshot(artifactDir);
    if (snapshot.releaseDigest !== retained.release_digest) fail(`retained artifact release digest mismatch for ${retained.release_digest}`);
    if (snapshot.release.payload.hub_id !== manifest.payload.hub_id) fail("retained artifact belongs to a different Hub");
    if (packageDigest(artifactDir) !== retained.release_package_digest) fail(`retained package digest mismatch for ${retained.release_digest}`);
    snapshots.set(retained.release_digest, snapshot);
  }
  const defaultSnapshot = snapshots.get(manifest.payload.default_release_digest);
  if (!defaultSnapshot) fail("retained default release is unavailable");
  return Object.freeze({ manifestPath, manifest, defaultSnapshot, snapshots });
}

export function resolveRetainedRelease(set: RetainedReleaseSet, releaseDigest: string): HostedReleaseSnapshot {
  const snapshot = set.snapshots.get(releaseDigest);
  if (!snapshot) throw new HostedRuntimeError("E_RELEASE_UNAVAILABLE", "Requested retained release is unavailable");
  return snapshot;
}

function relativeArtifactPath(manifestPath: string, artifactDir: string): string {
  const root = realpathSync(dirname(manifestPath));
  const lexicalArtifact = resolve(artifactDir);
  if (!existsSync(lexicalArtifact)) fail("retained artifact is missing");
  if (lstatSync(lexicalArtifact).isSymbolicLink()) fail("retained artifact path must not be a symbolic link");
  const artifact = realpathSync(lexicalArtifact);
  const value = relative(root, artifact).split(sep).join("/");
  if (value.length === 0 || value === "." || value === ".." || value.startsWith("../") || !artifact.startsWith(`${root}${sep}`)) fail("retained artifact must be below the manifest directory");
  return value;
}

function acquireManifestLock(manifestPath: string): () => void {
  const lockPath = `${manifestPath}.lock`;
  mkdirSync(dirname(manifestPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath);
      writeFileSync(resolve(lockPath, "owner"), `${process.pid}\n`);
      return () => rmSync(lockPath, { force: true, recursive: true });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      let owner: number | undefined;
      try {
        owner = Number.parseInt(readFileSync(resolve(lockPath, "owner"), "utf8").trim(), 10);
      } catch {
        throw new HostedRuntimeError("E_RETAINED_LOCKED", "retained manifest is being updated");
      }
      if (!Number.isInteger(owner) || owner <= 0) {
        throw new HostedRuntimeError("E_RETAINED_LOCKED", "retained manifest is being updated");
      }
      if (owner !== undefined && Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          throw new HostedRuntimeError("E_RETAINED_LOCKED", "retained manifest is being updated");
        } catch (probeError) {
          if (probeError instanceof HostedRuntimeError) throw probeError;
          if ((probeError as { code?: unknown }).code !== "ESRCH") throw new HostedRuntimeError("E_RETAINED_LOCKED", "retained manifest is being updated");
        }
      }
      rmSync(lockPath, { force: true, recursive: true });
    }
  }
  throw new HostedRuntimeError("E_RETAINED_LOCKED", "retained manifest is being updated");
}

function writeManifest(manifestPath: string, manifest: RetainedManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function currentPointer(manifest: RetainedManifest): StablePointer {
  const release = manifest.payload.default_release_digest;
  return { cas_version: manifest.payload.publication_revision, hub_id: manifest.payload.hub_id, stable_release_digest: release };
}

export function promoteRetainedRelease(options: RetainedPromotionOptions): RetainedManifest {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) fail("expectedRevision must be a positive safe integer");
  if (options.deploymentId.length === 0) fail("deploymentId must be non-empty");
  const unlock = acquireManifestLock(options.manifestPath);
  try {
    const releaseSet = loadRetainedReleaseSet(options.manifestPath);
    const candidatePath = resolve(options.candidatePath);
    const candidateDirectory = dirname(candidatePath);
    let verifiedCandidate;
    try {
      verifiedCandidate = verifyReleaseCandidate(candidateDirectory, candidatePath);
    } catch (error) {
      fail(`promotion candidate is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (verifiedCandidate.candidate.digest !== options.candidateDigest) fail("promotion candidate digest does not match candidate.json");
    const candidate = loadHostedReleaseSnapshot(candidateDirectory);
    if (candidate.release.payload.hub_id !== releaseSet.manifest.payload.hub_id) fail("candidate belongs to a different Hub");
    const releaseEntry: RetainedReleaseEntry = {
      artifact_path: relativeArtifactPath(options.manifestPath, candidateDirectory),
      candidate_digest: verifiedCandidate.candidate.digest,
      release_digest: candidate.releaseDigest,
      release_package_digest: packageDigest(candidate.artifactDir),
    };
    const releaseMap = new Map(releaseSet.manifest.payload.releases.map((release) => [release.release_digest, release]));
    releaseMap.set(releaseEntry.release_digest, releaseEntry);
    const current = currentPointer(releaseSet.manifest);
    if (current.cas_version !== options.expectedRevision) stale("retained manifest revision is stale");
    const candidatePointer = createStablePointer(current.hub_id, candidate.release, current.cas_version + 1);
    const nextPointer = casUpdateStable(current, candidatePointer, options.expectedRevision);
    const next = createRetainedManifest({
      ...releaseSet.manifest.payload,
      default_release_digest: nextPointer.stable_release_digest,
      deployment_id: options.deploymentId,
      publication_revision: nextPointer.cas_version,
      releases: [...releaseMap.values()],
    });
    const latest = readManifest(resolve(options.manifestPath));
    if (latest.digest !== releaseSet.manifest.digest || latest.payload.publication_revision !== options.expectedRevision) stale("retained manifest changed during promotion");
    writeManifest(resolve(options.manifestPath), next);
    return next;
  } finally {
    unlock();
  }
}

export function rollbackRetainedRelease(options: RetainedPromotionOptions & { readonly releaseDigest: string }): RetainedManifest {
  const releaseSet = loadRetainedReleaseSet(options.manifestPath);
  const retained = resolveRetainedRelease(releaseSet, options.releaseDigest);
  const retainedEntry = releaseSet.manifest.payload.releases.find((entry) => entry.release_digest === retained.releaseDigest);
  if (!retainedEntry) fail("rollback release is not retained");
  return promoteRetainedRelease({
    candidateDigest: retainedEntry.candidate_digest,
    candidatePath: resolve(dirname(options.manifestPath), retainedEntry.artifact_path, "candidate.json"),
    deploymentId: options.deploymentId,
    expectedRevision: options.expectedRevision,
    manifestPath: options.manifestPath,
  });
}
