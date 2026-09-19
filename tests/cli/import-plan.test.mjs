import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntrypoint = join(root, "packages", "cli", "bin", "ega-skills.mjs");
const contractValidator = join(root, "scripts", "contracts", "validate-contract-g.mjs");

async function isolatedBase(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-intake-plan-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function envFor(base) {
  return { ...process.env, EGA_SKILLS_HOME: join(base, "home") };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeSkill(dir, name, { body, description, core, aliases } = {}) {
  const skill = join(dir, name);
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: ${description ?? `${name} skill`}\n---\n${body ?? `# ${name}\n\nGuidance.\n`}`);
  if (core !== undefined) await writeFile(join(skill, "SKILL.core.md"), core);
  if (aliases !== undefined) await writeFile(join(skill, "ega.yaml"), `schema_version: 1\naliases: [${aliases.join(", ")}]\n`);
  return skill;
}

async function readPlan(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function snapshotTree(rootPath) {
  const entries = await readdir(rootPath, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? entry.path;
    const path = join(parent, entry.name);
    files.push([path.slice(rootPath.length), (await readFile(path)).toString("base64")]);
  }
  return files.sort((left, right) => left[0].localeCompare(right[0]));
}

function planArgs(source, output) {
  return ["import-plan", source, "--namespace", "ega", "--output", output];
}

test("IP-01: valid preview predicts identity without creating the target home", async (t) => {
  const base = await isolatedBase(t);
  const source = await writeSkill(join(base, "source"), "alpha");
  const output = join(base, "plan.json");
  const result = runCli(planArgs(source, output), envFor(base));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).blocked_count, 0);
  const plan = await readPlan(output);
  assert.equal(plan.payload.target.mode, "EMPTY");
  assert.equal(plan.payload.candidates.length, 1);
  assert.equal(plan.payload.candidates[0].proposed_id, "ega/alpha");
  assert.match(plan.payload.candidates[0].version_hash, /^sha256:[0-9a-f]{64}$/);
  const validated = spawnSync(process.execPath, [contractValidator, output], { cwd: root, encoding: "utf8" });
  assert.equal(validated.status, 0);
  assert.match(validated.stdout, /^CONTRACT-G-OK sha256:[0-9a-f]{64}\n$/);
  assert.equal(await pathExists(join(base, "home")), false);
});

test("IP-01: preview refuses to write its artifact into the upstream source", async (t) => {
  const base = await isolatedBase(t);
  const source = await writeSkill(join(base, "source"), "protected");
  const before = await snapshotTree(source);
  const result = runCli(planArgs(source, join(source, "plan.json")), envFor(base));
  assert.equal(result.status, 4);
  assert.match(result.stderr, /outside the intake source tree/);
  assert.deepEqual(await snapshotTree(source), before);
});

test("IP-02: existing target preview leaves database and cache byte-identical", async (t) => {
  const base = await isolatedBase(t);
  const source = await writeSkill(join(base, "source"), "stable");
  const env = envFor(base);
  assert.equal(runCli(["import", source, "--namespace", "ega"], env).status, 0);
  const home = join(base, "home");
  const before = await snapshotTree(home);
  const output = join(base, "plan.json");
  const result = runCli(planArgs(source, output), env);
  assert.equal(result.status, 0);
  assert.equal((await readPlan(output)).payload.target.mode, "REGISTRY");
  assert.deepEqual(await snapshotTree(home), before);
  assert.equal(await pathExists(join(home, "registry.sqlite-wal")), false);
  assert.equal(await pathExists(join(home, "registry.sqlite-journal")), false);
});

test("IP-03: absolute source roots do not enter the semantic plan identity", async (t) => {
  const base = await isolatedBase(t);
  const first = await writeSkill(join(base, "one"), "same", { aliases: ["shared"] });
  const second = await writeSkill(join(base, "two"), "same", { aliases: ["shared"] });
  const firstPlanPath = join(base, "first.json");
  const secondPlanPath = join(base, "second.json");
  assert.equal(runCli(planArgs(first, firstPlanPath), envFor(join(base, "home-a"))).status, 0);
  assert.equal(runCli(planArgs(second, secondPlanPath), envFor(join(base, "home-b"))).status, 0);
  const firstPlan = await readPlan(firstPlanPath);
  const secondPlan = await readPlan(secondPlanPath);
  assert.equal(firstPlan.digest, secondPlan.digest);
  assert.deepEqual(firstPlan.payload, secondPlan.payload);
});

test("IP-04: a historical identity is previewed as REACTIVATE", async (t) => {
  const base = await isolatedBase(t);
  const source = await writeSkill(join(base, "source"), "evolving", { body: "A\n" });
  const env = envFor(base);
  assert.equal(runCli(["import", source, "--namespace", "ega"], env).status, 0);
  await writeFile(join(source, "SKILL.md"), "---\nname: evolving\ndescription: evolving skill\n---\nB\n");
  assert.equal(runCli(["import", source, "--namespace", "ega"], env).status, 0);
  await writeFile(join(source, "SKILL.md"), "---\nname: evolving\ndescription: evolving skill\n---\nA\n");
  const output = join(base, "plan.json");
  assert.equal(runCli(planArgs(source, output), env).status, 0);
  assert.equal((await readPlan(output)).payload.candidates[0].change, "REACTIVATE");
});

test("IP-05: raw newline drift is visible while canonical version identity remains equal", async (t) => {
  const base = await isolatedBase(t);
  const source = await writeSkill(join(base, "source"), "newlines", { body: "line one\nline two\n" });
  const env = envFor(base);
  const firstPath = join(base, "first.json");
  const secondPath = join(base, "second.json");
  assert.equal(runCli(planArgs(source, firstPath), env).status, 0);
  const first = await readPlan(firstPath);
  await writeFile(join(source, "SKILL.md"), "---\r\nname: newlines\r\ndescription: newlines skill\r\n---\r\nline one\r\nline two\r\n");
  assert.equal(runCli(planArgs(source, secondPath), env).status, 0);
  const second = await readPlan(secondPath);
  assert.notEqual(first.payload.source.snapshot_digest, second.payload.source.snapshot_digest);
  assert.equal(first.payload.candidates[0].version_hash, second.payload.candidates[0].version_hash);
});

test("IP-06: oversized authored L1 is a warning and L2 remains measurable", async (t) => {
  const base = await isolatedBase(t);
  const source = await writeSkill(join(base, "source"), "large-core", { core: "core guidance ".repeat(6000) });
  const output = join(base, "plan.json");
  const result = runCli(planArgs(source, output), envFor(base));
  assert.equal(result.status, 0);
  const candidate = (await readPlan(output)).payload.candidates[0];
  assert.equal(candidate.l1_status, "MISSING");
  assert.equal(candidate.l1_tokens, null);
  assert.ok(candidate.l2_tokens > 0);
  assert.equal(candidate.diagnostics[0].code, "W_L1_DOWNGRADED");
});

test("IP-07/IP-08: invalid siblings and alias conflicts are independently reported", async (t) => {
  const base = await isolatedBase(t);
  const source = join(base, "source");
  await writeSkill(source, "good", { aliases: ["shared"] });
  await writeSkill(source, "other", { aliases: ["shared"] });
  const invalid = join(source, "invalid");
  await mkdir(invalid, { recursive: true });
  await writeFile(join(invalid, "SKILL.md"), "---\nnot_name: true\n---\ninvalid\n");
  const output = join(base, "plan.json");
  const result = runCli(planArgs(source, output), envFor(base));
  assert.equal(result.status, 1);
  const plan = await readPlan(output);
  assert.equal(plan.payload.summary.valid_count, 2);
  assert.equal(plan.payload.summary.invalid_count, 1);
  assert.equal(plan.payload.summary.blocked_count, 3);
  const valid = plan.payload.candidates.filter((candidate) => candidate.validation === "VALID");
  assert.ok(valid.every((candidate) => candidate.diagnostics.some((diagnostic) => diagnostic.code === "E_ALIAS_CONFLICT")));
  const bad = plan.payload.candidates.find((candidate) => candidate.relative_root === "invalid");
  assert.equal(bad.version_hash, null);
  assert.equal(bad.diagnostics[0].code, "E_SKILL_FRONTMATTER_INVALID");
});

test("IP-09: discovery depth is explicit and blocks an unselected deep skill", async (t) => {
  const base = await isolatedBase(t);
  const source = join(base, "source");
  await writeSkill(join(source, "a", "b", "c", "d", "e"), "too-deep");
  const output = join(base, "plan.json");
  const result = runCli(planArgs(source, output), envFor(base));
  assert.equal(result.status, 1);
  const plan = await readPlan(output);
  assert.deepEqual(plan.payload.selected_roots, []);
  assert.equal(plan.payload.candidates.length, 0);
  assert.ok(plan.payload.discovery_diagnostics.some((diagnostic) => diagnostic.code === "W_DISCOVERY_DEPTH_LIMIT"));
  assert.ok(plan.payload.discovery_diagnostics.some((diagnostic) => diagnostic.code === "E_DISCOVERY_NO_ROOTS"));
  assert.equal(plan.payload.summary.blocked_count, 1);
  assert.equal(plan.payload.summary.warning_count, 1);
});
