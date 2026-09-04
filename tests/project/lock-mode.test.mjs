// SPEC-005 §5.1.12 optional-lock semantics + §5.1.9 rule 6 empty-lock gate
// (EGA-586). Pure node:test suite — no filesystem, no network.
//
// Covers the normative inventory: empty `skills: {}` lock validates and is
// LOCKED while every explicit lookup misses (TEST-001 G039); a valid lock is
// honored even when locking.required=false (§5.1.12 rule 1); no lock +
// required=false → UNLOCKED (§5.1.12 rule 2); no lock + required=true →
// E_LOCK_REQUIRED; a stale-hash lock surfaces E_LOCK_CONFIG_MISMATCH via
// validateLockfile before resolveLockMode ever sees it. Tests import the
// built package (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import test from "node:test";

import {
  E_LOCK_CONFIG_MISMATCH,
  E_LOCK_REQUIRED,
  E_LOCKED_VERSION_MISSING,
  ProjectLockError,
  guardExplicitSkill,
  hashNormalizedConfig,
  parseProjectConfig,
  resolveLockMode,
  validateLockfile,
} from "../../packages/project/dist/index.js";

const VHASH = (hex) => `sha256:${hex}`;
const HEX_64 = "ab".repeat(32); // 64 lowercase hex chars
const HEX_64_B = "cd".repeat(32); // a different 64 lowercase hex string

/** Asserts the call throws a ProjectLockError with the frozen code. */
function expectLockError(fn, code, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ProjectLockError, `expected ProjectLockError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

/**
 * Builds a raw parsed-unknown lock value (what the YAML parser would hand to
 * validateLockfile) with the given overrides merged over a valid base.
 */
function rawLock({
  configHash = VHASH(HEX_64),
  estimator = "ega-o200k-v1",
  skills = {},
  generatedFrom,
  ...rest
} = {}) {
  const base = {
    lockfile_version: 1,
    token_estimator: estimator,
    generated_from: generatedFrom === undefined ? { config_hash: configHash } : generatedFrom,
    skills,
  };
  return { ...base, ...rest };
}

/** Validates a raw lock against the normalized config it claims to match. */
function lockFor(config, raw) {
  return validateLockfile(raw, hashNormalizedConfig(config));
}

/**
 * Raw lock value whose generated_from.config_hash is the REAL §5.1.8 hash of
 * `config` (so validation passes), with optional overrides for the skills.
 */
function rawLockFor(config, overrides = {}) {
  return rawLock({ configHash: hashNormalizedConfig(config), ...overrides });
}

/** Normalized configs: default (required=false) and required=true. */
const UNLOCKED_CONFIG = parseProjectConfig("{}");
const REQUIRED_CONFIG = parseProjectConfig("{locking: {required: true}}");

// ---------------------------------------------------------------------------
// §5.1.12 rule 1: a valid present lock is honored even when required=false
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.12 rule 1: required=false + valid non-empty lock → LOCKED with the lock", () => {
  const raw = rawLockFor(UNLOCKED_CONFIG, {
    skills: {
      "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64) },
      "acme/beta": { name: "beta", version_hash: VHASH(HEX_64_B) },
    },
  });
  const lock = lockFor(UNLOCKED_CONFIG, raw);

  const mode = resolveLockMode({ config: UNLOCKED_CONFIG, lock });
  assert.equal(mode.mode, "LOCKED");
  assert.equal(mode.lock, lock);
  // The lock is authoritative: the locked hash is what the explicit gate returns.
  assert.equal(guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }), VHASH(HEX_64));
  assert.equal(guardExplicitSkill({ modeData: mode, canonicalId: "acme/beta" }), VHASH(HEX_64_B));
});

test("SPEC-005 §5.1.12 rule 1: required=false + valid EMPTY lock skills:{} → LOCKED but every explicit lookup misses", () => {
  // §5.1.9 rule 6: `skills: {}` is a VALID active lock — it validates and the
  // mode is LOCKED (eligible catalog empty).
  const lock = lockFor(UNLOCKED_CONFIG, rawLockFor(UNLOCKED_CONFIG));
  assert.deepEqual(lock.skills, {});

  const mode = resolveLockMode({ config: UNLOCKED_CONFIG, lock });
  assert.equal(mode.mode, "LOCKED");
  assert.equal(mode.lock, lock);

  // An empty catalog contains no entries: every explicit lookup is blocked
  // (TEST-001 G039, VERSION_NOT_LOCKED surfaced as E_LOCKED_VERSION_MISSING).
  expectLockError(
    () => guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }),
    E_LOCKED_VERSION_MISSING,
    /VERSION_NOT_LOCKED/,
  );
});

test("SPEC-005 §5.1.12 rule 3: required=true + valid lock → LOCKED (lock is authoritative)", () => {
  const lock = lockFor(REQUIRED_CONFIG, rawLockFor(REQUIRED_CONFIG, { skills: { "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64) } } }));
  const mode = resolveLockMode({ config: REQUIRED_CONFIG, lock });
  assert.equal(mode.mode, "LOCKED");
  assert.equal(mode.lock, lock);
  assert.equal(guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }), VHASH(HEX_64));
});

// ---------------------------------------------------------------------------
// §5.1.12 rule 2: no lock + required=false → UNLOCKED
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.12 rule 2: required=false + null lock → UNLOCKED with lock null", () => {
  const mode = resolveLockMode({ config: UNLOCKED_CONFIG, lock: null });
  assert.equal(mode.mode, "UNLOCKED");
  assert.equal(mode.lock, null);
  // UNLOCKED: nothing is locked — an explicit lookup has no locked version.
  expectLockError(
    () => guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }),
    E_LOCKED_VERSION_MISSING,
    /UNLOCKED/,
  );
});

// ---------------------------------------------------------------------------
// §5.1.12 rule 3: no lock + required=true → E_LOCK_REQUIRED
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.12: required=true + null lock → throws E_LOCK_REQUIRED", () => {
  expectLockError(
    () => resolveLockMode({ config: REQUIRED_CONFIG, lock: null }),
    E_LOCK_REQUIRED,
    /locking\.required is true/,
  );
});

// ---------------------------------------------------------------------------
// §5.1.12 rule 1: stale-hash lock → E_LOCK_CONFIG_MISMATCH via validateLockfile
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.12 rule 1: required=true + mismatched lock surfaces E_LOCK_CONFIG_MISMATCH via validateLockfile", () => {
  // The lock was generated from a DIFFERENT config hash than the active one.
  const raw = rawLock({ configHash: VHASH(HEX_64_B) });
  // The mode decision can never see a mismatched lock: validation rejects the
  // stale hash first, even under required=true (rule 1 text: including
  // E_LOCK_CONFIG_MISMATCH on stale hash; §5.1.9 rule 3).
  expectLockError(
    () => lockFor(REQUIRED_CONFIG, raw),
    E_LOCK_CONFIG_MISMATCH,
    /different config/,
  );
});

test("SPEC-005 §5.1.12 rule 1: required=false + mismatched lock also surfaces E_LOCK_CONFIG_MISMATCH", () => {
  const raw = rawLock({ configHash: VHASH(HEX_64_B) });
  expectLockError(
    () => lockFor(UNLOCKED_CONFIG, raw),
    E_LOCK_CONFIG_MISMATCH,
    /different config/,
  );
});

// ---------------------------------------------------------------------------
// guardExplicitSkill extras: blocked lookups never fall forward
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.11: explicit lookup for an unlisted skill under LOCKED → E_LOCKED_VERSION_MISSING, never fall forward", () => {
  const lock = lockFor(UNLOCKED_CONFIG, rawLockFor(UNLOCKED_CONFIG, { skills: { "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64) } } }));
  const mode = resolveLockMode({ config: UNLOCKED_CONFIG, lock });
  expectLockError(
    () => guardExplicitSkill({ modeData: mode, canonicalId: "acme/unlisted" }),
    E_LOCKED_VERSION_MISSING,
    /not locked/,
  );
  // ...while a listed skill still resolves to its locked hash.
  assert.equal(guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }), VHASH(HEX_64));
});

test("guardExplicitSkill returns the exact locked version_hash (immutable identity)", () => {
  const lock = lockFor(UNLOCKED_CONFIG, rawLockFor(UNLOCKED_CONFIG, { skills: { "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64) } } }));
  const mode = resolveLockMode({ config: UNLOCKED_CONFIG, lock });
  assert.match(guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }), /^sha256:[0-9a-f]{64}$/);
  assert.equal(guardExplicitSkill({ modeData: mode, canonicalId: "acme/alpha" }), VHASH(HEX_64));
});