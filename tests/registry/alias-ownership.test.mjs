import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applySkillAliases,
  getAliasOwner,
  listSkillAliases,
  openRegistry,
} from "../../packages/registry/dist/index.js";
import { RegistryError } from "../../packages/registry/dist/errors.js";

function hasCode(code) {
  return (error) => error instanceof RegistryError && error.code === code;
}

async function isolatedDb(t) {
  // Single owned teardown: SQLite MUST close before the temp dir is
  // removed (Windows EBUSY — see EGA-565). Never split into two t.after().
  const home = await mkdtemp(join(tmpdir(), "ega-567-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(async () => {
    try {
      registry.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  return registry.db;
}

function insertSkillRows(db, skillId, versionHash) {
  const slash = skillId.indexOf("/");
  const namespace = skillId.slice(0, slash);
  const name = skillId.slice(slash + 1);
  db.prepare(
    "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES (?, ?, ?, ?)",
  ).run(skillId, namespace, name, versionHash);
  db.prepare(
    "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class) VALUES (?, ?, ?, ?, ?)",
  ).run(skillId, versionHash, "{}", "MISSING", "NORMAL");
}

// skills ↔ skill_versions FKs are mutually deferred, so the pair commits atomically.
function insertSkill(db, skillId, versionHash) {
  db.exec("BEGIN");
  try {
    insertSkillRows(db, skillId, versionHash);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original insert failure.
    }
    throw error;
  }
}

const VA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// SPEC-003 §5.1.13 + SPEC-001 §5.1.11.

test("SPEC-003 §5.1.13: DB enforces single global alias ownership", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  insertSkill(db, "ega/b", VB);
  applySkillAliases(db, "ega/a", ["design"]);
  assert.equal(getAliasOwner(db, "design"), "ega/a");
  assert.throws(
    () => db.prepare("INSERT INTO skill_aliases (alias, skill_id) VALUES (?, ?)").run("design", "ega/b"),
    (error) => error instanceof Error,
  );
});

test("SPEC-003 §5.1.13: cross-skill claim fails as E_ALIAS_CONFLICT without driver text", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  insertSkill(db, "ega/b", VB);
  applySkillAliases(db, "ega/a", ["design"]);
  try {
    applySkillAliases(db, "ega/b", ["design"]);
    assert.fail("expected E_ALIAS_CONFLICT");
  } catch (error) {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.code, "E_ALIAS_CONFLICT");
    assert.ok(error.message.includes("design"));
    assert.ok(error.message.includes("ega/a"));
    assert.ok(!error.message.includes("SQLITE"), "driver text must not leak");
  }
  assert.equal(getAliasOwner(db, "design"), "ega/a");
});

test("SPEC-003 §5.1.13: same-skill re-import is idempotent", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  const first = applySkillAliases(db, "ega/a", ["design", "ui"]);
  const second = applySkillAliases(db, "ega/a", ["ui", "design"]);
  assert.deepEqual(first.owned, ["design", "ui"]);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.owned, ["design", "ui"]);
});

test("SPEC-003 §5.1.13: later versions may ADD aliases; omission never releases", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  applySkillAliases(db, "ega/a", ["design"]);
  const added = applySkillAliases(db, "ega/a", ["design", "ui"]);
  assert.deepEqual(added.added, ["ui"]);
  const omitted = applySkillAliases(db, "ega/a", ["ui"]);
  assert.deepEqual(omitted.owned, ["design", "ui"]);
  assert.equal(getAliasOwner(db, "design"), "ega/a");
});

test("SPEC-003 §5.1.13: released aliases can never be reassigned while versions exist", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  insertSkill(db, "ega/b", VB);
  applySkillAliases(db, "ega/a", ["design"]);
  applySkillAliases(db, "ega/a", []);
  assert.equal(getAliasOwner(db, "design"), "ega/a");
  assert.throws(() => applySkillAliases(db, "ega/b", ["design"]), hasCode("E_ALIAS_CONFLICT"));
  assert.equal(getAliasOwner(db, "design"), "ega/a");
});

test("SPEC-003 §5.1.13: failed collision rolls back with no partial claimant rows", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  applySkillAliases(db, "ega/a", ["design"]);
  db.exec("BEGIN");
  try {
    insertSkillRows(db, "ega/b", VB);
    applySkillAliases(db, "ega/b", ["design", "fresh"]);
    assert.fail("expected E_ALIAS_CONFLICT");
  } catch (error) {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.code, "E_ALIAS_CONFLICT");
    db.exec("ROLLBACK");
  }
  assert.deepEqual(listSkillAliases(db, "ega/b"), []);
  assert.equal(getAliasOwner(db, "fresh"), null);
  assert.equal(getAliasOwner(db, "design"), "ega/a");
  const skills = db.prepare("SELECT skill_id AS id FROM skills ORDER BY skill_id ASC").all();
  assert.deepEqual(skills.map((row) => row.id), ["ega/a"]);
});

test("SPEC-003 §5.1.13: alias ownership listing is deterministic", async (t) => {
  const db = await isolatedDb(t);
  insertSkill(db, "ega/a", VA);
  applySkillAliases(db, "ega/a", ["zeta", "alpha", "mid"]);
  assert.deepEqual(listSkillAliases(db, "ega/a"), ["alpha", "mid", "zeta"]);
  assert.equal(getAliasOwner(db, "unknown-alias"), null);
});
