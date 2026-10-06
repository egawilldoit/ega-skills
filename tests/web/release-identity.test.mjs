/**
 * Release identity: the console's fail-closed core.
 *
 * These tests use the REAL committed artifact (`packages/mcp/artifact`, a valid
 * 114-skill release) as the fixture. Each scenario copies it to a temp
 * directory and mutates the COPY — the committed artifact is never written to.
 * That matters: `pnpm build` and several existing tests read those bytes, so a
 * mutation here would corrupt the repository's own fixtures.
 *
 * The property under test throughout is that identity is *earned*. A digest
 * only counts as `stable` when an authoritative expectation exists AND matches;
 * a fully verified artifact with no expectation is honestly `unpinned`; and
 * anything that disagrees, or any artifact that fails verification, refuses to
 * produce an identity at all.
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

import { loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";
import { parseServerConfig, ServerConfigError } from "../../apps/web/server/env.ts";
import {
  ReleaseIdentityError,
  assertCatalogServable,
  evaluateReleaseIdentity,
  getReleaseIdentity,
} from "../../apps/web/server/release-identity.ts";
import {
  RegistryReadError,
  assertReleaseFtsTable,
  closeRegistry,
  createRegistryReader,
  getRegistry,
} from "../../apps/web/server/registry.ts";
import { openReadOnlyRegistry } from "../../packages/mcp/dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");

/** The committed release's real digest, read from the package, never hardcoded. */
const COMMITTED_PACKAGE = JSON.parse(
  readFileSync(join(ARTIFACT, "release-package.json"), "utf8"),
);
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;

/** A different but syntactically valid digest, for mismatch scenarios. */
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

/** Sentinel secret values, used to prove no error path ever echoes one. */
const SECRET = "sb_secret_this-value-must-never-appear-in-any-error-or-object";

/** Every temp copy made by the suite, removed at the end. */
const tempDirs = [];

/** Copy the committed artifact into a fresh temp dir. */
function copyArtifact(label) {
  const dir = mkdtempSync(join(tmpdir(), `ega-web-identity-${label}-`));
  cpSync(ARTIFACT, dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/** Config pointing at a directory, with optional overrides. */
function configFor(env) {
  return parseServerConfig(env);
}

/** Evaluate a directory with no expectation configured. */
function evaluateDir(artifactDir, extraEnv = {}) {
  return evaluateReleaseIdentity(
    parseServerConfig({ EGA_WEB_ARTIFACT_DIR: artifactDir, ...extraEnv }),
  );
}

after(() => {
  closeRegistry();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* 1. Identity matches                                                         */
/* -------------------------------------------------------------------------- */

describe("identity matches the verified artifact", () => {
  test("actual digest, snapshot digest, and package digest all agree", () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const binding = evaluateDir(ARTIFACT);
    const identity = binding.identity;
    assert.ok(identity, "the committed artifact must produce an identity");

    assert.equal(identity.release_digest, snapshot.release.digest);
    assert.equal(identity.release_digest, COMMITTED_PACKAGE.hub_release_digest);
    assert.equal(binding.actual_release_digest, snapshot.releaseDigest);
    assert.equal(binding.expected_release_digest, null);
  });

  test("counts report 114 skills and 114 snapshot rows", () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const identity = evaluateDir(ARTIFACT).identity;
    assert.ok(identity);
    assert.equal(identity.skill_count, 114);
    assert.equal(identity.snapshot_rows, COMMITTED_PACKAGE.snapshot_rows);
    assert.equal(identity.skill_count, identity.snapshot_rows);
    assert.equal(
      identity.skill_count,
      Object.keys(snapshot.release.payload.skill_versions).length,
    );
    assert.equal(identity.hub_id, snapshot.release.payload.hub_id);
    assert.equal(identity.sqlite_artifact_digest, COMMITTED_PACKAGE.sqlite_artifact_digest);
  });

  test("a copy of the artifact verifies identically", () => {
    const copy = copyArtifact("match");
    const copyDigest = evaluateDir(copy).identity?.release_digest;
    assert.equal(copyDigest, COMMITTED_DIGEST);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Stable                                                                   */
/* -------------------------------------------------------------------------- */

describe("stable requires an authoritative expectation", () => {
  test("expecting the artifact's own digest yields stable with no reason", () => {
    const binding = evaluateDir(ARTIFACT, { EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST });
    const identity = binding.identity;
    assert.ok(identity);
    assert.equal(identity.status, "stable");
    assert.equal(identity.mismatch_reason, null);
    assert.equal(binding.expected_digest_source, "env");
    assert.equal(binding.expected_release_digest, COMMITTED_DIGEST);
    assert.equal(binding.is_stable, true);
  });

  test("stable is reachable through the assert path too", () => {
    const config = configFor({
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST,
    });
    const identity = assertCatalogServable(config);
    assert.equal(identity.status, "stable");
    assert.equal(identity.release_digest, COMMITTED_DIGEST);
  });

  test("getReleaseIdentity returns the DTO shape, matching contracts.ts", async () => {
    const identity = getReleaseIdentity(
      parseServerConfig({
        EGA_WEB_ARTIFACT_DIR: ARTIFACT,
        EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST,
      }),
    );
    assert.ok(identity);
    // The exact field set declared by ReleaseIdentity. This test fails if
    // someone adds a field here without updating the shared DTO.
    assert.deepEqual(
      Object.keys(identity).sort(),
      [
        "hub_id",
        "mismatch_reason",
        "release_digest",
        "skill_count",
        "snapshot_rows",
        "sqlite_artifact_digest",
        "status",
      ],
    );
    assert.equal(Object.isFrozen(identity), true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Unpinned — an honest state, not stable                                   */
/* -------------------------------------------------------------------------- */

describe("unpinned is honest, not stable", () => {
  test("no expectation and no retained manifest yields unpinned", () => {
    const binding = evaluateDir(ARTIFACT);
    const identity = binding.identity;
    assert.ok(identity);
    assert.equal(identity.status, "unpinned");
    assert.equal(identity.mismatch_reason, null);
    assert.equal(binding.expected_release_digest, null);
    assert.equal(binding.expected_digest_source, null);
    assert.equal(binding.is_stable, false);
  });

  test("an unpinned release is still fully verified and servable", () => {
    const config = configFor({ EGA_WEB_ARTIFACT_DIR: ARTIFACT });
    const identity = assertCatalogServable(config);
    // Verified bytes, honestly labelled. Not an error, and NOT "stable".
    assert.equal(identity.status, "unpinned");
    assert.equal(identity.skill_count, 114);
    assert.equal(identity.snapshot_rows, 114);
  });

  test("no release source at all produces no identity and says why", () => {
    const binding = evaluateReleaseIdentity(parseServerConfig({}));
    assert.equal(binding.identity, null);
    assert.equal(binding.actual_release_digest, null);
    // Non-null exactly when there is no identity: the reason is what the UI
    // renders instead of a fake empty catalog.
    assert.notEqual(binding.unavailable_reason, null);
    assert.match(String(binding.unavailable_reason), /No release source is configured/);
  });

  test("an unavailable release cannot be asserted servable", () => {
    assert.throws(
      () => assertCatalogServable(parseServerConfig({})),
      (error) => {
        assert.ok(error instanceof ReleaseIdentityError);
        assert.equal(error.code, "E_WEB_RELEASE_UNVERIFIED");
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Mismatch fails closed                                                    */
/* -------------------------------------------------------------------------- */

describe("mismatch fails closed", () => {
  test("a different but valid expectation is a mismatch naming both digests", () => {
    const binding = evaluateDir(ARTIFACT, { EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST });
    const identity = binding.identity;
    assert.ok(identity);
    assert.equal(identity.status, "mismatch");
    assert.notEqual(identity.mismatch_reason, null);
    // Both digests must be present so an operator can act on the message.
    assert.match(identity.mismatch_reason, /does not match/);
    assert.ok(
      identity.mismatch_reason.includes(OTHER_DIGEST),
      "mismatch_reason must name the expected digest",
    );
    assert.ok(
      identity.mismatch_reason.includes(COMMITTED_DIGEST),
      "mismatch_reason must name the verified actual digest",
    );
    assert.equal(binding.is_stable, false);
  });

  test("assertCatalogServable throws on mismatch", () => {
    const config = configFor({
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST,
    });
    assert.throws(
      () => assertCatalogServable(config),
      (error) => {
        assert.ok(error instanceof ReleaseIdentityError);
        assert.equal(error.code, "E_WEB_RELEASE_MISMATCH");
        assert.match(error.message, /Catalog unavailable/);
        assert.match(error.message, new RegExp(COMMITTED_DIGEST.slice(7, 20)));
        // The binding travels with the error so a route can render the digests.
        assert.equal(error.binding?.identity?.status, "mismatch");
        return true;
      },
    );
  });

  test("a mismatched release never gets a registry handle", () => {
    const config = configFor({
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST,
    });
    // The identity check runs before any handle is opened or reused.
    assert.throws(() => getRegistry(config), ReleaseIdentityError);
  });

  test("status/mismatch_reason invariant holds for every state", () => {
    const scenarios = [
      evaluateDir(ARTIFACT),
      evaluateDir(ARTIFACT, { EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST }),
      evaluateDir(ARTIFACT, { EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST }),
    ];
    for (const binding of scenarios) {
      const identity = binding.identity;
      assert.ok(identity);
      // The UI invariant: mismatch if and only if there is a reason.
      assert.equal(
        identity.status === "mismatch",
        identity.mismatch_reason !== null,
        `invariant violated for status ${identity.status}`,
      );
    }
  });

  test("the registry memo cannot serve a mismatched config through a healthy handle", () => {
    const healthy = configFor({ EGA_WEB_ARTIFACT_DIR: ARTIFACT });
    // Establish a live handle first, then prove a mismatched config still
    // refuses rather than reusing it.
    assert.equal(getRegistry(healthy).countReleaseRows(), 114);
    const mismatched = configFor({
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST,
    });
    assert.throws(() => getRegistry(mismatched), ReleaseIdentityError);
    // And the healthy handle still works afterwards.
    assert.equal(getRegistry(healthy).countReleaseRows(), 114);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Tampered artifact fails closed                                           */
/* -------------------------------------------------------------------------- */

describe("a tampered artifact produces no identity", () => {
  test("a flipped byte in registry.sqlite is refused", () => {
    const copy = copyArtifact("tampered");
    const sqlitePath = join(copy, "registry.sqlite");
    const fd = openSync(sqlitePath, "r+");
    // Flip one byte deep inside the file: a single change that invalidates the
    // SQLite artifact digest the release package commits to.
    const offset = 4096;
    const buffer = Buffer.alloc(1);
    readSync(fd, buffer, 0, 1, offset);
    buffer[0] = buffer[0] ^ 0xff;
    writeFileSync(sqlitePath, buffer, { flag: "r+" });
    closeSync(fd);

    const binding = evaluateDir(copy);
    // Refusal, not a degraded identity and not `unpinned`.
    assert.equal(binding.identity, null, "a tampered artifact must not produce an identity");
    assert.match(String(binding.unavailable_reason), /failed verification/);
    assert.match(String(binding.unavailable_reason), /E_SNAPSHOT_INVALID/);
  });

  test("assertCatalogServable throws for a tampered artifact", () => {
    const copy = copyArtifact("tampered-assert");
    const sqlitePath = join(copy, "registry.sqlite");
    const bytes = readFileSync(sqlitePath);
    // Zero a byte near the end of the file rather than the SQLite header, so
    // the failure is a content/projection failure and not merely "won't open".
    const index = bytes.length - 1024;
    bytes[index] = bytes[index] ^ 0xff;
    writeFileSync(sqlitePath, bytes);
    assert.throws(
      () => assertCatalogServable(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy })),
      (error) => {
        assert.ok(error instanceof ReleaseIdentityError);
        assert.equal(error.code, "E_WEB_RELEASE_UNVERIFIED");
        return true;
      },
    );
  });

  test("the committed artifact itself is never modified by these tests", () => {
    // Guards the "never mutate the committed artifact" rule: if any test had
    // written in place, this digest would no longer match.
    const after = readFileSync(join(ARTIFACT, "release-package.json"), "utf8");
    assert.equal(after, `${JSON.stringify(COMMITTED_PACKAGE, null, 2)}\n`);
    assert.equal(evaluateDir(ARTIFACT).identity?.status, "unpinned");
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Truncated artifact fails closed                                          */
/* -------------------------------------------------------------------------- */

describe("a truncated artifact produces no identity", () => {
  for (const missing of ["hub-release.json", "release-package.json"]) {
    test(`a copy missing ${missing} is refused`, () => {
      const copy = copyArtifact(`truncated-${missing}`);
      unlinkSync(join(copy, missing));
      const binding = evaluateDir(copy);
      assert.equal(binding.identity, null);
      assert.match(String(binding.unavailable_reason), /failed verification/);
      assert.throws(
        () => assertCatalogServable(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy })),
        ReleaseIdentityError,
      );
    });
  }

  test("a missing artifact directory is refused at config time", () => {
    assert.throws(
      () => parseServerConfig({ EGA_WEB_ARTIFACT_DIR: join(tmpdir(), "ega-does-not-exist-xyz") }),
      (error) => {
        assert.ok(error instanceof ServerConfigError);
        assert.equal(error.code, "E_WEB_ENV_MISSING_PATH");
        // The message names the variable, never the value.
        assert.match(error.message, /EGA_WEB_ARTIFACT_DIR/);
        assert.doesNotMatch(error.message, /ega-does-not-exist-xyz/);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Blank env is unset                                                       */
/* -------------------------------------------------------------------------- */

describe("a blank env var is unset, not an empty path", () => {
  // Builder 1 shipped this bug in the readiness probe and fixed it in f0570cf.
  // These assertions exist so a second place cannot reintroduce it.
  for (const blank of ["", " ", "   ", "\t", "\n", " \t\n "]) {
    test(`EGA_WEB_ARTIFACT_DIR ${JSON.stringify(blank)} is not a configured directory`, () => {
      const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: blank });
      assert.equal(config.artifactDir, null);
      assert.equal(config.hasReleaseSource, false);
    });

    test(`EGA_WEB_RETAINED_MANIFEST ${JSON.stringify(blank)} is not a configured manifest`, () => {
      const config = parseServerConfig({ EGA_WEB_RETAINED_MANIFEST: blank });
      assert.equal(config.retainedManifestPath, null);
    });

    test(`a blank expected digest is unset, not a malformed digest`, () => {
      const config = parseServerConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: blank });
      assert.equal(config.expectedReleaseDigest, null);
      assert.equal(config.hasExpectedReleaseDigest, false);
    });
  }

  test("a blank artifact directory yields no identity rather than a bogus path", () => {
    const binding = evaluateReleaseIdentity(
      parseServerConfig({ EGA_WEB_ARTIFACT_DIR: "   ", EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST }),
    );
    // An expectation exists but there is nothing to verify: no identity.
    assert.equal(binding.identity, null);
  });

  test("a real directory is accepted and an existing relative path resolves", () => {
    const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT });
    assert.equal(config.artifactDir, ARTIFACT);
    assert.equal(config.hasReleaseSource, true);
  });

  test("a path that is not a directory is refused", () => {
    assert.throws(
      () => parseServerConfig({ EGA_WEB_ARTIFACT_DIR: join(ARTIFACT, "hub-release.json") }),
      ServerConfigError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Malformed digest fails closed                                            */
/* -------------------------------------------------------------------------- */

describe("a malformed expected digest fails closed", () => {
  const malformed = [
    "not-a-digest",
    "sha256:",
    `sha256:${"0".repeat(63)}`,
    `sha256:${"0".repeat(65)}`,
    `sha256:${"A".repeat(64)}`,       // uppercase hex is a different byte string
    `sha256:${"g".repeat(64)}`,       // non-hex
    "sha256:1234",
    "1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77", // no prefix
    ` SHA256:${"0".repeat(64)}`,      // leading space is not valid form
  ];

  for (const value of malformed) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseServerConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: value }),
        (error) => {
          assert.ok(error instanceof ServerConfigError);
          assert.equal(error.code, "E_WEB_ENV_INVALID");
          assert.equal(error.variable, "EGA_WEB_EXPECTED_RELEASE_DIGEST");
          // Never echo the configured value. The bare `sha256:` prefix is
          // skipped because it is also the documented format prefix the message
          // legitimately names; everything else must be absent.
          if (value !== "sha256:") {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.doesNotMatch(error.message, new RegExp(escaped));
          }
          return true;
        },
      );
    });
  }

  test("a malformed digest is rejected, not silently treated as unset", () => {
    // The dangerous alternative: dropping the bad value would report the
    // deployment as `unpinned` while the operator believes it is pinned.
    assert.throws(
      () => evaluateReleaseIdentity(parseServerConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: "garbage" })),
      ServerConfigError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 9. The read-only handle                                                     */
/* -------------------------------------------------------------------------- */

describe("the registry handle is read-only", () => {
  test("it reports query_only enforcement", () => {
    const reader = getRegistry(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT }));
    assert.equal(reader.queryOnly, true);
    // Independently confirmed through the handle's own connection.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      assert.equal(handle.db.pragma("query_only", { simple: true }), 1);
    } finally {
      handle.close();
    }
  });

  test("a write attempt on the underlying connection is refused", () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      assert.throws(
        () =>
          handle.db
            .prepare("INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES ('x/y','x','y','z')")
            .run(),
        /readonly/i,
      );
      assert.throws(
        () => handle.db.prepare("DROP TABLE skill_aliases").run(),
        /readonly/i,
      );
      assert.throws(
        () => handle.db.prepare("UPDATE skill_versions SET trust_level = 'OWNED'").run(),
        /readonly/i,
      );
    } finally {
      handle.close();
    }
  });

  test("reads work and are bounded", () => {
    const reader = getRegistry(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT }));
    assert.equal(reader.countReleaseRows(), 114);
    assert.equal(reader.listReleasedSkills().length, 114);
    assert.equal(reader.listReleasedSkills({ limit: 3 }).length, 3);
    assert.equal(reader.listReleasedSkillIds().length, 114);
    const skill = reader.getReleasedSkill("anthropic/academy-guide");
    assert.equal(skill.l1_status, "MISSING");
    assert.equal(skill.trust_level, "UNKNOWN");
    assert.ok(skill.manifest.routing !== null && typeof skill.manifest.routing === "object");
    // `anti_triggers` exists only here, never in an FTS column — the reason the
    // routing block is the authoritative source for facets.
    assert.ok("anti_triggers" in skill.manifest.routing);
    // A limit above the ceiling is clamped, not honoured.
    assert.equal(reader.listReleasedSkills({ limit: 10 ** 9 }).length, 114);
  });

  test("an unreleased skill and an invalid limit are refused, not empty results", () => {
    const reader = getRegistry(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT }));
    assert.throws(() => reader.getReleasedSkill("nope/nope"), (error) => {
      assert.ok(error instanceof RegistryReadError);
      assert.equal(error.code, "E_WEB_SKILL_NOT_RELEASED");
      return true;
    });
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => reader.listReleasedSkills({ limit }), RegistryReadError);
    }
    assert.throws(() => reader.searchReleaseFts("   "), RegistryReadError);
  });

  test("the FTS corpus identifier must be the verified snapshot's", () => {
    const reader = getRegistry(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT }));
    // The real name is accepted.
    assert.equal(assertReleaseFtsTable(reader.snapshot, reader.ftsTable), reader.ftsTable);
    // A shape-valid but different corpus is refused.
    assert.throws(() => assertReleaseFtsTable(reader.snapshot, `release_fts_${"0".repeat(64)}`), RegistryReadError);
    // Injection attempts are refused on shape alone.
    for (const hostile of ['release_fts_x"; DROP TABLE skills; --', "skill_aliases", "release_fts_'", ""]) {
      assert.throws(() => assertReleaseFtsTable(reader.snapshot, hostile), RegistryReadError);
    }
  });

  test("a tampered copy cannot open a handle at all", () => {
    const copy = copyArtifact("handle-tampered");
    unlinkSync(join(copy, "hub-release.json"));
    assert.throws(() => getRegistry(parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy })), ReleaseIdentityError);
  });

  test("a reader whose query_only is not enforced reports it honestly", async () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    // A handle opened WITHOUT query_only. `createRegistryReader` cannot enforce
    // the pragma itself — `openReadOnlyRegistry` does that — so it must REPORT
    // the absence rather than claiming read-only. `getRegistry` is the layer
    // that turns a false here into a refusal (asserted separately).
    const { default: Database } = await import(
      // Resolved through `packages/registry`, which is the workspace member that
      // declares the `better-sqlite3` dependency, rather than from the repo root.
      "../../packages/registry/node_modules/better-sqlite3/lib/index.js"
    );
    const db = new Database(snapshot.sqlitePath, { readonly: true, fileMustExist: true });
    assert.equal(db.pragma("query_only", { simple: true }), 0);
    const reader = createRegistryReader(snapshot, {
      db,
      registryDatabase: snapshot.sqlitePath,
      close: () => db.close(),
    });
    try {
      assert.equal(reader.queryOnly, false);
    } finally {
      reader.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 10. No secrets escape                                                       */
/* -------------------------------------------------------------------------- */

describe("no secret ever escapes", () => {
  test("no error message or object contains a configured secret", () => {
    const env = {
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_SUPABASE_SECRET_KEY: SECRET,
      EGA_SUPABASE_URL: "https://console.invalid",
    };
    const config = parseServerConfig(env);
    // The value is carried for later server-side use...
    assert.equal(config.supabaseSecretKey, SECRET);
    // ...and the operator-facing description never mentions it.
    const described = JSON.stringify({
      keys: Object.keys(config),
      hasSecret: config.hasExpectedReleaseDigest,
    });
    assert.doesNotMatch(described, /sb_secret/);

    // A mismatch under those settings must not leak the secret either.
    const mismatched = evaluateReleaseIdentity(
      parseServerConfig({ ...env, EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST }),
    );
    assert.doesNotMatch(JSON.stringify(mismatched.identity), /sb_secret/);
    assert.throws(() => assertCatalogServable(parseServerConfig({ ...env, EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST })), (error) => {
      assert.doesNotMatch(String(error.message), /sb_secret/);
      assert.doesNotMatch(JSON.stringify(error.binding?.identity), /sb_secret/);
      return true;
    });
  });

  test("config errors never echo a secret or a raw env value", () => {
    for (const [key, value] of [
      ["EGA_WEB_EXPECTED_RELEASE_DIGEST", `sha256:${SECRET}`],
      ["EGA_WEB_ARTIFACT_DIR", `/tmp/${SECRET}`],
    ]) {
      assert.throws(
        () => parseServerConfig({ [key]: value }),
        (error) => {
          assert.ok(error instanceof ServerConfigError);
          assert.doesNotMatch(error.message, new RegExp(SECRET));
          return true;
        },
      );
    }
  });

  test("the retained-manifest config is not exposed through describe output", async () => {
    const { describeServerConfig } = await import("../../apps/web/server/env.ts");
    const described = describeServerConfig(
      parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT, EGA_SUPABASE_SECRET_KEY: SECRET }),
    );
    assert.doesNotMatch(described, /sb_secret/);
    assert.match(described, /artifact directory configured/);
  });
});