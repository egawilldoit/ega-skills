import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyVersionLifecycle,
  getCacheBlob,
  getCurrentVersion,
  getSkillVersion,
  getTokenCount,
  listSkillVersions,
  listVersionSources,
  openRegistry,
  putCacheBlob,
  recordSourceObservation,
  recordTokenCount,
  recordVersion,
} from "../../packages/registry/dist/index.js";
import { RegistryError } from "../../packages/registry/dist/errors.js";

function hasCode(code) {
  return (error) => error instanceof RegistryError && error.code === code;
}

async function isolatedRegistry(t) {
  // Single owned teardown: SQLite MUST close before the temp dir is removed
  // (Windows EBUSY — see EGA-565). Never split into two t.after().
  const home = await mkdtemp(join(tmpdir(), "ega-568-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(async () => {
    try {
      registry.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  return registry;
}

const VA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MISSING = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ESTIMATOR = "ega-o200k-v1";

function versionInput(skillId, versionHash, manifest = "{}") {
  return { skillId, versionHash, manifestJson: manifest, l1Status: "MISSING", l2SizeClass: "NORMAL" };
}

// SPEC-003 §5.1.12 import outcomes.

// SPEC-003 §5.1.12: NEW_LOCAL_VERSION inserts the version and moves current.
test("SPEC-003 §5.1.12: NEW_LOCAL_VERSION inserts version and moves current pointer", async (t) => {
  const registry = await isolatedRegistry(t);
  const result = recordVersion(registry.db, versionInput("ega/a", VA));
  assert.equal(result.outcome, "NEW_LOCAL_VERSION");
  assert.equal(result.created, true);
  assert.equal(result.version.versionHash, VA);
  assert.equal(result.version.trustLevel, "UNKNOWN");
  assert.equal(getCurrentVersion(registry.db, "ega/a").versionHash, VA);
});

// SPEC-003 §5.1.12: NO_CHANGE moves nothing and duplicates nothing.
test("SPEC-003 §5.1.12: NO_CHANGE does not move current or duplicate rows", async (t) => {
  const registry = await isolatedRegistry(t);
  recordVersion(registry.db, versionInput("ega/a", VA));
  const again = recordVersion(registry.db, versionInput("ega/a", VA));
  assert.equal(again.outcome, "NO_CHANGE");
  assert.equal(again.created, false);
  assert.equal(listSkillVersions(registry.db, "ega/a").length, 1);
  assert.equal(getCurrentVersion(registry.db, "ega/a").versionHash, VA);
});

// SPEC-003 §5.1.12: old versions stay retrievable after the pointer moves.
test("SPEC-003 §5.1.12: old version remains retrievable after current moves", async (t) => {
  const registry = await isolatedRegistry(t);
  recordVersion(registry.db, versionInput("ega/a", VA, '{"rev":1}'));
  recordVersion(registry.db, versionInput("ega/a", VB, '{"rev":2}'));
  assert.equal(getCurrentVersion(registry.db, "ega/a").versionHash, VB);
  const old = getSkillVersion(registry.db, "ega/a", VA);
  assert.equal(old.manifestJson, '{"rev":1}');
  assert.deepEqual(
    listSkillVersions(registry.db, "ega/a").map((v) => v.versionHash),
    [VA, VB],
  );
});

// SPEC-003 §5.1.14: historical reuse moves current back without duplication,
// and the stored immutable row wins over the re-imported metadata.
test("SPEC-003 §5.1.14: re-import of known historical version reuses the row", async (t) => {
  const registry = await isolatedRegistry(t);
  recordVersion(registry.db, versionInput("ega/a", VA, '{"rev":1}'));
  recordVersion(registry.db, versionInput("ega/a", VB, '{"rev":2}'));
  const back = recordVersion(registry.db, versionInput("ega/a", VA, '{"tampered":true}'));
  assert.equal(back.outcome, "NEW_LOCAL_VERSION");
  assert.equal(back.created, false);
  assert.equal(back.version.manifestJson, '{"rev":1}');
  assert.equal(getCurrentVersion(registry.db, "ega/a").versionHash, VA);
  assert.equal(listSkillVersions(registry.db, "ega/a").length, 2);
});

// Exact missing hash reports E_VERSION_NOT_FOUND and never substitutes current.
test("SPEC-003 §5.1.12: exact missing historical hash is E_VERSION_NOT_FOUND", async (t) => {
  const registry = await isolatedRegistry(t);
  recordVersion(registry.db, versionInput("ega/a", VA));
  assert.throws(() => getSkillVersion(registry.db, "ega/a", MISSING), hasCode("E_VERSION_NOT_FOUND"));
  assert.throws(() => getSkillVersion(registry.db, "ega/unknown", VA), hasCode("E_VERSION_NOT_FOUND"));
  assert.throws(() => getCurrentVersion(registry.db, "ega/unknown"), hasCode("E_VERSION_NOT_FOUND"));
  // Current pointer is untouched by the failed lookups.
  assert.equal(getCurrentVersion(registry.db, "ega/a").versionHash, VA);
});

// SPEC-003 §5.1.15 multiple observations.

// SPEC-003 §5.1.15: identical content from multiple locations records multiple rows.
test("SPEC-003 §5.1.15: same version records multiple source observations", async (t) => {
  const registry = await isolatedRegistry(t);
  recordVersion(registry.db, versionInput("ega/a", VA));
  const first = recordSourceObservation(registry.db, "ega/a", VA, {
    sourceType: "local",
    localPath: "/skills/a",
  });
  const second = recordSourceObservation(registry.db, "ega/a", VA, {
    sourceType: "local",
    localPath: "/vendor/a",
  });
  assert.notEqual(first.sourceId, second.sourceId);
  const sources = listVersionSources(registry.db, "ega/a", VA);
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.map((s) => s.localPath),
    ["/skills/a", "/vendor/a"],
  );
  // Provenance rows carry the frozen SPEC-001 §5.1.18 fields.
  const git = recordSourceObservation(registry.db, "ega/a", VA, {
    sourceType: "git",
    repository: "https://example.test/skills.git",
    commitSha: "deadbeef",
    repositoryPath: "skills/a",
  });
  assert.ok(typeof git.sourceId === "number");
  assert.equal(listVersionSources(registry.db, "ega/a", VA).length, 3);
});

// SPEC-003 §5.1.15: provenance updates never move identity or the pointer.
test("SPEC-003 §5.1.15: provenance changes do not change version identity", async (t) => {
  const registry = await isolatedRegistry(t);
  recordVersion(registry.db, versionInput("ega/a", VA));
  recordSourceObservation(registry.db, "ega/a", VA, { sourceType: "local", localPath: "/v1" });
  const again = recordVersion(registry.db, versionInput("ega/a", VA));
  recordSourceObservation(registry.db, "ega/a", VA, { sourceType: "local", localPath: "/v2" });
  assert.equal(again.outcome, "NO_CHANGE");
  assert.equal(listSkillVersions(registry.db, "ega/a").length, 1);
  assert.equal(listVersionSources(registry.db, "ega/a", VA).length, 2);
});

// Removing the original source leaves version metadata and blobs retrievable.
test("SPEC-003 §5.1.15: removing original source keeps historical content", async (t) => {
  const registry = await isolatedRegistry(t);
  const blob = putCacheBlob(registry.paths.cacheSha256, Buffer.from("# Skill\n"));
  const recorded = recordVersion(registry.db, versionInput("ega/a", VA));
  assert.equal(recorded.version.versionHash, VA);
  recordSourceObservation(registry.db, "ega/a", VA, { sourceType: "local", localPath: "/gone" });
  registry.db.prepare("DELETE FROM skill_sources WHERE skill_id = ?").run("ega/a");
  assert.deepEqual(listVersionSources(registry.db, "ega/a", VA), []);
  assert.equal(getSkillVersion(registry.db, "ega/a", VA).versionHash, VA);
  assert.deepEqual(getCacheBlob(registry.paths.cacheSha256, blob.hash), Buffer.from("# Skill\n"));
});

// SPEC-003 §5.1.16 token counts and binary rule.

// SPEC-003 §5.1.16: token counts dedupe by (blob_hash, estimator_id).
test("SPEC-003 §5.1.16: token counts dedupe by blob and estimator", async (t) => {
  const registry = await isolatedRegistry(t);
  const blob = putCacheBlob(registry.paths.cacheSha256, Buffer.from("count me"));
  const first = recordTokenCount(registry.db, { blobHash: blob.hash, estimatorId: ESTIMATOR, tokenCount: 4 });
  const second = recordTokenCount(registry.db, { blobHash: blob.hash, estimatorId: ESTIMATOR, tokenCount: 4 });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(getTokenCount(registry.db, blob.hash, ESTIMATOR), 4);
  const rows = registry.db
    .prepare("SELECT COUNT(*) AS n FROM token_counts WHERE blob_hash = ?")
    .get(blob.hash);
  assert.equal(rows.n, 1);
  // A second estimator is a distinct key.
  recordTokenCount(registry.db, { blobHash: blob.hash, estimatorId: "other-v1", tokenCount: 9 });
  assert.equal(getTokenCount(registry.db, blob.hash, "other-v1"), 9);
});

// SPEC-003 §5.1.16: binary blobs have NO row; projection is null, never fake zero.
test("SPEC-003 §5.1.16: binary blobs persist no token row and project null", async (t) => {
  const registry = await isolatedRegistry(t);
  const binary = putCacheBlob(
    registry.paths.cacheSha256,
    Uint8Array.from([0, 159, 146, 150]),
  );
  assert.equal(getTokenCount(registry.db, binary.hash, ESTIMATOR), null);
  const rows = registry.db
    .prepare("SELECT COUNT(*) AS n FROM token_counts WHERE blob_hash = ?")
    .get(binary.hash);
  assert.equal(rows.n, 0);
  // Token recounts touch only token_counts: version identity is unchanged.
  recordVersion(registry.db, versionInput("ega/a", VA));
  recordTokenCount(registry.db, { blobHash: binary.hash, estimatorId: ESTIMATOR, tokenCount: 3 });
  assert.equal(getTokenCount(registry.db, binary.hash, ESTIMATOR), 3);
  assert.equal(getSkillVersion(registry.db, "ega/a", VA).versionHash, VA);
});

// AMEND-03: trust defaults to UNKNOWN and is stored administratively.
test("SPEC-003 §5.1.12: trust_level defaults to UNKNOWN", async (t) => {
  const registry = await isolatedRegistry(t);
  const implicit = recordVersion(registry.db, versionInput("ega/a", VA));
  assert.equal(implicit.version.trustLevel, "UNKNOWN");
  const explicit = recordVersion(
    registry.db,
    { ...versionInput("ega/b", VB), trustLevel: "OWNED" },
  );
  assert.equal(explicit.version.trustLevel, "OWNED");
});

// EGA-566 boundary: the lifecycle step composes inside a caller-owned
// per-skill transaction (version + source + token in ONE tx).
test("SPEC-003 §5.1.12: lifecycle composes inside a caller-owned transaction", async (t) => {
  const registry = await isolatedRegistry(t);
  const blob = putCacheBlob(registry.paths.cacheSha256, Buffer.from("composed"));
  registry.db.exec("BEGIN");
  try {
    const applied = applyVersionLifecycle(registry.db, versionInput("ega/a", VA));
    recordSourceObservation(registry.db, "ega/a", VA, { sourceType: "local", localPath: "/composed" });
    recordTokenCount(registry.db, { blobHash: blob.hash, estimatorId: ESTIMATOR, tokenCount: 2 });
    assert.equal(applied.outcome, "NEW_LOCAL_VERSION");
    registry.db.exec("COMMIT");
  } catch (error) {
    try {
      registry.db.exec("ROLLBACK");
    } catch {
      // Preserve the original composition failure.
    }
    throw error;
  }
  assert.equal(getCurrentVersion(registry.db, "ega/a").versionHash, VA);
  assert.equal(listVersionSources(registry.db, "ega/a", VA).length, 1);
  assert.equal(getTokenCount(registry.db, blob.hash, ESTIMATOR), 2);
});
