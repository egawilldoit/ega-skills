// Contract E — immutable remote-project identities and single-release plans.
//
// This module is deliberately pure over validated project artifacts. It does
// not read or write project files and does not perform authentication. The
// hosted/control-plane adapters own those boundaries and must call these
// functions before publishing or selecting a context.

import { canonicalizeJson, hashBytes } from "@ega-skills/hashing";

import { verifyHubRelease, type HubRelease } from "./hub/release.js";
import { hashNormalizedConfig } from "./lock.js";
import type { ProjectConfigV1 } from "./config.js";
import type { ProjectLockV1 } from "./lock.js";

export const REMOTE_PROJECTS_CONTRACT_VERSION = 1 as const;

export const REMOTE_PROJECT_ERROR_CODES = Object.freeze({
  INVALID_CONTEXT: "E_CONTEXT_INVALID",
  CONTEXT_NOT_FOUND: "E_CONTEXT_NOT_FOUND",
  CONTEXT_REVOKED: "E_CONTEXT_REVOKED",
  CONTEXT_RELEASE_MISMATCH: "E_CONTEXT_RELEASE_MISMATCH",
  LOCK_RELEASE_MISMATCH: "E_LOCK_RELEASE_MISMATCH",
  PLAN_REVIEW_REQUIRED: "E_REMOTE_LOCK_REVIEW_REQUIRED",
  FINGERPRINT_INVALID: "E_FINGERPRINT_INVALID",
} as const);

export type RemoteProjectErrorCode = (typeof REMOTE_PROJECT_ERROR_CODES)[keyof typeof REMOTE_PROJECT_ERROR_CODES];

export class RemoteProjectError extends Error {
  readonly code: RemoteProjectErrorCode;

  constructor(code: RemoteProjectErrorCode, message: string) {
    super(message);
    this.name = "RemoteProjectError";
    this.code = code;
  }
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function remoteError(code: RemoteProjectErrorCode, message: string): never {
  throw new RemoteProjectError(code, message);
}

function assertId(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `${field} must be a non-empty text identity`);
  }
}

function assertDigest(value: string | null, field: string): void {
  if (value !== null && !DIGEST_RE.test(value)) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `${field} must be sha256:<64 lowercase hex> or null`);
  }
}

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function freezeLock(lock: ProjectLockV1): ProjectLockV1 {
  const skills = Object.fromEntries(
    Object.entries(lock.skills)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([skillId, entry]) => [skillId, freezeRecord({ name: entry.name, version_hash: entry.version_hash })]),
  ) as Record<string, ProjectLockV1["skills"][string]>;
  return freezeRecord({
    lockfile_version: lock.lockfile_version,
    token_estimator: lock.token_estimator,
    generated_from: freezeRecord({ config_hash: lock.generated_from.config_hash }),
    skills: Object.freeze(skills),
  });
}

function assertExactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `${field} has unexpected or missing fields`);
  }
}

function digestCanonical(value: unknown): string {
  return hashBytes(canonicalizeJson(value));
}

export interface ProjectContextArtifact {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly config_digest: string;
  readonly lock_digest: string;
  readonly release_digest: string;
  readonly fingerprint_digest: string | null;
  readonly context_contract_version: 1;
}

export interface ProjectContext extends ProjectContextArtifact {
  readonly context_digest: string;
}

export interface ProjectContextCacheIdentityInput {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly context_id: string;
  readonly config_digest: string;
  readonly lock_digest: string;
  readonly release_digest: string;
  readonly fingerprint_digest: string | null;
  readonly router_contract_version: number;
  readonly search_contract_version: number;
  readonly task: string | null;
  readonly query: string | null;
  readonly explicit_skills: readonly string[];
  readonly max_skills: number | null;
  readonly max_tokens: number | null;
  readonly policy_digest: string | null;
}

export interface ProjectContextCacheIdentity extends ProjectContextCacheIdentityInput {
  readonly cache_identity_digest: string;
}

export interface CreateProjectContextInput {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly config: ProjectConfigV1;
  readonly lock: ProjectLockV1;
  readonly release: HubRelease;
  readonly fingerprint_digest?: string | null;
}

export function hashProjectLock(lock: ProjectLockV1): string {
  return digestCanonical(lock);
}

export function createProjectContextCacheIdentity(
  input: ProjectContextCacheIdentityInput,
): ProjectContextCacheIdentity {
  assertId(input.workspace_id, "workspace_id");
  assertId(input.project_id, "project_id");
  assertId(input.context_id, "context_id");
  for (const field of [
    "config_digest",
    "lock_digest",
    "release_digest",
  ] as const) {
    if (!DIGEST_RE.test(input[field])) remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `${field} is not a digest identity`);
  }
  assertDigest(input.fingerprint_digest, "fingerprint_digest");
  assertDigest(input.policy_digest, "policy_digest");
  if (!Number.isInteger(input.router_contract_version) || !Number.isInteger(input.search_contract_version)) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "cache contract versions must be integers");
  }
  const artifact = freezeRecord({
    workspace_id: input.workspace_id,
    project_id: input.project_id,
    context_id: input.context_id,
    config_digest: input.config_digest,
    lock_digest: input.lock_digest,
    release_digest: input.release_digest,
    fingerprint_digest: input.fingerprint_digest,
    router_contract_version: input.router_contract_version,
    search_contract_version: input.search_contract_version,
    task: input.task,
    query: input.query,
    explicit_skills: Object.freeze([...input.explicit_skills].sort()),
    max_skills: input.max_skills,
    max_tokens: input.max_tokens,
    policy_digest: input.policy_digest,
  });
  return freezeRecord({ ...artifact, cache_identity_digest: digestCanonical(artifact) });
}

export function createProjectContextArtifact(input: CreateProjectContextInput): ProjectContext {
  assertId(input.workspace_id, "workspace_id");
  assertId(input.project_id, "project_id");
  verifyHubRelease(input.release);
  const configDigest = hashNormalizedConfig(input.config);
  if (input.lock.generated_from.config_hash !== configDigest) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "lock does not bind the supplied normalized project config");
  }
  const fingerprintDigest = input.fingerprint_digest ?? null;
  assertDigest(fingerprintDigest, "fingerprint_digest");
  assertLockInRelease(input.lock, input.release);
  const artifact: ProjectContextArtifact = freezeRecord({
    workspace_id: input.workspace_id,
    project_id: input.project_id,
    config_digest: configDigest,
    lock_digest: hashProjectLock(input.lock),
    release_digest: input.release.digest,
    fingerprint_digest: fingerprintDigest,
    context_contract_version: REMOTE_PROJECTS_CONTRACT_VERSION,
  });
  return freezeRecord({ ...artifact, context_digest: digestCanonical(artifact) });
}

export function verifyProjectContext(context: ProjectContext): void {
  if (typeof context !== "object" || context === null) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "context must be an object");
  }
  assertExactKeys(context, [
    "workspace_id",
    "project_id",
    "config_digest",
    "lock_digest",
    "release_digest",
    "fingerprint_digest",
    "context_contract_version",
    "context_digest",
  ], "context");
  assertId(context.workspace_id, "workspace_id");
  assertId(context.project_id, "project_id");
  if (context.context_contract_version !== REMOTE_PROJECTS_CONTRACT_VERSION) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "unsupported context contract version");
  }
  for (const field of ["config_digest", "lock_digest", "release_digest", "context_digest"] as const) {
    if (!DIGEST_RE.test(context[field])) remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `${field} is not a digest identity`);
  }
  assertDigest(context.fingerprint_digest, "fingerprint_digest");
  const { context_digest: actual, ...artifact } = context;
  if (digestCanonical(artifact) !== actual) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "context_digest does not match its canonical artifact");
  }
}

export function assertLockInRelease(lock: ProjectLockV1, release: HubRelease): void {
  verifyHubRelease(release);
  for (const [skillId, entry] of Object.entries(lock.skills)) {
    if (release.payload.skill_versions[skillId] !== entry.version_hash) {
      remoteError(
        REMOTE_PROJECT_ERROR_CODES.LOCK_RELEASE_MISMATCH,
        `lock entry ${skillId}@${entry.version_hash} is not contained in HubRelease ${release.digest}`,
      );
    }
  }
}

export interface RemoteLockChange {
  readonly skill_id: string;
  readonly previous_version_hash: string;
  readonly candidate_version_hash: string;
}

export interface RemoteLockPlanArtifact {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly project_config_digest: string;
  readonly existing_lock_digest: string | null;
  readonly target_release_digest: string;
  readonly candidate_lock: ProjectLockV1;
  readonly added_entries: readonly string[];
  readonly removed_entries: readonly string[];
  readonly changed_entries: readonly RemoteLockChange[];
  readonly fingerprint_digest: string | null;
}

export interface RemoteLockPlan extends RemoteLockPlanArtifact {
  readonly plan_digest: string;
}

export interface CreateRemoteLockPlanInput {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly config: ProjectConfigV1;
  readonly existing_lock: ProjectLockV1 | null;
  readonly candidate_lock: ProjectLockV1;
  readonly target_release: HubRelease;
  readonly fingerprint_digest?: string | null;
}

export function createRemoteLockPlan(input: CreateRemoteLockPlanInput): RemoteLockPlan {
  assertId(input.workspace_id, "workspace_id");
  assertId(input.project_id, "project_id");
  verifyHubRelease(input.target_release);
  const configDigest = hashNormalizedConfig(input.config);
  if (input.candidate_lock.generated_from.config_hash !== configDigest) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "candidate lock does not bind the supplied project config");
  }
  if (input.existing_lock !== null && input.existing_lock.generated_from.config_hash !== configDigest) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "existing lock does not bind the supplied project config");
  }
  assertLockInRelease(input.candidate_lock, input.target_release);
  const oldSkills = input.existing_lock?.skills ?? {};
  const newSkills = input.candidate_lock.skills;
  const addedEntries = Object.keys(newSkills).filter((skillId) => oldSkills[skillId] === undefined).sort();
  const removedEntries = Object.keys(oldSkills).filter((skillId) => newSkills[skillId] === undefined).sort();
  const changedEntries = Object.keys(newSkills)
    .filter((skillId) => oldSkills[skillId] !== undefined && oldSkills[skillId]?.version_hash !== newSkills[skillId]?.version_hash)
    .sort()
    .map((skillId) => freezeRecord({
      skill_id: skillId,
      previous_version_hash: oldSkills[skillId]!.version_hash,
      candidate_version_hash: newSkills[skillId]!.version_hash,
    }));
  const fingerprintDigest = input.fingerprint_digest ?? null;
  assertDigest(fingerprintDigest, "fingerprint_digest");
  const artifact: RemoteLockPlanArtifact = freezeRecord({
    workspace_id: input.workspace_id,
    project_id: input.project_id,
    project_config_digest: configDigest,
    existing_lock_digest: input.existing_lock === null ? null : hashProjectLock(input.existing_lock),
    target_release_digest: input.target_release.digest,
    candidate_lock: freezeLock(input.candidate_lock),
    added_entries: Object.freeze(addedEntries),
    removed_entries: Object.freeze(removedEntries),
    changed_entries: Object.freeze(changedEntries),
    fingerprint_digest: fingerprintDigest,
  });
  return freezeRecord({ ...artifact, plan_digest: digestCanonical(artifact) });
}

export function verifyRemoteLockPlan(plan: RemoteLockPlan): void {
  if (typeof plan !== "object" || plan === null) {
    remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "remote lock plan must be an object");
  }
  assertExactKeys(plan, [
    "workspace_id",
    "project_id",
    "project_config_digest",
    "existing_lock_digest",
    "target_release_digest",
    "candidate_lock",
    "added_entries",
    "removed_entries",
    "changed_entries",
    "fingerprint_digest",
    "plan_digest",
  ], "remote lock plan");
  assertId(plan.workspace_id, "workspace_id");
  assertId(plan.project_id, "project_id");
  for (const field of ["project_config_digest", "target_release_digest", "plan_digest"] as const) {
    if (!DIGEST_RE.test(plan[field])) remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `${field} is not a digest identity`);
  }
  assertDigest(plan.existing_lock_digest, "existing_lock_digest");
  assertDigest(plan.fingerprint_digest, "fingerprint_digest");
  const { plan_digest: actual, ...artifact } = plan;
  if (digestCanonical(artifact) !== actual) remoteError(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "plan_digest does not match its canonical artifact");
}
