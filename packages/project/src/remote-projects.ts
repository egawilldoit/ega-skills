import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createEnvelope, hashBytes, canonicalizeJson, verifyEnvelope } from "@ega-skills/hashing";
import type { ProjectConfigV1 } from "./config.js";
import { serializeLockfile, validateLockfile, type ProjectLockV1 } from "./lock.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

export interface ProjectContextPayload {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly config_digest: string;
  readonly lock_digest: string;
  readonly release_digest: string;
  readonly fingerprint_digest: string | null;
  readonly context_contract: "E1";
}

export interface ProjectContextDocument {
  readonly object_type: "ega.project-context";
  readonly schema_version: 1;
  readonly payload: ProjectContextPayload;
  readonly digest: string;
}

export interface RemoteLockChange {
  readonly skill_ref: string;
  readonly old_version: string | null;
  readonly new_version: string | null;
}

export interface RemoteLockPlanPayload {
  readonly project_config_digest: string;
  readonly existing_lock_digest: string;
  readonly target_release_digest: string;
  readonly candidate_lock: ProjectLockV1;
  readonly changes: readonly RemoteLockChange[];
}

export type RemoteLockPlan = ReturnType<typeof createEnvelope> & {
  readonly object_type: "ega.remote-lock-plan";
  readonly schema_version: 1;
  readonly payload: RemoteLockPlanPayload;
};

function assertDigest(value: string, field: string): void {
  if (!DIGEST.test(value)) throw new Error(`${field} must be sha256:<64 lowercase hex>`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${field} has unknown or missing fields`);
}

function validateRemoteLockChanges(value: unknown, candidate: ProjectLockV1): void {
  if (!Array.isArray(value)) throw new Error("changes must be a list");
  let previous = "";
  for (const [index, raw] of value.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`changes[${index}] must be an object`);
    const change = raw as Record<string, unknown>;
    assertExactKeys(change, ["skill_ref", "old_version", "new_version"], `changes[${index}]`);
    if (typeof change.skill_ref !== "string" || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change.skill_ref) || change.skill_ref <= previous) {
      throw new Error("changes must be sorted and unique by skill_ref");
    }
    previous = change.skill_ref;
    for (const field of ["old_version", "new_version"] as const) {
      const version = change[field];
      if (version !== null) assertDigest(version as string, `changes[${index}].${field}`);
    }
    const candidateVersion = candidate.skills[change.skill_ref]?.version_hash ?? null;
    if (change.new_version !== candidateVersion) throw new Error(`changes[${index}].new_version does not match candidate lock`);
  }
}

function assertContextPayload(payload: ProjectContextPayload): void {
  const keys = Object.keys(payload).sort();
  if (keys.join(",") !== "config_digest,context_contract,fingerprint_digest,lock_digest,project_id,release_digest,workspace_id") {
    throw new Error("invalid project context fields");
  }
  for (const [field, value] of Object.entries(payload)) {
    if (field === "fingerprint_digest" && value === null) continue;
    if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  }
  for (const field of ["config_digest", "lock_digest", "release_digest"] as const) assertDigest(payload[field], field);
  if (payload.fingerprint_digest !== null) assertDigest(payload.fingerprint_digest, "fingerprint_digest");
  if (payload.context_contract !== "E1") throw new Error("context_contract must be E1");
}

export function createProjectContext(payload: ProjectContextPayload): ProjectContextDocument {
  assertContextPayload(payload);
  return createEnvelope({ object_type: "ega.project-context", schema_version: 1, payload }) as ProjectContextDocument;
}

export function verifyProjectContext(document: unknown): ProjectContextDocument {
  const result = verifyEnvelope(document);
  if (!result.ok || result.digest !== (document as { digest?: unknown })?.digest) throw new Error("invalid project context envelope");
  const value = document as ProjectContextDocument;
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== "digest,object_type,payload,schema_version") {
    throw new Error("invalid project context envelope fields");
  }
  if (value.object_type !== "ega.project-context" || value.schema_version !== 1 || value.payload === null || typeof value.payload !== "object") {
    throw new Error("invalid project context identity");
  }
  assertContextPayload(value.payload);
  return value;
}

export function digestProjectConfig(config: ProjectConfigV1): string { return hashBytes(canonicalizeJson(config)); }
export function digestProjectLock(lock: ProjectLockV1): string { return hashBytes(canonicalizeJson(lock)); }

export function createRemoteLockPlan(input: {
  projectConfigDigest: string;
  existingLockDigest: string;
  targetReleaseDigest: string;
  current: ProjectLockV1;
  candidate: ProjectLockV1;
}): RemoteLockPlan {
  assertDigest(input.projectConfigDigest, "projectConfigDigest");
  assertDigest(input.existingLockDigest, "existingLockDigest");
  assertDigest(input.targetReleaseDigest, "targetReleaseDigest");
  const candidate = validateLockfile(input.candidate, input.projectConfigDigest);
  return createEnvelope({ object_type: "ega.remote-lock-plan", schema_version: 1, payload: {
    project_config_digest: input.projectConfigDigest,
    existing_lock_digest: input.existingLockDigest,
    target_release_digest: input.targetReleaseDigest,
    candidate_lock: candidate,
    changes: completeRemoteLockChanges(input.current, candidate),
  } }) as RemoteLockPlan;
}

/**
 * The complete current → candidate transition across the union of both lock
 * catalogs. Apply recomputes this and requires the plan to describe it
 * exactly, so a plan cannot understate or misstate the reviewed transition.
 */
function completeRemoteLockChanges(current: ProjectLockV1, candidate: ProjectLockV1): RemoteLockChange[] {
  const ids = new Set([...Object.keys(current.skills), ...Object.keys(candidate.skills)]);
  return [...ids].sort().flatMap((skill_ref) => {
    const oldVersion = current.skills[skill_ref]?.version_hash ?? null;
    const newVersion = candidate.skills[skill_ref]?.version_hash ?? null;
    return oldVersion === newVersion ? [] : [{ skill_ref, old_version: oldVersion, new_version: newVersion }];
  });
}

/** Preconditions that bind a reviewed plan to the exact project state. */
export interface RemoteLockApplyPreconditions {
  /** Digest of the selected normalized project config at apply time. */
  readonly projectConfigDigest: string;
  /** Parsed lock adjacent to the selected config at apply time. */
  readonly currentLock: ProjectLockV1;
}

/** Injection seam for the post-rename directory synchronization step. */
export interface RemoteLockApplyOptions {
  /**
   * Defaults to a real directory fsync. Tests inject failures here to pin
   * the post-commit durability contract.
   */
  readonly syncDirectory?: (path: string) => void;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(String(code))) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomic lock write: exclusive-create a uniquely named temp (no fixed-name
 * collision), fsync it, rename over the target, then sync the directory.
 *
 * Failures BEFORE the rename remove the temp and leave the prior lock
 * byte-identical. A failure of the post-rename directory sync is a
 * post-commit durability failure: the candidate lock is already complete on
 * disk, so it is reported as exactly that — never as a preserved old lock —
 * and a retry converges to a deterministic stale rejection.
 */
function writeLockAtomically(lockPath: string, text: string, syncDir: (path: string) => void): void {
  const temp = `${lockPath}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    fd = openSync(temp, "wx");
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, lockPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
  try {
    syncDir(dirname(lockPath));
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0 ? error.message : String(error);
    throw new Error(`remote lock apply committed the candidate lock but directory durability sync failed: ${detail}`);
  }
}

export function applyRemoteLockPlan(
  plan: RemoteLockPlan,
  lockPath: string,
  preconditions: RemoteLockApplyPreconditions,
  options: RemoteLockApplyOptions = {},
): void {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) throw new Error("invalid remote lock plan");
  assertExactKeys(plan as unknown as Record<string, unknown>, ["object_type", "schema_version", "payload", "digest"], "remote lock plan");
  if (plan.object_type !== "ega.remote-lock-plan" || plan.schema_version !== 1 || !verifyEnvelope(plan).ok) throw new Error("invalid remote lock plan");
  const payload = plan.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid remote lock plan payload");
  const payloadKeys = Object.keys(payload).sort();
  if (payloadKeys.join(",") !== "candidate_lock,changes,existing_lock_digest,project_config_digest,target_release_digest") throw new Error("invalid remote lock plan payload");
  assertDigest(payload.project_config_digest, "project_config_digest");
  assertDigest(payload.existing_lock_digest, "existing_lock_digest");
  assertDigest(payload.target_release_digest, "target_release_digest");
  if (preconditions === null || typeof preconditions !== "object" || Array.isArray(preconditions)) {
    throw new Error("remote lock apply requires current project preconditions");
  }
  assertDigest(preconditions.projectConfigDigest, "projectConfigDigest");
  // A plan bound to a different project configuration is a foreign plan.
  if (payload.project_config_digest !== preconditions.projectConfigDigest) {
    throw new Error("project config does not match the reviewed plan");
  }
  // A lock edited or replaced after planning makes the plan stale.
  if (digestProjectLock(preconditions.currentLock) !== payload.existing_lock_digest) {
    throw new Error("existing lock does not match the reviewed plan");
  }
  const candidate = validateLockfile(payload.candidate_lock, payload.project_config_digest);
  validateRemoteLockChanges(payload.changes, candidate);
  // The plan must describe the COMPLETE transition, not a caller-chosen subset.
  const expectedChanges = completeRemoteLockChanges(preconditions.currentLock, candidate);
  if (hashBytes(canonicalizeJson(payload.changes)) !== hashBytes(canonicalizeJson(expectedChanges))) {
    throw new Error("changes do not completely describe the lock transition");
  }
  writeLockAtomically(lockPath, serializeLockfile(candidate), options.syncDirectory ?? syncDirectory);
}
