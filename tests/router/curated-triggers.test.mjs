// Curated ega.yaml triggers/domains as the supported third-party routing lever
// (V1.0.1): the proven to-spec vs to-tickets boundary. Upstream glosses for
// spec-writing vs ticket-splitting overlap heavily ("turn the thread into X");
// the deterministic router disambiguates through CURATED triggers/domains,
// never through LLM judgment. These EGA-authored fixtures pin that boundary:
// near-identical descriptions, triggers decide.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importSkills, openRegistry } from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

async function world(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-curated-"));
  const env = { ...process.env, EGA_SKILLS_HOME: join(base, "home") };
  const src = join(base, "src");
  const proj = join(base, "proj");
  await mkdir(src, { recursive: true });
  await mkdir(proj, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { env, src, proj };
}

async function writeSkill(dir, name, description, egaYaml) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nGuidance.\n`);
  await writeFile(join(root, "ega.yaml"), `schema_version: 1\n${egaYaml}`);
}

async function importWorld(t) {
  const w = await world(t);
  // Deliberately overlapping glosses (the proven confusion shape); curated
  // triggers/domains carry the distinction.
  await writeSkill(
    w.src,
    "thread-spec",
    "Turn the current thread into a published artifact with no interview.",
    "domains: [planning]\ntriggers: [publish spec, spec first]\n",
  );
  await writeSkill(
    w.src,
    "thread-tickets",
    "Turn the current thread into a published artifact with blocking edges.",
    "domains: [planning]\ntriggers: [split into tickets, blocking edges, tracer bullets]\n",
  );
  const registry = openRegistry({ env: w.env });
  try {
    const summary = await importSkills(registry, { path: w.src, namespace: "ega" });
    assert.equal(summary.imported, 2);
  } finally {
    registry.close();
  }
  return w;
}

async function topId(w, task) {
  const result = await resolveSkills({ task, projectPath: w.proj, env: w.env });
  assert.ok(result.selected.length > 0, `expected an automatic selection for: ${task}`);
  return { selected: result.selected.map((s) => s.id), candidates: result.candidates.map((s) => s.id) };
}

test("curated triggers route spec-synthesis to the spec skill, not tickets", async (t) => {
  const w = await importWorld(t);
  const routed = await topId(w, "take this thread and publish spec with no interview");
  assert.equal(routed.selected[0], "ega/thread-spec");
  assert.ok(!routed.selected.includes("ega/thread-tickets"));
});

test("curated triggers route ticket-splitting to the tickets skill, not spec", async (t) => {
  const w = await importWorld(t);
  const routed = await topId(w, "split this plan into tracer-bullet tickets with blocking edges");
  assert.equal(routed.selected[0], "ega/thread-tickets");
  assert.ok(!routed.selected.includes("ega/thread-spec"));
});
