// Capability-enforced read-only registry opens (EGA-601, SPEC-006 §5.3).
//
// resolveSkills used to open the ordinary read-write registry path, which
// materializes the home tree (mkdir) and runs migrations as a side effect.
// These tests prove the read-only capability at the owning layer:
//   1. missing home/database fails closed WITHOUT creating directories;
//   2. stale-schema databases are REFUSED (never auto-migrated), byte-identical;
//   3. normal current-schema resolve works and mutates nothing.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importSkills, openRegistry } from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function writeSkill(dir, name) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill for read-only audit.\n---\n# ${name}\n\nGuidance.\n`,
  );
}

async function makeProject(t) {
  const proj = join(await mkdtemp(join(tmpdir(), "ega-601-proj-")), "proj");
  await mkdir(proj, { recursive: true });
  t.after(() => rm(join(proj, ".."), { recursive: true, force: true }));
  return proj;
}

async function makeHome(t, withSkill) {
  const base = await mkdtemp(join(tmpdir(), "ega-601-"));
  const home = join(base, "home");
  t.after(() => rm(base, { recursive: true, force: true }));
  if (withSkill) {
    const src = join(base, "src");
    await mkdir(src, { recursive: true });
    await writeSkill(src, "alpha");
    const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
    try {
      const summary = await importSkills(registry, { path: src, namespace: "ega" });
      assert.equal(summary.imported, 1);
    } finally {
      registry.close();
    }
  }
  return { base, home };
}

test("readonly: missing database fails closed without creating the home tree", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ega-601-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "no-such-home");
  const env = { EGA_SKILLS_HOME: home };
  assert.throws(() => openRegistry({ env, readonly: true }), (error) => {
    assert.equal(error.code, "E_REGISTRY_DB_OPEN");
    return true;
  });
  assert.ok(!existsSync(home), "read-only open must not materialize the home tree");
  const proj = await makeProject(t);
  await assert.rejects(resolveSkills({ task: "do a thing", projectPath: proj, env }));
  assert.ok(!existsSync(home), "resolve must not materialize the home tree");
});

test("readonly: stale schema is refused, never migrated, byte-identical", async (t) => {
  const { home } = await makeHome(t, true);
  const dbPath = join(home, "registry.sqlite");
  // Backdate the schema version through a read-write handle (v2 tables stay
  // shaped, so the legacy path WOULD migrate this file: real refusal proof).
  {
    const rw = openRegistry({ env: { EGA_SKILLS_HOME: home } });
    try {
      rw.db.exec("PRAGMA user_version = 1");
    } finally {
      rw.close();
    }
  }
  const before = sha256File(dbPath);
  assert.throws(
    () => openRegistry({ env: { EGA_SKILLS_HOME: home }, readonly: true }),
    (error) => {
      assert.equal(error.code, "E_REGISTRY_MIGRATION");
      return true;
    },
  );
  assert.equal(sha256File(dbPath), before, "refused open must not write");
  const proj = await makeProject(t);
  await assert.rejects(
    resolveSkills({ task: "do a thing", projectPath: proj, env: { EGA_SKILLS_HOME: home } }),
  );
  assert.equal(sha256File(dbPath), before, "resolve must not migrate a stale registry");
  // Note: genuine v1→v2 migration through read-write opens is proven by the
  // existing migration-backfill suite (source-observed-at.test.mjs); this
  // fixture proves the read-only path refuses ANY version mismatch instead
  // of attempting an upgrade.
});

test("readonly: current-schema resolve works and mutates nothing", async (t) => {
  const { home } = await makeHome(t, true);
  const dbPath = join(home, "registry.sqlite");
  const env = { EGA_SKILLS_HOME: home };
  const ro = openRegistry({ env, readonly: true });
  try {
    const count = ro.db.prepare("SELECT COUNT(*) AS n FROM skill_versions").get();
    assert.equal(count.n, 1);
  } finally {
    ro.close();
  }
  const before = sha256File(dbPath);
  const proj = await makeProject(t);
  const result = await resolveSkills({ task: "alpha guidance", projectPath: proj, env });
  const routed = [...result.selected, ...result.candidates].map((c) => c.id);
  assert.ok(routed.includes("ega/alpha"), "alpha stays routable");
  assert.equal(sha256File(dbPath), before, "resolve must not mutate the database file");
});

test("readonly: concurrent resolve storm mutates nothing", async (t) => {
  const { home } = await makeHome(t, true);
  const dbPath = join(home, "registry.sqlite");
  const env = { EGA_SKILLS_HOME: home };
  const before = sha256File(dbPath);
  const proj = await makeProject(t);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      resolveSkills({ task: `alpha guidance run ${i}`, projectPath: proj, env }),
    ),
  );
  assert.ok(results.every((r) => [...r.selected, ...r.candidates].some((c) => c.id === "ega/alpha")));
  assert.equal(sha256File(dbPath), before, "concurrent resolves must not mutate the database file");
});
