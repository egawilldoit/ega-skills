// SPEC-005 §5.1.8–§5.1.11, §5.1.14 config hash + lockfile validation (EGA-584).
//
// Covers the normative inventory: sha256:<64 hex> hash stability and format,
// omitted-vs-explicit-defaults identical hashing, policy-order-insensitive
// hashing (post-normalization input), the frozen E_PROJECT_LOCK_INVALID /
// E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED / E_LOCK_CONFIG_MISMATCH /
// E_LOCKED_VERSION_MISSING codes, deterministic sorted skill key enforcement,
// the estimator gate, the expected-config-hash mismatch parameter, and the
// §5.1.14 control-file guards (symlink rejection, NUL/non-text rejection,
// missing-file fail-closed, no-config behavior).
//
// validateLockfile is exercised with raw parsed-JS values (its contract is
// the parsed-unknown input); readConfigAndLock exercises the real YAML text
// path through temp-directory control files. Tests import the built package
// (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  E_LOCK_CONFIG_MISMATCH,
  E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED,
  E_LOCKED_VERSION_MISSING,
  E_PROJECT_CONFIG_INVALID,
  E_PROJECT_LOCK_INVALID,
  ProjectConfigError,
  ProjectLockError,
  discoverConfig,
  hashNormalizedConfig,
  lockedVersionFor,
  parseProjectConfig,
  readConfigAndLock,
  validateLockfile,
} from "../../packages/project/dist/index.js";

const VHASH = (hex) => `sha256:${hex}`;
const HEX_64 = "ab".repeat(32); // 64 lowercase hex chars
const HEX_64_B = "cd".repeat(32); // a different 64 lowercase hex string

/** Asserts the input fails with the frozen E_PROJECT_LOCK_INVALID code. */
function expectLockInvalid(fn, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ProjectLockError, `expected ProjectLockError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, E_PROJECT_LOCK_INVALID);
    assert.equal(err.name, "ProjectLockError");
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

/** Asserts the input fails with the frozen E_PROJECT_CONFIG_INVALID code. */
function expectConfigInvalid(fn, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ProjectConfigError, `expected ProjectConfigError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, E_PROJECT_CONFIG_INVALID);
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
    // Only the omitted case gets a valid default: an explicitly passed
    // generated_from (even empty) is used verbatim so missing-field
    // branches are actually exercised.
    generated_from: generatedFrom === undefined ? { config_hash: configHash } : generatedFrom,
    skills,
  };
  return { ...base, ...rest };
}

const TWO_SKILLS = {
  "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64) },
  "acme/beta": { name: "beta", version_hash: VHASH(HEX_64_B) },
};

// ---------------------------------------------------------------------------
// §5.1.8 config hash
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.8: hash is sha256:<64 lowercase hex> and stable across calls", () => {
  const config = parseProjectConfig("{}");
  const hash = hashNormalizedConfig(config);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  // Deterministic: same input, same hash, every call.
  assert.equal(hashNormalizedConfig(config), hash);
  assert.equal(hashNormalizedConfig(parseProjectConfig("{}")), hash);
  // Different configs hash differently.
  assert.notEqual(hashNormalizedConfig(parseProjectConfig("routing:\n  max_skills: 2\n")), hash);
});

test("SPEC-005 §5.1.8 rule 2: omitted and explicitly-written defaults hash identically", () => {
  const minimal = parseProjectConfig("{}");
  const explicit = parseProjectConfig(
    "schema_version: 1\n" +
      "routing:\n  mode: suggest\n  max_skills: 3\n  max_tokens: 5000\n" +
      "namespaces:\n  allow: []\n  deny: []\n" +
      "skills:\n  prefer: []\n  deny: []\n" +
      "locking:\n  required: false\n",
  );
  assert.deepEqual(explicit, minimal); // same normalized object
  assert.equal(hashNormalizedConfig(explicit), hashNormalizedConfig(minimal));
  // Partial explicit fields match the same single hash as well.
  assert.equal(hashNormalizedConfig(parseProjectConfig("routing:\n  mode: suggest\n")), hashNormalizedConfig(minimal));
});

test("SPEC-005 §5.1.8/§5.1.6 rule 3: policy list order is normalized before hashing (order-insensitive hash)", () => {
  const unsorted = parseProjectConfig(
    "namespaces:\n  allow: [b-ns, a-ns, b-ns]\n  deny: [z-ns]\n" +
      "skills:\n  prefer: [z/zed, a/alpha, z/zed]\n  deny: [m/mike]\n",
  );
  const sortedOtherOrder = parseProjectConfig(
    "namespaces:\n  allow: [a-ns, b-ns]\n  deny: [z-ns]\n" +
      "skills:\n  prefer: [a/alpha, z/zed]\n  deny: [m/mike]\n",
  );
  assert.deepEqual(unsorted, sortedOtherOrder); // dedupe + UTF-16 sort in normalization
  assert.equal(hashNormalizedConfig(unsorted), hashNormalizedConfig(sortedOtherOrder));
});

// ---------------------------------------------------------------------------
// §5.1.9 valid lock validation + normalization
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.9: a valid V1 lock validates and normalizes to a frozen lock object", () => {
  const config = parseProjectConfig("{}");
  const configHash = hashNormalizedConfig(config);
  const lock = validateLockfile(rawLock({ configHash, skills: TWO_SKILLS }), configHash);

  assert.equal(lock.lockfile_version, 1);
  assert.equal(lock.token_estimator, "ega-o200k-v1");
  assert.equal(lock.generated_from.config_hash, configHash);
  assert.deepEqual(Object.keys(lock.skills), ["acme/alpha", "acme/beta"]);
  assert.deepEqual(lock.skills["acme/alpha"], { name: "alpha", version_hash: VHASH(HEX_64) });
  assert.deepEqual(lock.skills["acme/beta"], { name: "beta", version_hash: VHASH(HEX_64_B) });
  // Deep-frozen.
  assert.ok(Object.isFrozen(lock));
  assert.ok(Object.isFrozen(lock.generated_from));
  assert.ok(Object.isFrozen(lock.skills));
  assert.ok(Object.isFrozen(lock.skills["acme/alpha"]));
});

test("SPEC-005 §5.1.9 rule 6: skills: {} (empty lock) is a VALID active lock", () => {
  const configHash = hashNormalizedConfig(parseProjectConfig("{}"));
  const lock = validateLockfile(rawLock({ configHash, skills: {} }), configHash);
  assert.deepEqual(lock.skills, {});
  assert.equal(Object.keys(lock.skills).length, 0);
});

// ---------------------------------------------------------------------------
// E_PROJECT_LOCK_INVALID
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.9 rule 1: lockfile_version must be 1", () => {
  for (const version of [2, 0, "1", null, {}]) {
    expectLockInvalid(() => validateLockfile(rawLock({ lockfile_version: version }), VHASH(HEX_64)), /lockfile_version must be 1/);
  }
});

test("SPEC-005 §5.1.14 rule 3: bad shapes and unknown semantic keys are rejected, never ignored", () => {
  const hash = VHASH(HEX_64);
  expectLockInvalid(() => validateLockfile("not-a-mapping", hash), /top level must be a YAML mapping/);
  expectLockInvalid(() => validateLockfile(null, hash), /top level must be a YAML mapping/);
  expectLockInvalid(() => validateLockfile([], hash), /top level must be a YAML mapping/);
  expectLockInvalid(() => validateLockfile(rawLock({ extra: 1 }), hash), /unsupported key "extra"/);
  expectLockInvalid(() => validateLockfile(rawLock({ skills: "nope" }), hash), /"skills" must be a YAML mapping/);
  expectLockInvalid(() => validateLockfile(rawLock({ generatedFrom: {} }), hash), /"generated_from.config_hash" must be a string/);
  expectLockInvalid(
    () => validateLockfile(rawLock({ generatedFrom: { config_hash: "sha256:zz" } }), hash),
    /config_hash" must be sha256:<64 lowercase hex>/,
  );
  expectLockInvalid(() => validateLockfile(rawLock({ generatedFrom: { config_hash: VHASH(HEX_64), extra: 1 } }), hash), /unsupported key "extra"/);
  expectLockInvalid(() => validateLockfile(rawLock({ token_estimator: 42, estimator: 42 }), hash), /"token_estimator" must be a string/);
  expectLockInvalid(() => validateLockfile(rawLock({ token_estimator: null, estimator: null }), hash), /"token_estimator" must be a string/);
  expectLockInvalid(() => validateLockfile(rawLock({ skills: { "acme/alpha": 42 } }), hash), /must be a YAML mapping/);
  // NO unknown entry fields exist in V1 (§5.1.9 rule 4).
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64), extra: 1 } } }), hash),
    /unsupported key "extra"/,
  );
});

test("SPEC-005 §5.1.9 rule 4: entry name must equal the portable-name component of its key", () => {
  const hash = VHASH(HEX_64);
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "acme/alpha": { name: "other-name", version_hash: VHASH(HEX_64) } } }), hash),
    /name must equal the portable-name component "alpha"/,
  );
  // Non-canonical skill keys (bare names, aliases) are rejected too.
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { alpha: { name: "alpha", version_hash: VHASH(HEX_64) } } }), hash),
    /canonical <namespace>\/<portable-name>/,
  );
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "a/b/c": { name: "b", version_hash: VHASH(HEX_64) } } }), hash),
    /canonical <namespace>\/<portable-name>/,
  );
  // Uppercase namespaces fail the frozen SPEC-001 namespace regex
  // (leading digits like "123/zed" are legal: [a-z0-9] start).
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "ACME/zed": { name: "zed", version_hash: VHASH(HEX_64) } } }), hash),
    /namespace component/,
  );
});

test("SPEC-005 §5.1.9 rule 4: version_hash must be a string matching sha256:<64 lowercase hex> (and so must config_hash)", () => {
  const hash = VHASH(HEX_64);
  for (const badHash of ["sha256:" + "AB".repeat(32), "sha256:" + "a".repeat(63), "md5:" + "a".repeat(64), "sha256:" + "A".repeat(64)]) {
    expectLockInvalid(
      () => validateLockfile(rawLock({ skills: { "acme/alpha": { name: "alpha", version_hash: badHash } } }), hash),
      /version_hash must be sha256:<64 lowercase hex>/,
    );
  }
  // Non-string version_hash is a shape error.
  for (const badHash of [42, null, {}, []]) {
    expectLockInvalid(
      () => validateLockfile(rawLock({ skills: { "acme/alpha": { name: "alpha", version_hash: badHash } } }), hash),
      /version_hash must be a string/,
    );
  }
  expectLockInvalid(
    () => validateLockfile(rawLock({ generatedFrom: { config_hash: "sha256:" + "f".repeat(63) } }), hash),
    /config_hash" must be sha256:<64 lowercase hex>/,
  );
});

test("SPEC-005 §5.1.9 rule 5: deterministic skill key ordering is enforced — unsorted keys are rejected", () => {
  const hash = VHASH(HEX_64);
  const unsorted = {
    "acme/zebra": { name: "zebra", version_hash: VHASH(HEX_64) },
    "acme/alpha": { name: "alpha", version_hash: VHASH(HEX_64_B) },
  };
  expectLockInvalid(() => validateLockfile(rawLock({ skills: unsorted }), hash), /keys must be sorted ascending/);
  // The same two skills in sorted order validate fine.
  const lock = validateLockfile(rawLock({ skills: TWO_SKILLS }), hash);
  assert.deepEqual(Object.keys(lock.skills), ["acme/alpha", "acme/beta"]);
});

test("SPEC-005 §5.1.14 rule 1: NUL bytes and non-text markers in lock strings are rejected", () => {
  const hash = VHASH(HEX_64);
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "acme/alpha": { name: "al\u0000pha", version_hash: VHASH(HEX_64) } } }), hash),
    /NUL byte/,
  );
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "acme/alpha": { name: "al\uFFFDFpha", version_hash: VHASH(HEX_64) } } }), hash),
    /non-text content/,
  );
  // A NUL in the config_hash is rejected before any comparison.
  expectLockInvalid(
    () => validateLockfile(rawLock({ generatedFrom: { config_hash: "sha256:" + "a".repeat(63) + "\u0000" } }), hash),
    /NUL byte/,
  );
  // A NUL inside a skill key itself is rejected with the plain-text guard.
  expectLockInvalid(
    () => validateLockfile(rawLock({ skills: { "acme/al\u0000pha": { name: "alpha", version_hash: VHASH(HEX_64) } } }), hash),
    /NUL byte/,
  );
});

// ---------------------------------------------------------------------------
// E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.9 rule 2: token_estimator must be ega-o200k-v1 (estimator gate)", () => {
  const hash = VHASH(HEX_64);
  for (const estimator of ["cl100k_base", "o200k-base", "EGA-O200K-V1", ""]) {
    assert.throws(
      () => validateLockfile(rawLock({ estimator }), hash),
      (err) => {
        assert.ok(err instanceof ProjectLockError, `expected ProjectLockError, got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.code, E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED);
        assert.match(err.message, /ega-o200k-v1/);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// E_LOCK_CONFIG_MISMATCH
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.9 rule 3: generated_from.config_hash must equal the expected hash parameter", () => {
  const configHash = hashNormalizedConfig(parseProjectConfig("{}"));
  // A well-formed lock generated from a different config → E_LOCK_CONFIG_MISMATCH.
  assert.throws(
    () => validateLockfile(rawLock({ configHash: VHASH(HEX_64_B) }), configHash),
    (err) => {
      assert.ok(err instanceof ProjectLockError);
      assert.equal(err.code, E_LOCK_CONFIG_MISMATCH);
      assert.match(err.message, /different config/);
      assert.ok(err.message.includes(VHASH(HEX_64_B)));
      assert.ok(err.message.includes(configHash));
      return true;
    },
  );
  // The exact expected hash as parameter passes.
  const lock = validateLockfile(rawLock({ configHash }), configHash);
  assert.equal(lock.generated_from.config_hash, configHash);
});

// ---------------------------------------------------------------------------
// E_LOCKED_VERSION_MISSING
// ---------------------------------------------------------------------------

test("SPEC-005 §5.1.11: lockedVersionFor returns the locked hash and throws E_LOCKED_VERSION_MISSING when absent", () => {
  const configHash = hashNormalizedConfig(parseProjectConfig("{}"));
  const lock = validateLockfile(rawLock({ configHash, skills: TWO_SKILLS }), configHash);

  assert.equal(lockedVersionFor(lock, "acme/alpha"), VHASH(HEX_64));
  assert.equal(lockedVersionFor(lock, "acme/beta"), VHASH(HEX_64_B));

  assert.throws(
    () => lockedVersionFor(lock, "acme/gamma"),
    (err) => {
      assert.ok(err instanceof ProjectLockError);
      assert.equal(err.code, E_LOCKED_VERSION_MISSING);
      assert.match(err.message, /not locked/);
      return true;
    },
  );
  // Empty lock: every skill is missing.
  const empty = validateLockfile(rawLock({ configHash, skills: {} }), configHash);
  assert.throws(() => lockedVersionFor(empty, "acme/alpha"), (err) => err.code === E_LOCKED_VERSION_MISSING);
});

// ---------------------------------------------------------------------------
// §5.1.14 readConfigAndLock control-file guards
// ---------------------------------------------------------------------------

const LOCK_YAML_BASE = (configHash) =>
  `lockfile_version: 1\n` +
  `token_estimator: ega-o200k-v1\n` +
  `generated_from:\n` +
  `  config_hash: ${configHash}\n` +
  `skills: {}\n`;

function tempProject(files) {
  const dir = mkdtempSync(join(tmpdir(), "ega-lock-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("SPEC-005 §5.1.12/§5.1.14: no config means no lock; config without adjacent lock returns lock:null", () => {
  const bare = tempProject({});
  const emptyDiscovery = discoverConfig(bare);
  assert.equal(emptyDiscovery.configPath, null);
  assert.deepEqual(readConfigAndLock(emptyDiscovery), { config: null, lock: null });

  const configOnly = tempProject({ ".egaskills.yaml": "routing:\n  max_skills: 2\n" });
  const discovery = discoverConfig(configOnly);
  assert.equal(discovery.lockPath, null);
  const result = readConfigAndLock(discovery);
  assert.equal(result.config.routing.max_skills, 2);
  assert.equal(result.lock, null);
});

test("SPEC-005 §5.1.14 rule 4: symlinked config and symlinked lock are rejected, never followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ega-lock-"));
  const targetDir = mkdtempSync(join(tmpdir(), "ega-lock-target-"));
  writeFileSync(join(targetDir, "real.yaml"), "routing:\n  max_skills: 2\n");
  writeFileSync(join(targetDir, "real.lock"), "lockfile_version: 1\n");
  symlinkSync(join(targetDir, "real.yaml"), join(dir, ".egaskills.yaml"));
  symlinkSync(join(targetDir, "real.lock"), join(dir, ".egaskills.lock"));

  const discovery = discoverConfig(dir);
  assert.notEqual(discovery.configPath, null);
  assert.notEqual(discovery.lockPath, null);
  // The config symlink is rejected first — config → E_PROJECT_CONFIG_INVALID.
  expectConfigInvalid(() => readConfigAndLock(discovery), /symlink\/junction/);

  // Real config + symlinked lock → lock → E_PROJECT_LOCK_INVALID.
  const dir2 = tempProject({ ".egaskills.yaml": "routing:\n  max_skills: 2\n" });
  symlinkSync(join(targetDir, "real.lock"), join(dir2, ".egaskills.lock"));
  expectLockInvalid(() => readConfigAndLock(discoverConfig(dir2)), /symlink\/junction/);
});

test("SPEC-005 §5.1.14 rule 1: NUL bytes and invalid UTF-8 in control-file text are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "ega-lock-"));
  const configText = "routing:\n  max_skills: 2\n";
  writeFileSync(join(dir, ".egaskills.yaml"), configText);
  const configHash = hashNormalizedConfig(parseProjectConfig(configText));

  // Valid lock first (round-trip through discovery + gate).
  writeFileSync(
    join(dir, ".egaskills.lock"),
    LOCK_YAML_BASE(configHash).replace(
      "skills: {}",
      "skills:\n" +
        `  acme/alpha:\n    name: alpha\n    version_hash: ${VHASH(HEX_64)}\n` +
        `  acme/beta:\n    name: beta\n    version_hash: ${VHASH(HEX_64_B)}\n`,
    ),
  );
  const ok = readConfigAndLock(discoverConfig(dir));
  assert.equal(ok.config.routing.max_skills, 2);
  assert.equal(ok.lock.skills["acme/alpha"].version_hash, VHASH(HEX_64));

  // NUL byte in lock text → E_PROJECT_LOCK_INVALID.
  writeFileSync(join(dir, ".egaskills.lock"), LOCK_YAML_BASE(configHash) + "\u0000");
  expectLockInvalid(() => readConfigAndLock(discoverConfig(dir)), /NUL byte/);

  // Invalid UTF-8 bytes → E_PROJECT_LOCK_INVALID (rejected, never repaired).
  writeFileSync(join(dir, ".egaskills.lock"), Buffer.from([0xff, 0xfe, 0x40, 0x40]));
  expectLockInvalid(() => readConfigAndLock(discoverConfig(dir)), /not valid UTF-8/);

  // NUL byte in config text → E_PROJECT_CONFIG_INVALID.
  writeFileSync(join(dir, ".egaskills.yaml"), "routing:\u0000\n  max_skills: 2\n");
  writeFileSync(join(dir, ".egaskills.lock"), LOCK_YAML_BASE(configHash));
  expectConfigInvalid(() => readConfigAndLock(discoverConfig(dir)), /NUL byte/);
});

test("SPEC-005 §5.1.14: a lock reported by discovery but missing at read time fails closed (TOCTOU)", () => {
  const dir = tempProject({
    ".egaskills.yaml": "routing:\n  max_skills: 2\n",
    ".egaskills.lock": "lockfile_version: 1\n",
  });
  const discovery = discoverConfig(dir);
  assert.notEqual(discovery.lockPath, null);
  // Vanished between discovery and read: never silently treated as absent.
  rmSync(discovery.lockPath);
  expectLockInvalid(() => readConfigAndLock(discovery), /missing at read time/);
});

test("SPEC-005 §5.1.12 rule 1: stale lock (hash mismatch) fails through readConfigAndLock even with locking.required=false", () => {
  const dir = tempProject({ ".egaskills.yaml": "locking:\n  required: false\n" });
  // Lock generated from a DIFFERENT config → E_LOCK_CONFIG_MISMATCH.
  writeFileSync(join(dir, ".egaskills.lock"), LOCK_YAML_BASE(VHASH(HEX_64)));
  assert.throws(
    () => readConfigAndLock(discoverConfig(dir)),
    (err) => err instanceof ProjectLockError && err.code === E_LOCK_CONFIG_MISMATCH,
  );
});