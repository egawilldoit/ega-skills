// SPEC-005 §5.1.12 optional-lock semantics: LOCKED/UNLOCKED mode decision
// (EGA-586). Resolver wiring (EGA-587) is out of scope for this module.
//
// resolveLockMode decides whether a project runs LOCKED (a valid active lock
// governs every downstream version choice) or UNLOCKED (current local
// versions govern). Normative §5.1.12:
//
//   1. locking.required=false with a VALID present lock: the lock is honored
//      (LOCKED behavior, including E_LOCK_CONFIG_MISMATCH on a stale hash).
//   2. locking.required=false with NO lock: UNLOCKED behavior using current
//      local versions.
//   3. locking.required=true with a present lock: LOCKED — the lock is
//      authoritative regardless of the required flag.
//   4. locking.required=true with NO lock: E_LOCK_REQUIRED.
//   5. There is no implicit lock regeneration in any mode.
//
// Input contract: `config` is the NORMALIZED ProjectConfigV1 and `lock` is a
// VALIDATED ProjectLockV1 (post-validateLockfile) or null when no adjacent
// lock exists. Because validateLockfile enforces generated_from.config_hash
// equality even when locking.required=false, E_LOCK_CONFIG_MISMATCH is
// surfaced before this module ever runs — this module never re-validates,
// never consults installation state, and never mutates anything.
//
// guardExplicitSkill implements the explicit-skill gate (§5.1.9 rule 6,
// TEST-001 G039): under LOCKED mode it returns the locked version_hash for
// the canonical skill ID, and any explicit lookup that has no locked version
// is BLOCKED with E_LOCKED_VERSION_MISSING (the SPEC-004 VERSION_NOT_LOCKED
// negative reason is surfaced as this code here; the resolver NEVER falls
// forward to current/latest, §5.1.11). Under UNLOCKED mode there is
// definitionally nothing locked, so every explicit lookup misses with the
// same code. Note the empty-lock subtlety this gate makes explicit: a lock
// with `skills: {}` VALIDATES (§5.1.9 rule 6 — it is a valid LOCKED catalog
// with an empty eligible catalog: LOCKED, LOW confidence, selected=[], and
// any explicit skill blocked), so resolveLockMode returns LOCKED for it, yet
// guardExplicitSkill misses on EVERY lookup. Empty lock validates; every
// explicit lookup misses.

import type { ProjectConfigV1 } from "./config.js";
import {
  E_LOCKED_VERSION_MISSING,
  E_LOCK_REQUIRED,
  ProjectLockError,
} from "./lock.js";
import type { ProjectLockV1 } from "./lock.js";

/** LOCKED: a valid active lock governs every version choice (§5.1.12 rule 1). */
const LOCKED = "LOCKED" as const;
/** UNLOCKED: current local versions govern downstream (§5.1.12 rule 2). */
const UNLOCKED = "UNLOCKED" as const;

/** Frozen lock-mode values returned by resolveLockMode. */
export type ProjectLockMode = typeof LOCKED | typeof UNLOCKED;

/** Input to resolveLockMode: normalized config + validated lock (or null). */
export interface ResolveLockModeInput {
  /** Fully materialized normalized ProjectConfigV1 (post-normalizeProjectConfigV1). */
  readonly config: ProjectConfigV1;
  /** Validated active ProjectLockV1 (post-validateLockfile), or null when no adjacent lock exists. */
  readonly lock: ProjectLockV1 | null;
}

/** LOCKED outcome: the authoritative lock carries the frozen eligible catalog. */
export interface LockedModeData {
  readonly mode: typeof LOCKED;
  readonly lock: ProjectLockV1;
}

/** UNLOCKED outcome: no lock in force; current local versions govern. */
export interface UnlockedModeData {
  readonly mode: typeof UNLOCKED;
  readonly lock: null;
}

export type ResolveLockModeOutput = LockedModeData | UnlockedModeData;

/** Input to the explicit-skill gate (guardExplicitSkill). */
export interface GuardExplicitSkillInput {
  /** The mode decision from resolveLockMode for the active project. */
  readonly modeData: ResolveLockModeOutput;
  /** Canonical `<namespace>/<portable-name>` skill ID being explicitly requested. */
  readonly canonicalId: string;
}

/**
 * SPEC-005 §5.1.12 lock-mode decision. A non-null lock is ALWAYS
 * authoritative — LOCKED is returned even when `locking.required=false`
 * (rule 1); a null lock with `locking.required=true` throws
 * `E_LOCK_REQUIRED`; otherwise UNLOCKED (rule 2).
 */
export function resolveLockMode({ config, lock }: ResolveLockModeInput): ResolveLockModeOutput {
  if (lock !== null) {
    // Rule 1: a valid present lock is honored regardless of the required
    // flag — the lock is authoritative. Hash staleness was already rejected
    // by validateLockfile (E_LOCK_CONFIG_MISMATCH) before this module runs.
    return { mode: LOCKED, lock };
  }
  if (config.locking.required) {
    throw new ProjectLockError(
      E_LOCK_REQUIRED,
      `locking.required is true but no adjacent .egaskills.lock exists: the project is never unlocked when locking is required (SPEC-005 §5.1.12)`,
    );
  }
  // Rule 2: no lock, not required → UNLOCKED; current local versions govern.
  return { mode: UNLOCKED, lock: null };
}

/**
 * Explicit-skill gate (§5.1.9 rule 6, TEST-001 G039): returns the locked
 * immutable version_hash for `canonicalId`, or throws
 * `E_LOCKED_VERSION_MISSING` when the lookup cannot be satisfied — under
 * UNLOCKED mode (nothing is locked) and under LOCKED mode when the lock has
 * no entry for the skill (an empty `skills: {}` lock validates but every
 * explicit lookup misses). NEVER falls forward to current/latest (§5.1.11).
 */
export function guardExplicitSkill({ modeData, canonicalId }: GuardExplicitSkillInput): string {
  if (modeData.mode === UNLOCKED) {
    throw new ProjectLockError(
      E_LOCKED_VERSION_MISSING,
      `Skill ${JSON.stringify(canonicalId)} is not locked: the project is UNLOCKED (no active lock), so explicit locked-version resolution is blocked (VERSION_NOT_LOCKED)`,
    );
  }
  const entry = modeData.lock.skills[canonicalId];
  if (entry === undefined) {
    throw new ProjectLockError(
      E_LOCKED_VERSION_MISSING,
      `Skill ${JSON.stringify(canonicalId)} is not locked: the active lock has no version for it (VERSION_NOT_LOCKED; an empty lock skills:{} validates but every explicit lookup misses)`,
    );
  }
  return entry.version_hash;
}