/**
 * Release history, release detail, and release comparison.
 *
 * ## The fixture is the real release
 *
 * These tests read the REAL committed artifact (`packages/mcp/artifact`, a
 * verified 114-skill release, digest `sha256:1efdbc3d…31b77`). Nothing about the
 * release is mocked: `loadHostedReleaseSnapshot` runs its full verification, the
 * SQLite file is opened read-only with `query_only` enforced, and every row is
 * read through Builder 2a's reader. A module-level digest of every committed file
 * is taken before the first test and re-checked in `after`, so "never mutate the
 * committed artifact" is asserted rather than assumed.
 *
 * Two scenarios need a *retained manifest*, which the repository does not
 * commit. Those build genuine artifacts with `buildHubRelease` +
 * `writeArtifactCandidate` and a genuine `createRetainedManifest`, exactly as
 * `tests/mcp/retained-serving.test.mjs` does, so the retained path is exercised
 * against artifacts that really verify rather than against a hand-written
 * fixture that merely looks like one.
 *
 * ## What these tests insist on
 *
 * 1. With no retained manifest there is exactly ONE verifiable release, and the
 *    response says in words that no retained history exists. No invented
 *    `publication_revision`, no invented `published_at`, no invented `deployment_id`.
 * 2. A self-comparison is `UNCHANGED` with a correct unchanged count.
 * 3. An unknown digest is a deterministic refusal that never substitutes the
 *    default release.
 * 4. A side that cannot be read yields the explicit unavailable state, not a
 *    partial diff and not "no changes".
 * 5. A cross-Hub comparison is refused by the Contract R1 implementation.
 * 6. Reported artifact identities match `release-package.json` and the real bytes.
 *
 * ## Facts verified before writing these assertions
 *
 * The artifact carries **no publication timestamp of any kind**, so
 * `published_at` is `null` with a reason rather than a plausible string. Proof:
 * `grep -ohE '"[a-z_]*(at|time|date|published|created|updated)[a-z_]*"\s*:'
 * packages/mcp/artifact/*.json` returns only `publication`,
 * `publication_policy_revision`, `status`, `platforms`, `token_estimator`,
 * `update_contract`, `expected_catalog_match` and the two `*_release_digest`
 * fields. `publication-preflight.json`'s `blockers` and `reviews` live under
 * `payload`, not at the top level.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";

import { sha256Hex } from "../../packages/hashing/dist/index.js";
import {
  createRetainedManifest,
  loadHostedReleaseSnapshot,
  resolveRetainedRelease,
} from "../../packages/mcp/dist/index.js";
import {
  buildHubRelease,
  createArtifactCandidate,
  writeArtifactCandidate,
} from "../../packages/project/dist/index.js";

import { parseServerConfig } from "../../apps/web/server/env.ts";
import { closeRegistry } from "../../apps/web/server/registry.ts";
import {
  RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE,
  RELEASES_NO_PUBLICATION_TIMESTAMP_REASON,
  RELEASES_NO_RETAINED_HISTORY_REASON,
  RELEASES_NO_STABLE_POINTER_REASON,
  RELEASE_DIGEST_MAX_LENGTH,
  ReleaseReadError,
  getReleaseComparison,
  getReleaseDetail,
  getReleases,
  validateReleaseDigest,
} from "../../apps/web/server/releases.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");

const COMMITTED_PACKAGE = JSON.parse(readFileSync(join(ARTIFACT, "release-package.json"), "utf8"));
const COMMITTED_RELEASE = JSON.parse(readFileSync(join(ARTIFACT, "hub-release.json"), "utf8"));
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;
const COMMITTED_SKILL_COUNT = Object.keys(COMMITTED_RELEASE.payload.skill_versions).length;
const COMMITTED_SKILL_IDS = Object.keys(COMMITTED_RELEASE.payload.skill_versions).sort();

/** A different but syntactically valid digest, for the "not held here" cases. */
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

/** Config for the committed artifact, read-only. */
function committedConfig(extraEnv = {}) {
  return parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT, ...extraEnv });
}

/* -------------------------------------------------------------------------- */
/* Committed-artifact integrity, checked before and after the run              */
/* -------------------------------------------------------------------------- */

function digestEveryFile(dir) {
  const digests = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        digests.set(path.slice(ARTIFACT.length), createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  walk(dir);
  return digests;
}

const ARTIFACT_DIGESTS_BEFORE = digestEveryFile(ARTIFACT);

const tempDirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `ega-web-releases-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function copyArtifact(label) {
  const dir = tempDir(label);
  cpSync(ARTIFACT, dir, { recursive: true });
  return dir;
}

after(() => {
  closeRegistry();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  const afterDigests = digestEveryFile(ARTIFACT);
  assert.equal(afterDigests.size, ARTIFACT_DIGESTS_BEFORE.size, "the committed artifact gained or lost files");
  for (const [relative, digest] of ARTIFACT_DIGESTS_BEFORE) {
    assert.equal(afterDigests.get(relative), digest, `the committed artifact file ${relative} was modified`);
  }
});

/* -------------------------------------------------------------------------- */
/* Genuine second artifacts, for the retained-manifest scenarios               */
/* -------------------------------------------------------------------------- */

/**
 * Build a real, fully verifiable artifact from a one-skill hub source tree.
 *
 * `buildHubRelease` produces the semantic release, `createArtifactCandidate` +
 * `writeArtifactCandidate` write the candidate and the whole immutable package,
 * and `loadHostedReleaseSnapshot` verifies the result — so a manifest entry built
 * from these bytes is one `loadRetainedReleaseSet` will accept.
 */
async function buildFixtureArtifact(hubId, skillName, description) {
  const hubDir = tempDir(`hub-${hubId}-${skillName}`);
  const skillDir = join(hubDir, "owned", "fixture", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${description}\n`,
  );
  writeFileSync(
    join(skillDir, "ega.yaml"),
    `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${skillName}\n`,
  );
  writeFileSync(
    join(hubDir, "hub.yaml"),
    `schema_version: 1\nhub:\n  id: ${hubId}\nowned:\n  - path: owned/fixture\n    namespace: fixture\nexternal: []\n`,
  );
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const build = await buildHubRelease(hubDir);
  const artifactDir = join(hubDir, "artifact");
  writeArtifactCandidate(build, artifactDir, createArtifactCandidate(build));
  return artifactDir;
}

function packageDigestOf(artifactDir) {
  return `sha256:${sha256Hex(readFileSync(join(artifactDir, "release-package.json")))}`;
}

function retainedEntry(root, artifactPath, releaseDigest) {
  const dir = join(root, artifactPath);
  return {
    artifact_path: artifactPath,
    candidate_digest: JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8")).digest,
    release_digest: releaseDigest,
    release_package_digest: packageDigestOf(dir),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. No retained manifest: exactly one verifiable release                     */
/* -------------------------------------------------------------------------- */

describe("with no retained manifest, exactly one release is verifiable", () => {
  test("the history has one row and says why it has only one", () => {
    const list = getReleases(committedConfig());
    assert.equal(list.history_state, "single-verified-release");
    assert.equal(list.release_total, 1);
    assert.equal(list.releases.length, 1);
    assert.equal(list.history_unavailable_reason, RELEASES_NO_RETAINED_HISTORY_REASON);
    assert.match(list.history_unavailable_reason, /no retained release manifest/i);
  });

  test("nothing about the history is invented", () => {
    const list = getReleases(committedConfig());
    // A publication revision exists only in a retained manifest. There is none,
    // so the value is null rather than zero, one, or a made-up string.
    assert.equal(list.publication_revision, null);
    assert.equal(list.deployment_id, null);
    // The release identity itself must not gain one either: the DTO field is
    // optional, and with no retained manifest it is absent.
    assert.equal(Object.hasOwn(list.releases[0].release, "publication_revision"), false);
  });

  test("published_at is null with a reason, because the artifact records no timestamp", () => {
    const summary = getReleases(committedConfig()).releases[0];
    assert.equal(summary.published_at, null);
    assert.equal(summary.published_at_unavailable_reason, RELEASES_NO_PUBLICATION_TIMESTAMP_REASON);
  });

  test("the single row is the verified artifact, not a stand-in", () => {
    const row = getReleases(committedConfig()).releases[0];
    assert.equal(row.release.release_digest, COMMITTED_DIGEST);
    assert.equal(row.release.hub_id, COMMITTED_RELEASE.payload.hub_id);
    assert.equal(row.release.skill_count, COMMITTED_SKILL_COUNT);
    assert.equal(row.release.snapshot_rows, COMMITTED_PACKAGE.snapshot_rows);
    assert.equal(row.is_stable, true);
    assert.ok(row.is_stable_basis.length > 0);
  });

  test("the identity status is the binding's, never promoted to stable", () => {
    // No expected digest is configured, so nothing authoritative vouches for
    // these bytes. `assertCatalogServable` serves `unpinned` deliberately; the
    // release views must not round it up to `stable`.
    const row = getReleases(committedConfig()).releases[0];
    assert.equal(row.release.status, "unpinned");
    assert.equal(row.release.mismatch_reason, null);
  });

  test("with an expected digest that matches, the same release reads stable", () => {
    const row = getReleases(committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST })).releases[0];
    assert.equal(row.release.status, "stable");
    assert.equal(row.release.mismatch_reason, null);
    assert.equal(row.is_stable, true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Self-comparison                                                          */
/* -------------------------------------------------------------------------- */

describe("a self-comparison reports no differences and a correct unchanged count", () => {
  const digest = COMMITTED_DIGEST;
  const view = getReleaseComparison(committedConfig(), { base: digest, candidate: digest });

  test("status is UNCHANGED with an empty difference set", () => {
    assert.equal(view.status, "UNCHANGED");
    assert.equal(view.status_reason, null);
    assert.deepEqual(view.added_skill_ids, []);
    assert.deepEqual(view.removed_skill_ids, []);
    assert.deepEqual(view.changed_skill_ids, []);
    assert.deepEqual(view.updated_skills, []);
  });

  test("the unchanged count is 114 and is exactly the release's own skill set", () => {
    assert.equal(view.unchanged_count, COMMITTED_SKILL_COUNT);
    assert.equal(view.unchanged_count, 114);
    assert.equal(view.base_skill_count, 114);
    assert.equal(view.head_skill_count, 114);
    assert.deepEqual([...view.unchanged_skill_ids].sort(), COMMITTED_SKILL_IDS);
  });

  test("every artifact_changes boolean is false", () => {
    assert.deepEqual(view.artifact_changes, {
      adopted_sources: false,
      alias_map: false,
      search_index_input: false,
      token_artifact: false,
    });
  });

  test("both sides are the deployment release and are not marked unavailable", () => {
    assert.equal(view.base_unavailable_reason, null);
    assert.equal(view.head_unavailable_reason, null);
    assert.equal(view.base.release_digest, digest);
    assert.equal(view.head.release_digest, digest);
    assert.equal(view.hub_id, COMMITTED_RELEASE.payload.hub_id);
    assert.equal(view.base_release_digest, digest);
    assert.equal(view.head_release_digest, digest);
  });

  test("how the unchanged set was computed is stated in the notes", () => {
    const note = view.notes.find((line) => /Unchanged is computed/.test(line));
    assert.ok(note, "the comparison must explain its unchanged arithmetic");
    assert.match(note, /114 of 114/);
  });

  test("a self-comparison against a copied, byte-identical artifact is also UNCHANGED", () => {
    // Same release digest from a different directory: identity is semantic, so a
    // relocated copy is the same release and must not read as a change.
    const copied = copyArtifact("self-copy");
    const copiedConfig = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copied });
    const copiedView = getReleaseComparison(copiedConfig, {
      base: COMMITTED_DIGEST,
      candidate: COMMITTED_DIGEST,
    });
    assert.equal(copiedView.status, "UNCHANGED");
    assert.equal(copiedView.unchanged_count, 114);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. An unknown digest never falls back to the default release                */
/* -------------------------------------------------------------------------- */

describe("an unknown release digest is refused, never substituted", () => {
  test("release detail refuses an unknown digest with a deterministic code and status", () => {
    assert.throws(
      () => getReleaseDetail(committedConfig(), OTHER_DIGEST),
      (error) => {
        assert.ok(error instanceof ReleaseReadError);
        assert.equal(error.code, "E_WEB_RELEASE_UNAVAILABLE");
        assert.equal(error.status, 404);
        // The message must say what is missing without echoing anything else.
        assert.match(error.message, /not held by this deployment/);
        return true;
      },
    );
  });

  test("the refusal is identical for a digest nobody has ever seen and one that is merely wrong", () => {
    const first = (() => {
      try {
        getReleaseDetail(committedConfig(), OTHER_DIGEST);
        return null;
      } catch (error) {
        return { code: error.code, status: error.status };
      }
    })();
    const second = (() => {
      try {
        getReleaseDetail(committedConfig(), `sha256:${"a".repeat(64)}`);
        return null;
      } catch (error) {
        return { code: error.code, status: error.status };
      }
    })();
    assert.deepEqual(first, second, "two unknown digests must be indistinguishable");
  });

  test("the refused detail carries no default release contents", () => {
    let captured = null;
    try {
      getReleaseDetail(committedConfig(), OTHER_DIGEST);
    } catch (error) {
      captured = error;
    }
    assert.ok(captured !== null);
    // A fallback would show up as the default release's skill count or digests.
    const serialised = JSON.stringify({ ...captured, message: captured.message });
    assert.doesNotMatch(serialised, new RegExp(COMMITTED_PACKAGE.sqlite_artifact_digest));
    assert.doesNotMatch(serialised, /skill_count/);
    assert.doesNotMatch(serialised, /snapshot_rows/);
  });

  test("a comparison against an unknown digest yields the explicit unavailable state, not a diff", () => {
    const view = getReleaseComparison(committedConfig(), {
      base: COMMITTED_DIGEST,
      candidate: OTHER_DIGEST,
    });
    assert.equal(view.status, "UNAVAILABLE");
    assert.equal(view.head_unavailable_reason, RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE);
    assert.equal(view.base_unavailable_reason, null);
    // The readable side is still identified; only the missing side is null.
    assert.equal(view.head, null);
    assert.equal(view.base.release_digest, COMMITTED_DIGEST);
    // No list is populated: an empty list here means unavailable, not unchanged.
    assert.deepEqual(view.added_skill_ids, []);
    assert.deepEqual(view.removed_skill_ids, []);
    assert.deepEqual(view.changed_skill_ids, []);
    assert.deepEqual(view.unchanged_skill_ids, []);
    assert.equal(view.unchanged_count, 0);
    assert.equal(view.artifact_changes, null);
    assert.match(view.status_reason, /could not be resolved/);
  });

  test("the unavailable state is not UNCHANGED, however it is read", () => {
    const view = getReleaseComparison(committedConfig(), { base: OTHER_DIGEST, candidate: OTHER_DIGEST });
    assert.equal(view.status, "UNAVAILABLE");
    assert.equal(view.base_unavailable_reason, RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE);
    assert.equal(view.head_unavailable_reason, RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE);
    assert.equal(view.base, null);
    assert.equal(view.head, null);
  });

  test("a malformed digest is a 400, distinct from a well-formed digest that is not held", () => {
    for (const bad of ["not-a-digest", "sha256:short", `sha256:${"A".repeat(64)}`, "sha256:" + "0".repeat(63)]) {
      assert.throws(
        () => getReleaseDetail(committedConfig(), bad),
        (error) => {
          assert.equal(error.code, "E_WEB_RELEASE_DIGEST_INVALID");
          assert.equal(error.status, 400);
          return true;
        },
        `${bad} must be refused as malformed input`,
      );
    }
    // An over-long digest is refused on length, before the pattern test, and the
    // message never echoes the value.
    assert.throws(
      () => validateReleaseDigest(`sha256:${"0".repeat(RELEASE_DIGEST_MAX_LENGTH)}`, "base"),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_DIGEST_INVALID");
        assert.equal(error.status, 400);
        assert.doesNotMatch(error.message, /0{64}/);
        return true;
      },
    );
  });

  test("a comparison validates both digests before resolving either", () => {
    assert.throws(
      () => getReleaseComparison(committedConfig(), { base: "nope", candidate: COMMITTED_DIGEST }),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_DIGEST_INVALID");
        assert.match(error.message, /^base must/);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Missing historical artifact                                              */
/* -------------------------------------------------------------------------- */

describe("a missing historical artifact is stated explicitly", () => {
  test("the exact sentence is the module constant the UI quotes", () => {
    assert.equal(RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE, "Historical artifact unavailable for full comparison.");
  });

  test("the reason is present on the missing side and absent on the readable side", () => {
    const view = getReleaseComparison(committedConfig(), {
      base: OTHER_DIGEST,
      candidate: COMMITTED_DIGEST,
    });
    assert.equal(view.base_unavailable_reason, "Historical artifact unavailable for full comparison.");
    assert.equal(view.head_unavailable_reason, null);
    assert.equal(view.base, null);
    assert.ok(view.head !== null);
    assert.match(view.status_reason, /Historical artifact unavailable for full comparison\./);
    assert.match(view.notes.join(" "), /means unavailable, not unchanged/);
  });

  test("the refusal is never dressed up as a one-sided diff", () => {
    const view = getReleaseComparison(committedConfig(), {
      base: OTHER_DIGEST,
      candidate: COMMITTED_DIGEST,
    });
    // A one-sided diff would report all 114 skills as added or removed.
    const reported = view.added_skill_ids.length + view.removed_skill_ids.length + view.changed_skill_ids.length;
    assert.equal(reported, 0);
    assert.equal(view.unchanged_count, 0);
    assert.equal(view.base_skill_count, 0);
    assert.equal(view.head_skill_count, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Cross-Hub comparison is refused                                         */
/* -------------------------------------------------------------------------- */

describe("a cross-Hub comparison is refused", () => {
  test("createReleaseDiff throws, so the console surfaces a refusal and no diff", async () => {
    const sameHub = await buildFixtureArtifact("personal", "alpha", "A fixture skill for the same hub.");
    const otherHub = await buildFixtureArtifact("other-hub", "beta", "A fixture skill for a different hub.");
    const committedSnapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const otherSnapshot = loadHostedReleaseSnapshot(otherHub);
    assert.equal(committedSnapshot.release.payload.hub_id, "personal");
    assert.equal(otherSnapshot.release.payload.hub_id, "other-hub");

    // `loadRetainedReleaseSet` refuses a mixed-hub manifest before any diff is
    // attempted (`retained artifact belongs to a different Hub`), so a genuine
    // cross-Hub comparison is unreachable through the retained path. The
    // existing `loadRetained` dependency seam is the only way to present two
    // verified releases that really do belong to different hubs.
    const injected = {
      manifestPath: "/injected/retained-manifest.json",
      manifest: {
        object_type: "ega.retained-release-manifest",
        schema_version: 1,
        digest: `sha256:${"0".repeat(64)}`,
        payload: {
          hub_id: "personal",
          publication_revision: 1,
          deployment_id: "injected",
          default_release_digest: committedSnapshot.releaseDigest,
          releases: [
            {
              artifact_path: "committed",
              candidate_digest: `sha256:${"0".repeat(64)}`,
              release_digest: committedSnapshot.releaseDigest,
              release_package_digest: packageDigestOf(ARTIFACT),
            },
            {
              artifact_path: "other",
              candidate_digest: `sha256:${"0".repeat(64)}`,
              release_digest: otherSnapshot.releaseDigest,
              release_package_digest: packageDigestOf(otherHub),
            },
          ],
        },
      },
      defaultSnapshot: committedSnapshot,
      snapshots: new Map([
        [committedSnapshot.releaseDigest, committedSnapshot],
        [otherSnapshot.releaseDigest, otherSnapshot],
      ]),
    };

    // Prove the upstream primitive really resolves both digests, so the refusal
    // below comes from the diff and not from a lookup that missed.
    assert.equal(
      resolveRetainedRelease(injected, otherSnapshot.releaseDigest).releaseDigest,
      otherSnapshot.releaseDigest,
    );

    // `evaluateReleaseIdentity` only consults `loadRetained` when a retained
    // manifest path is configured, so the config must name one. Its *contents*
    // are irrelevant because the loader is injected; the path only has to resolve,
    // which is what `parseServerConfig` checks.
    const manifestStub = join(tempDir("manifest-stub"), "retained-manifest.json");
    writeFileSync(manifestStub, "{}\n");
    const config = parseServerConfig({
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_WEB_RETAINED_MANIFEST: manifestStub,
    });
    assert.throws(
      () =>
        getReleaseComparison(config, {
          base: committedSnapshot.releaseDigest,
          candidate: otherSnapshot.releaseDigest,
        }, { loadRetained: () => injected }),
      (error) => {
        assert.ok(error instanceof ReleaseReadError);
        assert.equal(error.code, "E_WEB_RELEASE_HUB_MISMATCH");
        assert.equal(error.status, 409);
        assert.match(error.message, /different Hubs/);
        // No SQL, no absolute path, no stack trace in a refusal.
        assert.doesNotMatch(error.message, /SELECT |INSERT |\/tmp\/|\/home\//);
        return true;
      },
    );
  });

  test("a mixed-hub retained manifest is refused by the loader before any diff", async () => {
    // The other reason a cross-Hub comparison is unreachable in production:
    // `loadRetainedReleaseSet` verifies every retained snapshot's hub_id against
    // the manifest's and fails the whole load. So a deployment can never present
    // two hubs to the compare route through a real manifest.
    const sameHub = await buildFixtureArtifact("personal", "epsilon", "Same hub as the committed release.");
    const otherHub = await buildFixtureArtifact("other-hub", "zeta", "A different hub entirely.");
    const root = tempDir("mixed-hub-root");
    cpSync(sameHub, join(root, "same"), { recursive: true });
    cpSync(otherHub, join(root, "other"), { recursive: true });
    const sameRelease = JSON.parse(readFileSync(join(root, "same", "hub-release.json"), "utf8"));
    const otherRelease = JSON.parse(readFileSync(join(root, "other", "hub-release.json"), "utf8"));
    const manifestPath = join(root, "retained-manifest.json");
    const entries = [
      retainedEntry(root, "same", sameRelease.digest),
      retainedEntry(root, "other", otherRelease.digest),
    ].sort((left, right) => (left.release_digest < right.release_digest ? -1 : 1));
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        createRetainedManifest({
          hub_id: "personal",
          publication_revision: 1,
          deployment_id: "mixed-hub",
          default_release_digest: sameRelease.digest,
          releases: entries,
        }),
        null,
        2,
      )}\n`,
    );
    const config = parseServerConfig({
      EGA_WEB_RETAINED_MANIFEST: manifestPath,
      EGA_WEB_ARTIFACT_DIR: join(root, "same"),
    });
    // The manifest verifies as an envelope and as a set of digests, and only then
    // fails the hub check — so this is a load failure, not a diff failure.
    assert.throws(
      () => getReleases(config),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_UNVERIFIED");
        assert.equal(error.status, 503);
        assert.match(error.message, /different Hub/);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Release detail reports the real artifact identities                      */
/* -------------------------------------------------------------------------- */

describe("release detail reports identities that match the artifact", () => {
  const detail = getReleaseDetail(committedConfig(), COMMITTED_DIGEST);

  test("exactly two artifacts, one per half of the release", () => {
    assert.equal(detail.artifacts.length, 2);
    assert.deepEqual(detail.artifacts.map((entry) => entry.artifact_kind).sort(), ["release", "sqlite"]);
  });

  test("the release artifact's object digest is the envelope digest", () => {
    const entry = detail.artifacts.find((value) => value.artifact_kind === "release");
    assert.ok(entry !== undefined);
    assert.equal(entry.object_digest, COMMITTED_PACKAGE.hub_release_digest);
    assert.equal(entry.object_digest_kind, "hub-release-envelope");
    assert.equal(entry.artifact_file, "hub-release.json");
  });

  test("the sqlite artifact's object digest is release-package.json's byte digest", () => {
    const entry = detail.artifacts.find((value) => value.artifact_kind === "sqlite");
    assert.ok(entry !== undefined);
    assert.equal(entry.object_digest, COMMITTED_PACKAGE.sqlite_artifact_digest);
    assert.equal(entry.object_digest_kind, "sqlite-bytes");
    assert.equal(entry.artifact_file, "registry.sqlite");
  });

  test("byte_length is the real measured size of each file", () => {
    for (const entry of detail.artifacts) {
      assert.equal(entry.byte_length, statSync(join(ARTIFACT, entry.artifact_file)).size);
    }
  });

  test("byte_digest is the real SHA-256 of the bytes on disk", () => {
    for (const entry of detail.artifacts) {
      const bytes = readFileSync(join(ARTIFACT, entry.artifact_file));
      assert.equal(entry.byte_digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }
    // And for the sqlite artifact that measurement must equal the declared digest.
    const sqlite = detail.artifacts.find((value) => value.artifact_kind === "sqlite");
    assert.equal(sqlite.byte_digest, COMMITTED_PACKAGE.sqlite_artifact_digest);
  });

  test("created_at is null with a reason: immutable_objects has no writer", () => {
    for (const entry of detail.artifacts) {
      assert.equal(entry.created_at, null);
      assert.match(entry.created_at_unavailable_reason, /immutable_objects has no writer/);
    }
  });

  test("no absolute path reaches the payload", () => {
    const serialised = JSON.stringify(detail);
    assert.doesNotMatch(serialised, new RegExp(ARTIFACT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialised, /\/tmp\/|\/home\/|\/srv\//);
    // `artifact_file` is a name relative to the artifact directory, never a path.
    for (const entry of detail.artifacts) {
      assert.doesNotMatch(entry.artifact_file, /[/\\]/);
      assert.equal(entry.artifact_file, entry.artifact_file.split("/").pop());
    }
  });

  test("adopted sources are reported with their resolved commits", () => {
    const adopted = COMMITTED_RELEASE.payload.adopted_sources;
    assert.ok(Array.isArray(adopted) && adopted.length > 0, "the committed envelope records an adopted source");
    assert.equal(detail.adopted_sources.length, adopted.length);
    assert.equal(detail.adopted_sources[0].resolved_commit, adopted[0].resolved_commit);
    assert.equal(detail.provenance.adopted_source_count, adopted.length);
    assert.match(detail.adopted_sources[0].resolved_commit, /^[0-9a-f]{40}$/);
  });

  test("per-skill provenance counts are read, and are honestly zero for this release", () => {
    assert.equal(detail.provenance.total_sourced_skills, COMMITTED_SKILL_COUNT);
    // Every row is `local` with no repository and no commit, so zero skills are
    // git-sourced and zero are repository-pinned. That is a measurement of this
    // release, and it differs from the hub-level adopted source above.
    assert.equal(detail.provenance.git_sourced_skills, 0);
    assert.equal(detail.provenance.repository_pinned_skills, 0);
    assert.equal(detail.provenance.unavailable_reason, null);
  });

  test("publication metadata comes from the real candidate and preflight", () => {
    const candidate = JSON.parse(readFileSync(join(ARTIFACT, "candidate.json"), "utf8"));
    const preflight = JSON.parse(readFileSync(join(ARTIFACT, "publication-preflight.json"), "utf8"));
    assert.equal(detail.publication.candidate_digest, candidate.digest);
    assert.equal(detail.publication.release_diff_digest, candidate.payload.publication.release_diff_digest);
    assert.equal(detail.publication.preflight_digest, candidate.payload.publication.preflight_digest);
    assert.equal(detail.publication.publication_policy_revision, candidate.payload.publication.publication_policy_revision);
    // `blockers` and `reviews` live under `payload`, not at the top level. Reading
    // them from the wrong level would silently report "no approvals".
    assert.deepEqual(detail.publication.preflight_blockers, preflight.payload.blockers);
    assert.equal(detail.publication.preflight_blocker_count, preflight.payload.blockers.length);
    assert.equal(detail.audit.approval_count, preflight.payload.reviews.length);
    assert.deepEqual(detail.audit.approval_decisions, [`APPROVED:${preflight.payload.reviews.length}`]);
    assert.equal(detail.publication.unavailable_reason, null);
  });

  test("the absent audit trail is stated rather than shown as an empty list", () => {
    assert.deepEqual(detail.audit.events, []);
    assert.match(detail.audit.events_unavailable_reason, /audit_events has no writer/);
  });

  test("the stable-pointer timestamp is null with a reason", () => {
    assert.equal(detail.stable_pointer_updated_at, null);
    assert.equal(detail.stable_pointer_unavailable_reason, RELEASES_NO_STABLE_POINTER_REASON);
  });

  test("retained bookkeeping is honestly false with no manifest configured", () => {
    assert.equal(detail.retained, false);
    assert.equal(detail.retained_artifact_path, null);
    assert.equal(detail.retained_candidate_digest, null);
    assert.equal(detail.retained_release_package_digest, null);
  });

  test("the release identity is the binding's own, not a rebuilt one", () => {
    assert.equal(detail.release.release_digest, COMMITTED_DIGEST);
    assert.equal(detail.release.status, "unpinned");
    assert.equal(detail.release.snapshot_rows, COMMITTED_PACKAGE.snapshot_rows);
    assert.equal(detail.release.skill_count, COMMITTED_SKILL_COUNT);
  });

  test("a tampered copy fails closed rather than reporting identities", () => {
    const tampered = copyArtifact("tampered");
    const pkgPath = join(tampered, "release-package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.snapshot_rows = pkg.snapshot_rows + 1;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: tampered });
    // The refusal comes from `assertCatalogServable`, so the class is
    // `ReleaseIdentityError` rather than `ReleaseReadError`; what matters is the
    // code, the status, and that no path is disclosed.
    assert.throws(
      () => getReleaseDetail(config, COMMITTED_DIGEST),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_UNVERIFIED");
        assert.equal(error.status, 503);
        assert.doesNotMatch(error.message, /\/tmp\/|\/home\//);
        assert.doesNotMatch(error.message, /SELECT |INSERT |UPDATE /);
        return true;
      },
    );
    // The same refusal reaches the list and the comparison.
    for (const read of [
      () => getReleases(config),
      () => getReleaseComparison(config, { base: COMMITTED_DIGEST, candidate: COMMITTED_DIGEST }),
    ]) {
      assert.throws(read, (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_UNVERIFIED");
        assert.equal(error.status, 503);
        return true;
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Retained manifest: a real two-release history and a real CHANGED diff      */
/* -------------------------------------------------------------------------- */

describe("with a retained manifest, the history is the retained set", () => {
  test("both retained releases are listed, the manifest's revision is real, and a real diff is CHANGED", async () => {
    const root = tempDir("retained-root");
    // The committed artifact, copied under the manifest directory, plus a second
    // genuine artifact built from a hub with the SAME hub_id, so the retained set
    // verifies and a comparison across the two is legitimate.
    cpSync(ARTIFACT, join(root, "committed"), { recursive: true });
    const fixtureDir = await buildFixtureArtifact("personal", "gamma", "A second real release for the same hub.");
    const fixtureTarget = join(root, "second");
    cpSync(fixtureDir, fixtureTarget, { recursive: true });

    const committedRelease = JSON.parse(readFileSync(join(root, "committed", "hub-release.json"), "utf8"));
    const secondRelease = JSON.parse(readFileSync(join(root, "second", "hub-release.json"), "utf8"));
    assert.equal(committedRelease.payload.hub_id, secondRelease.payload.hub_id);

    const manifestPath = join(root, "retained-manifest.json");
    const entries = [
      retainedEntry(root, "committed", committedRelease.digest),
      retainedEntry(root, "second", secondRelease.digest),
    ].sort((left, right) => (left.release_digest < right.release_digest ? -1 : 1));
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        createRetainedManifest({
          hub_id: "personal",
          publication_revision: 7,
          deployment_id: "b4-fixture",
          default_release_digest: committedRelease.digest,
          releases: entries,
        }),
        null,
        2,
      )}\n`,
    );

    const config = parseServerConfig({
      EGA_WEB_RETAINED_MANIFEST: manifestPath,
      EGA_WEB_ARTIFACT_DIR: join(root, "committed"),
    });

    const list = getReleases(config);
    assert.equal(list.history_state, "retained-manifest");
    assert.equal(list.history_unavailable_reason, null);
    assert.equal(list.release_total, 2);
    assert.equal(list.publication_revision, "7");
    assert.equal(list.deployment_id, "b4-fixture");
    // Exactly one row is the deployment's stable release.
    assert.equal(list.releases.filter((row) => row.is_stable).length, 1);
    assert.equal(list.releases.find((row) => row.is_stable).release.release_digest, committedRelease.digest);
    // The retained digests are real and the set has no invented rows.
    assert.deepEqual(
      list.releases.map((row) => row.release.release_digest).sort(),
      [committedRelease.digest, secondRelease.digest].sort(),
    );

    // A real cross-release comparison of two verified artifacts of the same hub.
    const view = getReleaseComparison(config, {
      base: committedRelease.digest,
      candidate: secondRelease.digest,
    });
    assert.equal(view.status, "CHANGED");
    assert.equal(view.base_unavailable_reason, null);
    assert.equal(view.head_unavailable_reason, null);
    // The fixture release holds one skill the committed release does not, and the
    // committed release holds 114 the fixture does not.
    assert.deepEqual(view.added_skill_ids, Object.keys(secondRelease.payload.skill_versions));
    assert.equal(view.removed_skill_ids.length, COMMITTED_SKILL_COUNT);
    assert.equal(view.changed_skill_ids.length, 0);
    assert.equal(view.unchanged_count, 0);
    // The buckets partition each side exactly: removed + changed + unchanged is
    // the base, added + changed + unchanged is the head.
    assert.equal(
      view.removed_skill_ids.length + view.changed_skill_ids.length + view.unchanged_count,
      view.base_skill_count,
    );
    assert.equal(
      view.added_skill_ids.length + view.changed_skill_ids.length + view.unchanged_count,
      view.head_skill_count,
    );
    // A genuinely different release has a different adopted-source or artifact
    // digest, so at least one artifact_changes boolean is true.
    assert.ok(Object.values(view.artifact_changes).some((value) => value === true));

    // And a comparison of the retained release with itself is UNCHANGED, which
    // proves a historical release is diffable rather than refused.
    const self = getReleaseComparison(config, {
      base: secondRelease.digest,
      candidate: secondRelease.digest,
    });
    assert.equal(self.status, "UNCHANGED");
    assert.equal(self.unchanged_count, Object.keys(secondRelease.payload.skill_versions).length);

    // Detail for the historical release resolves through the retained set only.
    const historical = getReleaseDetail(config, secondRelease.digest);
    assert.equal(historical.release.release_digest, secondRelease.digest);
    assert.equal(historical.retained, true);
    assert.equal(historical.retained_artifact_path, "second");
    assert.equal(historical.is_stable, false);
    // It is `unpinned`, not `mismatch`: nothing disagrees, and nothing vouches
    // for it as the current release either.
    assert.equal(historical.release.status, "unpinned");
    assert.match(historical.release.mismatch_reason, /reported as history/);
  });

  test("a retained digest that is not in the set is refused rather than defaulted", async () => {
    const root = tempDir("retained-single");
    cpSync(ARTIFACT, join(root, "committed"), { recursive: true });
    const committedRelease = JSON.parse(readFileSync(join(root, "committed", "hub-release.json"), "utf8"));
    const manifestPath = join(root, "retained-manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        createRetainedManifest({
          hub_id: "personal",
          publication_revision: 1,
          deployment_id: "b4-single",
          default_release_digest: committedRelease.digest,
          releases: [retainedEntry(root, "committed", committedRelease.digest)],
        }),
        null,
        2,
      )}\n`,
    );
    const config = parseServerConfig({ EGA_WEB_RETAINED_MANIFEST: manifestPath });
    const list = getReleases(config);
    assert.equal(list.release_total, 1);
    assert.equal(list.publication_revision, "1");

    assert.throws(
      () => getReleaseDetail(config, OTHER_DIGEST),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_UNAVAILABLE");
        assert.equal(error.status, 404);
        assert.match(error.message, /not retained by this deployment/);
        return true;
      },
    );
    const view = getReleaseComparison(config, {
      base: committedRelease.digest,
      candidate: OTHER_DIGEST,
    });
    assert.equal(view.status, "UNAVAILABLE");
    assert.equal(view.head_unavailable_reason, RELEASES_HISTORICAL_ARTIFACT_UNAVAILABLE);
  });

  test("a retained manifest whose default disagrees with the artifact fails closed", async () => {
    const root = tempDir("retained-mismatch");
    cpSync(ARTIFACT, join(root, "committed"), { recursive: true });
    const otherDir = await buildFixtureArtifact("personal", "delta", "A release that will not be the default.");
    cpSync(otherDir, join(root, "other"), { recursive: true });
    const committedRelease = JSON.parse(readFileSync(join(root, "committed", "hub-release.json"), "utf8"));
    const otherRelease = JSON.parse(readFileSync(join(root, "other", "hub-release.json"), "utf8"));
    const manifestPath = join(root, "retained-manifest.json");
    const entries = [
      retainedEntry(root, "committed", committedRelease.digest),
      retainedEntry(root, "other", otherRelease.digest),
    ].sort((left, right) => (left.release_digest < right.release_digest ? -1 : 1));
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        createRetainedManifest({
          hub_id: "personal",
          publication_revision: 2,
          deployment_id: "b4-mismatch",
          // Names the release the artifact directory does NOT hold.
          default_release_digest: otherRelease.digest,
          releases: entries,
        }),
        null,
        2,
      )}\n`,
    );
    const config = parseServerConfig({
      EGA_WEB_RETAINED_MANIFEST: manifestPath,
      EGA_WEB_ARTIFACT_DIR: join(root, "committed"),
    });
    for (const read of [
      () => getReleases(config),
      () => getReleaseDetail(config, committedRelease.digest),
      () => getReleaseComparison(config, { base: committedRelease.digest, candidate: otherRelease.digest }),
    ]) {
      assert.throws(read, (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_MISMATCH");
        assert.equal(error.status, 503);
        return true;
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-closed ordering                                                        */
/* -------------------------------------------------------------------------- */

describe("a mismatch refuses before any row is read", () => {
  const mismatchConfig = committedConfig({
    EGA_WEB_EXPECTED_RELEASE_DIGEST: `sha256:${"1".repeat(64)}`,
  });

  test("every release read throws E_WEB_RELEASE_MISMATCH", () => {
    for (const read of [
      () => getReleases(mismatchConfig),
      () => getReleaseDetail(mismatchConfig, COMMITTED_DIGEST),
      () => getReleaseComparison(mismatchConfig, { base: COMMITTED_DIGEST, candidate: COMMITTED_DIGEST }),
    ]) {
      assert.throws(read, (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_MISMATCH");
        assert.equal(error.status, 503);
        assert.match(error.message, /Catalog unavailable/);
        return true;
      });
    }
  });

  test("a malformed request is refused before the mismatch is even evaluated", () => {
    // Same ordering rule `catalog.ts` pins: validating first means the error a
    // caller sees depends on their request, not on deployment state.
    assert.throws(
      () => getReleaseComparison(mismatchConfig, { base: "not-a-digest", candidate: "also-not" }),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_DIGEST_INVALID");
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.throws(
      () => getReleaseDetail(mismatchConfig, "not-a-digest"),
      (error) => {
        assert.equal(error.code, "E_WEB_RELEASE_DIGEST_INVALID");
        return true;
      },
    );
  });
});
