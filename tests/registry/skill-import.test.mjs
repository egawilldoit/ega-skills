import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverSkillRoots,
  getCurrentVersion,
  getSkillVersion,
  getTokenCount,
  importSkills,
  listSkillVersions,
  listVersionSources,
  openRegistry,
  searchSkills,
} from "../../packages/registry/dist/index.js";

const ESTIMATOR = "ega-o200k-v1";

async function isolatedImport(t) {
  // Single owned teardown: SQLite MUST close before the temp base is removed
  // (Windows EBUSY — see EGA-565). Never split into two t.after().
  const base = await mkdtemp(join(tmpdir(), "ega-566-"));
  const home = join(base, "home");
  const src = join(base, "src");
  await mkdir(src, { recursive: true });
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(async () => {
    try {
      registry.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  return { registry, src };
}

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

async function writeSkill(dir, name, options = {}) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name}.\n`;
  await writeFile(join(root, "SKILL.md"), `${frontmatter(name, options.description ?? `${name} skill`)}${body}`);
  if (options.core !== undefined) {
    await writeFile(join(root, "SKILL.core.md"), options.core);
  }
  if (options.egaYaml !== undefined) {
    await writeFile(join(root, "ega.yaml"), options.egaYaml);
  }
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function basicYaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n${extra}`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else if (entry.isFile()) out.set(full, sha256File(full));
    }
  };
  walk(root);
  return out;
}

// Discovery contract (SPEC-003 §5.1.10).

test("SPEC-003 §5.1.10: single skill root imports with full summary", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "alpha", { egaYaml: basicYaml("aliases: [alpha-alias]\n") });
  const summary = await importSkills(registry, { path: join(src, "alpha"), namespace: "ega" });
  assert.deepEqual(summary, { imported: 1, unchanged: 0, failed: 0, failures: [] });
  const current = getCurrentVersion(registry.db, "ega/alpha");
  assert.match(current.versionHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(current.trustLevel, "UNKNOWN");
  assert.deepEqual(
    searchSkills(registry.db, "alpha").map((h) => h.skillId),
    ["ega/alpha"],
  );
});

test("SPEC-003 §5.1.10: nested collection imports every skill root", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "one", { egaYaml: basicYaml() });
  await writeSkill(join(src, "nested"), "two", { egaYaml: basicYaml() });
  await writeSkill(join(src, "nested", "deeper"), "three", { egaYaml: basicYaml() });
  const summary = await importSkills(registry, { path: src, namespace: "ega" });
  assert.deepEqual(summary, { imported: 3, unchanged: 0, failed: 0, failures: [] });
  assert.deepEqual(
    searchSkills(registry.db, "skill").map((h) => h.skillId),
    ["ega/one", "ega/three", "ega/two"],
  );
});

test("SPEC-003 §5.1.10: excluded directories are never descended", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "visible", { egaYaml: basicYaml() });
  for (const excluded of ["node_modules", "dist", ".git", "build", ".next", "coverage", ".venv", "__pycache__"]) {
    await writeSkill(join(src, excluded), "hidden", { egaYaml: basicYaml() });
  }
  const roots = await discoverSkillRoots(src);
  assert.deepEqual(roots, [join(src, "visible")]);
  const summary = await importSkills(registry, { path: src, namespace: "ega" });
  assert.equal(summary.imported, 1);
});

test("SPEC-003 §5.1.10: empty directory yields an empty summary", async (t) => {
  const { registry, src } = await isolatedImport(t);
  assert.deepEqual(await importSkills(registry, { path: src, namespace: "ega" }), {
    imported: 0,
    unchanged: 0,
    failed: 0,
    failures: [],
  });
});

test("SPEC-003 §5.1.10: explicit root stops nested discovery; depth caps at 5", async (t) => {
  const { registry, src } = await isolatedImport(t);
  // A nested SKILL.md inside an explicit root is package content, not a sibling.
  const outer = await writeSkill(src, "outer", { egaYaml: basicYaml() });
  await writeSkill(outer, "inner", { egaYaml: basicYaml() });
  const single = await importSkills(registry, { path: outer, namespace: "ega" });
  assert.deepEqual(single, { imported: 1, unchanged: 0, failed: 0, failures: [] });

  // Depth ladder: a skill 5 levels below start is found; 6 is beyond depth.
  const ladder = join(src, "a", "b", "c", "d", "e");
  await mkdir(ladder, { recursive: true });
  await writeSkill(join(src, "a", "b", "c", "d"), "atdepth5", { egaYaml: basicYaml() });
  await writeSkill(ladder, "atdepth6", { egaYaml: basicYaml() });
  const roots = await discoverSkillRoots(src);
  assert.ok(roots.includes(join(src, "a", "b", "c", "d", "atdepth5")));
  assert.ok(!roots.some((r) => r.includes("atdepth6")));
  // Explicit deep import still works below the discovery depth.
  const deep = await importSkills(registry, { path: join(ladder, "atdepth6"), namespace: "ega" });
  assert.equal(deep.imported, 1);
});

test("SPEC-003 §5.1.10: linked directories are never followed", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "real", { egaYaml: basicYaml() });
  // 'junction' works unprivileged on Windows and behaves as a symlink elsewhere.
  await symlink(join(src, "real"), join(src, "linked"), "junction");
  const roots = await discoverSkillRoots(src);
  assert.deepEqual(roots, [join(src, "real")]);
  const summary = await importSkills(registry, { path: src, namespace: "ega" });
  assert.deepEqual(summary, { imported: 1, unchanged: 0, failed: 0, failures: [] });
});

test("SPEC-003 §5.1.10: candidate roots process in lexical order", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "zeta", { egaYaml: basicYaml() });
  await writeSkill(src, "alpha", { egaYaml: basicYaml() });
  await writeSkill(src, "mid", { egaYaml: basicYaml() });
  assert.deepEqual(await discoverSkillRoots(src), [
    join(src, "alpha"),
    join(src, "mid"),
    join(src, "zeta"),
  ]);
  void registry;
});

// Lifecycle (SPEC-003 §5.1.12, §5.1.14).

test("SPEC-003 §5.1.12: unchanged re-import is NO_CHANGE with no duplicates", async (t) => {
  const { registry, src } = await isolatedImport(t);
  const root = await writeSkill(src, "stable", { egaYaml: basicYaml() });
  const first = await importSkills(registry, { path: root, namespace: "ega" });
  assert.equal(first.imported, 1);
  const second = await importSkills(registry, { path: root, namespace: "ega" });
  assert.deepEqual(second, { imported: 0, unchanged: 1, failed: 0, failures: [] });
  assert.equal(listSkillVersions(registry.db, "ega/stable").length, 1);
  const version = getCurrentVersion(registry.db, "ega/stable");
  assert.equal(listVersionSources(registry.db, "ega/stable", version.versionHash).length, 1);
});

test("SPEC-003 §5.1.12: changed content moves current and retains history", async (t) => {
  const { registry, src } = await isolatedImport(t);
  const root = await writeSkill(src, "evolving", { egaYaml: basicYaml() });
  await importSkills(registry, { path: root, namespace: "ega" });
  const v1 = getCurrentVersion(registry.db, "ega/evolving").versionHash;
  await writeFile(join(root, "SKILL.md"), `${frontmatter("evolving", "evolving skill")}# evolving\n\nRevised guidance.\n`);
  const changed = await importSkills(registry, { path: root, namespace: "ega" });
  assert.deepEqual(changed, { imported: 1, unchanged: 0, failed: 0, failures: [] });
  const v2 = getCurrentVersion(registry.db, "ega/evolving").versionHash;
  assert.notEqual(v1, v2);
  assert.equal(getSkillVersion(registry.db, "ega/evolving", v1).versionHash, v1);
  assert.equal(listSkillVersions(registry.db, "ega/evolving").length, 2);
  // Restoring v1 content reuses the historical row without duplication.
  await writeFile(join(root, "SKILL.md"), `${frontmatter("evolving", "evolving skill")}# evolving\n\nGuidance text for evolving.\n`);
  const back = await importSkills(registry, { path: root, namespace: "ega" });
  assert.equal(back.imported, 1);
  assert.equal(getCurrentVersion(registry.db, "ega/evolving").versionHash, v1);
  assert.equal(listSkillVersions(registry.db, "ega/evolving").length, 2);
});

test("SPEC-003 §5.1.12: same portable name coexists across namespaces", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "shared", { egaYaml: basicYaml() });
  const a = await importSkills(registry, { path: join(src, "shared"), namespace: "team-a" });
  const b = await importSkills(registry, { path: join(src, "shared"), namespace: "team-b" });
  assert.equal(a.imported, 1);
  assert.equal(b.imported, 1);
  assert.ok(getCurrentVersion(registry.db, "team-a/shared").versionHash.startsWith("sha256:"));
  assert.ok(getCurrentVersion(registry.db, "team-b/shared").versionHash.startsWith("sha256:"));
});

// Partial failure (SPEC-003 §5.1.11, §5.1.13).

test("SPEC-003 §5.1.11: one bad sibling never rolls back valid siblings", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "good", { egaYaml: basicYaml() });
  const bad = join(src, "bad");
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "SKILL.md"), "---\nno-name-here: true\n---\nbody\n");
  const summary = await importSkills(registry, { path: src, namespace: "ega" });
  assert.equal(summary.imported, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].path, bad);
  assert.ok(summary.failures[0].error.length > 0);
  assert.ok(getCurrentVersion(registry.db, "ega/good").versionHash.startsWith("sha256:"));
});

test("SPEC-003 §5.1.13: alias conflict fails only the claimant skill", async (t) => {
  const { registry, src } = await isolatedImport(t);
  // Lexical order imports the owner first, so the claimant deterministically fails.
  await writeSkill(src, "a-owner", { egaYaml: basicYaml("aliases: [contested]\n") });
  await writeSkill(src, "z-claimant", { egaYaml: basicYaml("aliases: [contested]\n") });
  const summary = await importSkills(registry, { path: src, namespace: "ega" });
  assert.equal(summary.imported, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].path, join(src, "z-claimant"));
  assert.ok(summary.failures[0].error.includes("contested"));
  // No partial rows for the failed claimant: no skill, version, alias, or FTS residue.
  assert.equal(
    registry.db.prepare("SELECT COUNT(*) AS n FROM skills WHERE skill_id = 'ega/z-claimant'").get().n,
    0,
  );
  assert.equal(
    registry.db.prepare("SELECT COUNT(*) AS n FROM skill_fts WHERE skill_id = 'ega/z-claimant'").get().n,
    0,
  );
  assert.equal(
    registry.db.prepare("SELECT COUNT(*) AS n FROM skill_aliases WHERE skill_id = 'ega/z-claimant'").get()
      .n,
    0,
  );
});

// Persistence details (AMEND-02/03).

test("SPEC-003 §5.1.16: text bodies persist token counts; binary never does", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "counted", {
    egaYaml: basicYaml(),
    core: "---\nname: counted\ndescription: counted skill\n---\n# counted core\n",
    files: { "assets/logo.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  });
  const summary = await importSkills(registry, { path: join(src, "counted"), namespace: "ega" });
  assert.equal(summary.imported, 1);
  const version = getCurrentVersion(registry.db, "ega/counted");
  const files = registry.db
    .prepare("SELECT path AS path, blob_hash AS blob, content_kind AS kind FROM skill_files WHERE skill_id = 'ega/counted'")
    .all();
  assert.ok(files.length >= 4);
  for (const file of files.filter((f) => f.kind === "TEXT" && (f.path === "SKILL.md" || f.path === "SKILL.core.md"))) {
    const count = getTokenCount(registry.db, file.blob, ESTIMATOR);
    assert.ok(typeof count === "number" && count > 0, `${file.path} counted`);
  }
  const binary = files.find((f) => f.path === "assets/logo.png");
  assert.equal(binary.kind, "BINARY");
  assert.equal(getTokenCount(registry.db, binary.blob, ESTIMATOR), null);
});

test("SPEC-003 §5.1.11: source trees are never rewritten", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "pristine", {
    egaYaml: basicYaml(),
    core: "core text",
    files: { "references/guide.md": "guide", "scripts/run.mjs": "export {};\n" },
  });
  const before = snapshotTree(src);
  await importSkills(registry, { path: src, namespace: "ega" });
  await importSkills(registry, { path: src, namespace: "ega" });
  assert.deepEqual(snapshotTree(src), before);
});

test("SPEC-003 §5.1.11: namespace is required and never guessed", async (t) => {
  const { registry, src } = await isolatedImport(t);
  await writeSkill(src, "guarded", { egaYaml: basicYaml() });
  await assert.rejects(() => importSkills(registry, { path: src, namespace: "NOT A NAMESPACE" }));
  await assert.rejects(() => importSkills(registry, { path: join(src, "missing") }));
});

// Scale and performance.

test("SPEC-003 §5.1.11: 80 real-style skills import in one batch", async (t) => {
  const { registry, src } = await isolatedImport(t);
  for (let i = 0; i < 80; i += 1) {
    const name = `real-${String(i).padStart(3, "0")}`;
    await writeSkill(join(src, "collection"), name, {
      egaYaml: basicYaml(`aliases: [alias-${i}]\n`),
      core: `${frontmatter(name, `${name} skill`)}# ${name} core\n`,
      files: {
        "references/guide.md": `# Guide ${i}\n`,
        "scripts/run.mjs": `// script ${i}\n`,
      },
    });
  }
  const summary = await importSkills(registry, { path: join(src, "collection"), namespace: "ega" });
  assert.deepEqual(summary, { imported: 80, unchanged: 0, failed: 0, failures: [] });
}, { timeout: 120000 });

test("SPEC-003 §5.1.11: 100-skill cold import targets <= 5 s", async (t) => {
  const { registry, src } = await isolatedImport(t);
  for (let i = 0; i < 100; i += 1) {
    const name = `cold-${String(i).padStart(3, "0")}`;
    await writeSkill(join(src, "cold"), name, { egaYaml: basicYaml() });
  }
  const start = performance.now();
  const summary = await importSkills(registry, { path: join(src, "cold"), namespace: "ega" });
  const elapsed = performance.now() - start;
  console.log(`ℹ 100-skill cold import: ${elapsed.toFixed(0)} ms`);
  assert.equal(summary.imported, 100);
  assert.ok(elapsed <= 5000, `cold import took ${elapsed.toFixed(0)} ms`);
}, { timeout: 120000 });

test("SPEC-003 §5.1.11: 500 synthetic skills are supported", async (t) => {
  const { registry, src } = await isolatedImport(t);
  for (let i = 0; i < 500; i += 1) {
    await writeSkill(join(src, "synth"), `s-${String(i).padStart(3, "0")}`, { egaYaml: basicYaml() });
  }
  const start = performance.now();
  const summary = await importSkills(registry, { path: join(src, "synth"), namespace: "ega" });
  console.log(`ℹ 500-skill import: ${(performance.now() - start).toFixed(0)} ms`);
  assert.deepEqual(summary, { imported: 500, unchanged: 0, failed: 0, failures: [] });
}, { timeout: 300000 });

// Hygiene: offline local-first, no network/remote behavior in the pipeline.
test("SPEC-003 §5.1.8–§5.1.9: importer stays offline with no remote store", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "registry", "src");
  const sources = readdirSync(srcDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(join(srcDir, file), "utf8"));
  for (const source of sources) {
    assert.ok(!source.includes("fetch("), "registry must not fetch");
    assert.ok(!source.includes("node:http"), "registry must not use http");
  }
  const importerSource = readFileSync(join(srcDir, "importer.ts"), "utf8");
  assert.ok(!importerSource.includes("unlinkSync(finalPath"), "importer must never GC blobs");
});
