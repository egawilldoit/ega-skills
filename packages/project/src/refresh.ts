// SPEC-005 §5.1.9–§5.1.10 eligible-catalog lock generation/refresh (EGA-585).
//
// refreshLock is the pure, fail-closed eligible-catalog generator: it reads
// ONLY the local registry at `input.registryHome`, applies ONLY the §5.1.10
// rule-2 eligibility filters, and returns a fresh normalized `ProjectLockV1`
// plus a deterministic diff vs the previous lock. It NEVER writes files (the
// CLI serializes the returned lock; a failed call changes nothing on disk),
// it NEVER contacts the network, and it NEVER mutates the registry.
//
// Eligibility (exactly §5.1.10 rules 2–4, nothing else):
//  - the full local CURRENT-version catalog (AMEND-03), one entry per
//    eligible canonical skill at exactly its current version hash (rule 3);
//  - project policy (§5.1.7): `namespaces.allow` must contain the skill's
//    namespace when non-empty, and `namespaces.deny` (namespace) plus
//    `skills.deny` (canonical ID) exclude. Deny always wins over allow.
//    `skills.prefer` NEVER filters, and task text, fingerprint, FTS rank,
//    redundancy, and token budget NEVER enter eligibility (rule 2);
//  - integrity is FAIL-CLOSED (rule 4): a `current_version_hash` with no
//    matching immutable `skill_versions` row throws `E_VERSION_NOT_FOUND`;
//    a manifest blob that is not parseable/canonical JCS or whose bytes do
//    not hash to the version hash, or any required file blob that is missing
//    or whose bytes do not hash to its `blob_hash`, throws
//    `E_CACHE_HASH_MISMATCH`. A broken eligible skill is NEVER silently
//    omitted to emit a deceptively complete lock.
//
// The emitted lock matches the §5.1.9 schema exactly (skill keys sorted
// ascending, `name` == portable-name component, `version_hash` == the
// current version hash, `generated_from.config_hash` == §5.1.8
// hashNormalizedConfig(config)) and validates with `validateLockfile` as-is.
//
// Diff semantics: `added` (+), `removed` (-), `changed` (~) carry canonical
// skill IDs only, each list deterministically sorted ascending by UTF-16
// code units. With no previous lock, every eligible skill is `added`.
// Regeneration failure returns nothing at all — it throws, so an existing
// lock is left UNCHANGED (rule 4; writing is the CLI's job, out of scope).

import { canonicalizeJson, hashBytes } from "@ega-skills/hashing";
import {
  RegistryError,
  getCacheBlob,
  getSkillVersion,
  openRegistry,
} from "@ega-skills/registry";

import type { ProjectConfigV1 } from "./config.js";
import {
  TOKEN_ESTIMATOR_EGA_O200K_V1,
  hashNormalizedConfig,
  type ProjectLockEntryV1,
  type ProjectLockV1,
} from "./lock.js";

/** Frozen integrity codes (SPEC-003-owned, reused by §5.1.10 rule 4 — SPEC-005 §5.2). */
export const E_VERSION_NOT_FOUND = "E_VERSION_NOT_FOUND" as const;
export const E_CACHE_HASH_MISMATCH = "E_CACHE_HASH_MISMATCH" as const;

export interface RefreshLockInput {
  /** Registry home directory (= the EGA_SKILLS_HOME value). Never the process env. */
  readonly registryHome: string;
  /** Fully normalized ProjectConfigV1; hashed verbatim via §5.1.8. */
  readonly config: ProjectConfigV1;
}

/** Deterministic eligible-catalog diff vs the previous lock (§5.1.10 rule 6). */
export interface RefreshLockDiff {
  /** Canonical IDs present in the new lock, absent in the previous (plus `+`). */
  readonly added: readonly string[];
  /** Canonical IDs present in the previous lock, absent in the new (minus `-`). */
  readonly removed: readonly string[];
  /** Canonical IDs in both locks whose version_hash moved (tilde `~`). */
  readonly changed: readonly string[];
}

export interface RefreshLockResult {
  /** Fresh normalized V1 lock over the eligible current catalog. */
  readonly lock: ProjectLockV1;
  /** Deterministic diff of this lock vs `previousLock` (all-added when none). */
  readonly diff: RefreshLockDiff;
}

interface SkillCatalogRow {
  readonly skill_id: string;
  readonly namespace: string;
  readonly name: string;
  readonly current_version_hash: string;
}

interface SkillFileRow {
  readonly blob_hash: string;
}

/** Ascending UTF-16 code-unit comparison: deterministic lock/diff ordering. */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * §5.1.10 rule 4 manifest check: the stored `manifest_json` is canonical
 * RFC 8785 JCS text whose SHA-256 IS the version hash (SPEC-002 §5.1.x).
 * Unparseable/non-canonical bytes or a hash mismatch fail closed with
 * E_CACHE_HASH_MISMATCH — the manifest is a REQUIRED blob.
 */
function verifyManifestBlob(skillId: string, manifestJson: string, versionHash: string): void {
  let canonical: Uint8Array;
  try {
    canonical = canonicalizeJson(JSON.parse(manifestJson));
  } catch {
    throw new RegistryError(
      E_CACHE_HASH_MISMATCH,
      `Manifest blob for skill ${JSON.stringify(skillId)} at version ${versionHash} is not canonical JCS JSON (fail-closed: its bytes must hash to the version hash).`,
    );
  }
  if (hashBytes(canonical) !== versionHash) {
    throw new RegistryError(
      E_CACHE_HASH_MISMATCH,
      `Manifest blob for skill ${JSON.stringify(skillId)} does not hash to its version ${versionHash} (fail-closed: broken manifest never enters the lock).`,
    );
  }
}

/** Diff of a fresh lock vs the previous one; all-added when none is given. */
function computeDiff(lock: ProjectLockV1, previousLock: ProjectLockV1 | undefined): RefreshLockDiff {
  const current = lock.skills;
  const previous = previousLock === undefined ? {} : previousLock.skills;

  const added: string[] = [];
  const changed: string[] = [];
  for (const skillId of Object.keys(current).sort(compareUtf16)) {
    const previousEntry = previous[skillId];
    if (previousEntry === undefined) {
      added.push(skillId);
    } else if (previousEntry.version_hash !== current[skillId]!.version_hash) {
      changed.push(skillId);
    }
  }
  const removed = Object.keys(previous)
    .filter((skillId) => current[skillId] === undefined)
    .sort(compareUtf16);

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
  });
}

/**
 * Regenerates the eligible-catalog lock (SPEC-005 §5.1.10): enumerates the
 * local CURRENT-version catalog under `input.registryHome`, keeps exactly the
 * policy-eligible skills whose current version row and required blobs verify
 * (fail-closed), and returns the fresh normalized `ProjectLockV1` plus the
 * deterministic `+`/`-`/`~` diff vs `previousLock`. Pure: never writes files,
 * never touches the network, never mutates the registry. The caller closes
 * nothing — the internal registry handle is always closed before returning
 * or throwing.
 */
export function refreshLock(input: RefreshLockInput, previousLock?: ProjectLockV1): RefreshLockResult {
  // The input registryHome is authoritative — process env EGA_SKILLS_HOME is
  // NEVER consulted (isolated test registries rely on this).
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: input.registryHome } });
  try {
    const db = registry.db;

    // §5.1.7 project policy. allow = whitelist when non-empty; deny wins.
    const namespaceAllow = new Set(input.config.namespaces.allow);
    const namespaceDeny = new Set(input.config.namespaces.deny);
    const skillDeny = new Set(input.config.skills.deny);

    // Full catalog, deterministic order (canonical IDs sort identically by
    // ASCII and UTF-16, so this is also the emitted lock key order).
    const rows = db
      .prepare("SELECT skill_id, namespace, name, current_version_hash FROM skills ORDER BY skill_id ASC")
      .all<SkillCatalogRow>();

    const entries: Record<string, ProjectLockEntryV1> = {};
    for (const row of rows) {
      // Policy first (cheap, local, no integrity dependencies).
      if (namespaceDeny.has(row.namespace)) continue;
      if (namespaceAllow.size > 0 && !namespaceAllow.has(row.namespace)) continue;
      if (skillDeny.has(row.skill_id)) continue;

      // Rule 4 fail-closed, skill by skill:
      // - the current pointer MUST resolve to a real immutable version row
      //   (E_VERSION_NOT_FOUND when it does not);
      // - the required manifest blob MUST hash to the version hash
      //   (E_CACHE_HASH_MISMATCH otherwise);
      // - every required file blob MUST be present and byte-exact
      //   (E_CACHE_HASH_MISMATCH on missing or corrupt cache entries).
      const version = getSkillVersion(db, row.skill_id, row.current_version_hash);
      verifyManifestBlob(row.skill_id, version.manifestJson, version.versionHash);
      const files = db
        .prepare("SELECT blob_hash FROM skill_files WHERE skill_id = ? AND version_hash = ?")
        .all<SkillFileRow>(row.skill_id, version.versionHash);
      for (const file of files) {
        getCacheBlob(registry.paths.cacheSha256, file.blob_hash);
      }

      entries[row.skill_id] = Object.freeze({
        name: row.name, // == portable-name component of the key by importer construction
        version_hash: version.versionHash, // exactly the current version hash (rule 3)
      });
    }

    const lock: ProjectLockV1 = Object.freeze({
      lockfile_version: 1,
      token_estimator: TOKEN_ESTIMATOR_EGA_O200K_V1,
      generated_from: Object.freeze({
        config_hash: hashNormalizedConfig(input.config),
      }),
      skills: Object.freeze(entries),
    });

    return { lock, diff: computeDiff(lock, previousLock) };
  } finally {
    registry.close();
  }
}