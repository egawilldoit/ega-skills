import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  commitPreparedSkill,
  getCurrentVersion,
  listSkillVersions,
  openRegistry,
  prepareSkillRoot,
} from "../../packages/registry/dist/index.js";

function skillBody(name, text = "Guidance text.\n") {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n\n${text}`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(t, name) {
  const base = await mkdtemp(join(tmpdir(), `ega-preparation-${name}-`));
  const root = join(base, "src", "prepared");
  await mkdir(root, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, home: join(base, "home") };
}

test("preparation is zero-mutation and commit owns persistence", async (t) => {
  const { root, home } = await fixture(t, "boundary");
  const body = skillBody("prepared");
  await writeFile(join(root, "SKILL.md"), body);

  const prepared = await prepareSkillRoot(root, "ega");
  assert.equal(prepared.skillId, "ega/prepared");
  assert.match(prepared.versionHash, /^sha256:/);
  assert.equal(await pathExists(home), false);
  assert.equal(await readFile(join(root, "SKILL.md"), "utf8"), body);

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(() => registry.close());
  const committed = commitPreparedSkill(registry, prepared);
  assert.equal(committed.skillId, "ega/prepared");
  assert.equal(getCurrentVersion(registry.db, "ega/prepared").versionHash, prepared.versionHash);
});

test("prepared identity supports immutable A/B/A lifecycle without duplicate versions", async (t) => {
  const { root, home } = await fixture(t, "lifecycle");
  const bodyA = skillBody("prepared", "Version A.\n");
  const bodyB = skillBody("prepared", "Version B.\n");
  await writeFile(join(root, "SKILL.md"), bodyA);
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(() => registry.close());

  const a = await prepareSkillRoot(root, "ega");
  commitPreparedSkill(registry, a);
  await writeFile(join(root, "SKILL.md"), bodyB);
  const b = await prepareSkillRoot(root, "ega");
  commitPreparedSkill(registry, b);
  await writeFile(join(root, "SKILL.md"), bodyA);
  const restored = await prepareSkillRoot(root, "ega");
  commitPreparedSkill(registry, restored);

  assert.equal(getCurrentVersion(registry.db, "ega/prepared").versionHash, a.versionHash);
  assert.equal(listSkillVersions(registry.db, "ega/prepared").length, 2);
});

test("oversized authored L1 demotes to MISSING while valid L2 remains prepared", async (t) => {
  const { root, home } = await fixture(t, "l1");
  await writeFile(join(root, "SKILL.md"), skillBody("prepared"));
  await writeFile(join(root, "SKILL.core.md"), "core guidance ".repeat(6000));

  const prepared = await prepareSkillRoot(root, "ega");
  assert.equal(prepared.l1Status, "MISSING");
  assert.equal(prepared.l1Tokens, null);
  assert.ok(prepared.l2Tokens > 0);

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(() => registry.close());
  commitPreparedSkill(registry, prepared);
  assert.equal(getCurrentVersion(registry.db, "ega/prepared").l1Status, "MISSING");
});

test("commit rejects mutation of prepared canonical bytes", async (t) => {
  const { root, home } = await fixture(t, "tamper");
  await writeFile(join(root, "SKILL.md"), skillBody("prepared"));
  const prepared = await prepareSkillRoot(root, "ega");
  const skillMd = prepared.files.find((file) => file.record.path === "SKILL.md");
  assert.ok(skillMd);
  skillMd.bytes[0] = skillMd.bytes[0] ^ 1;

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(() => registry.close());
  assert.throws(() => commitPreparedSkill(registry, prepared), /hash changed/);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM skills").get().n, 0);
});
