/**
 * Zero -> one -> two -> one -> zero against the REAL source reset code.
 *
 * Set EGA_RESET_SOURCE_ROOT to a checkout of egawilldoit/skills at the reset
 * head (PR #20). The test copies it into a temporary directory, so nothing in
 * the real checkout is modified and no skill is committed to either catalog.
 * When the source checkout is unavailable (for example in the platform-only
 * hosted CI job) the test skips with a visible reason rather than pretending
 * to have proven the lifecycle.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { planOriginalAdd, planSkillRemoval, planSkillUpdate } from "../../apps/web/server/source-manager/planner.ts";

const SOURCE = process.env.EGA_RESET_SOURCE_ROOT;
// The update planner only needs frontmatter scalar parsing; this avoids a new
// dependency in the root test environment.
const parseFrontmatter = (text) => {
  const out = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^([a-z_]+):\s*(?:"([^"]*)"|(\S.*))\s*$/);
    if (match) out[match[1]] = match[2] ?? match[3];
  }
  return out;
};
const VALIDATORS = [
  "scripts/validate_plugin_manifest.py",
  "scripts/validate_catalog.py",
  "scripts/routing_audit.py",
  "scripts/trigger_audit.py",
  "scripts/validate_ega_metadata.py",
];

function walk(root, dir = root, out = {}) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === ".pytest_cache" || entry === "__pycache__") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(root, path, out);
    else out[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
  }
  return out;
}

function validate(root) {
  for (const script of VALIDATORS) {
    const result = spawnSync("python3", [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${script} failed: ${result.stdout}\n${result.stderr}`);
  }
  const generated = spawnSync("python3", ["scripts/sync_openai_yaml.py", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(generated.status, 0, `generated interface check failed: ${generated.stdout}\n${generated.stderr}`);
}

function applyPlan(root, plan) {
  assert.deepEqual(plan.errors, []);
  for (const [path, change] of Object.entries(plan.changes)) {
    const target = join(root, path);
    if (change === null) {
      rmSync(target, { force: true });
      if (path.startsWith("skills/")) {
        const skillDir = join(root, ...path.split("/").slice(0, 2));
        rmSync(skillDir, { recursive: true, force: true });
      }
    }
    else if (typeof change === "string") {
      const parent = join(target, "..");
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(target, change);
    } else {
      const parent = join(target, "..");
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(target, Buffer.from(change.contentBase64, "base64"));
    }
  }
}

function addInput(name, neighbor = null) {
  return {
    operation: "add",
    name,
    description: `${name} reviews evidence in the source catalog and reports useful findings.`,
    body: `# ${name}\n\nInspect the evidence and report what was checked.`,
    triggers: [`${name} review`],
    antiTriggers: ["publish production release"],
    interface: {
      displayName: name,
      shortDescription: `${name} reviews evidence and reports useful findings`,
      prompt: `Use $${name} to review the evidence.`,
    },
    cases: {
      direct: `Review evidence with ${name}`,
      indirect: `Inspect the report and record findings`,
      incomplete: `review evidence`,
      negative: "Summarize quarterly revenue for the board",
      negative_expected: neighbor,
      collision: "Prepare a financial forecast for next quarter",
      collision_expected: neighbor,
      edge: `Review ${name} with incomplete evidence`,
    },
  };
}

test("zero to one to two to one to zero source lifecycle", { skip: !SOURCE || !existsSync(SOURCE) }, () => {
  const root = mkdtempSync(join(tmpdir(), "ega-reset-source-lifecycle-"));
  try {
    cpSync(SOURCE, root, { recursive: true, force: true });
    rmSync(join(root, ".git"), { recursive: true, force: true });

    // STEP 1 — exact empty reset baseline.
    assert.deepEqual(VALIDATORS.map(script => readFileSync(join(root, script), "utf8")).length, VALIDATORS.length);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "tests/trigger-cases.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "upstream-sources.json"), "utf8")).sources, []);
    assert.match(readFileSync(join(root, "scripts/sync_openai_yaml.py"), "utf8"), /^METADATA: dict\[str, tuple\[str, str, str\]\] = \{\}$/m);
    assert.match(readFileSync(join(root, "scripts/build_upstream_sources.py"), "utf8"), /^ORIGINAL: list\[str\] = \[\]$/m);
    validate(root);

    // STEP 2 — first real skill, no invented neighbor.
    const first = planOriginalAdd(walk(root), addInput("first-skill"));
    applyPlan(root, first);
    assert.equal(JSON.parse(readFileSync(join(root, "tests/trigger-cases.json"), "utf8"))[0].negative_expected, null);
    for (const file of ["SKILL.md", "ega.yaml", "agents/openai.yaml"]) {
      assert.ok(existsSync(join(root, "skills/first-skill", file)), `missing ${file}`);
    }
    validate(root);

    // STEP 3 — second skill with a real neighbor; first case stays valid.
    const second = planOriginalAdd(walk(root), addInput("second-skill", "first-skill"));
    applyPlan(root, second);
    const cases = JSON.parse(readFileSync(join(root, "tests/trigger-cases.json"), "utf8"));
    assert.equal(cases.length, 2);
    assert.equal(cases.find(row => row.skill === "first-skill").negative_expected, null);
    assert.equal(cases.find(row => row.skill === "second-skill").negative_expected, "first-skill");
    assert.ok(planOriginalAdd(walk(root), { ...addInput("third-skill", "missing-skill") }).errors.length);
    validate(root);

    // STEP 4 — edit the first skill while preserving provenance and interface identity.
    const updated = planSkillUpdate(walk(root), {
      operation: "update",
      name: "first-skill",
      description: `${"first-skill"} reviews evidence carefully and reports verified findings.`,
      body: "# First Skill\n\nInspect the evidence and record verified findings.\n",
    }, parseFrontmatter);
    applyPlan(root, updated);
    validate(root);

    // STEP 5 — remove the second skill.
    applyPlan(root, planSkillRemoval(walk(root), { operation: "remove", name: "second-skill", confirmation: "second-skill" }));
    assert.deepEqual(JSON.parse(readFileSync(join(root, "upstream-sources.json"), "utf8")).sources.map(row => row.skill), ["first-skill"]);
    validate(root);

    // STEP 6 — remove the last skill and return to the canonical empty form.
    applyPlan(root, planSkillRemoval(walk(root), { operation: "remove", name: "first-skill", confirmation: "first-skill" }));
    assert.deepEqual(JSON.parse(readFileSync(join(root, "upstream-sources.json"), "utf8")).sources, []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "tests/trigger-cases.json"), "utf8")), []);
    assert.match(readFileSync(join(root, "scripts/sync_openai_yaml.py"), "utf8"), /^METADATA: dict\[str, tuple\[str, str, str\]\] = \{\}$/m);
    assert.match(readFileSync(join(root, "scripts/build_upstream_sources.py"), "utf8"), /^ORIGINAL: list\[str\] = \[\]$/m);
    validate(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
