import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntrypoint = join(root, "packages", "cli", "bin", "ega-skills.mjs");

const FROZEN_TOP_FIELDS = [
  "resolutionId",
  "routerContractVersion",
  "routerImplementationVersion",
  "mode",
  "confidence",
  "projectFingerprint",
  "explicit",
  "selected",
  "candidates",
  "rejected",
  "automaticSelectedTokens",
  "explicitSelectedTokens",
  "maxTokens",
  "maxSkills",
  "lockStatus",
  "budgetStatus",
];

async function isolatedHome(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-579-cli-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

function cliEnv(base) {
  return { ...process.env, EGA_SKILLS_HOME: join(base, "home") };
}

async function writeSkill(dir, name, options = {}) {
  const skillRoot = join(dir, name);
  await mkdir(skillRoot, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name}.\n`;
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options.description ?? `${name} skill`}\n---\n${body}`,
  );
  if (options.egaYaml !== undefined) {
    await writeFile(join(skillRoot, "ega.yaml"), options.egaYaml);
  }
  return skillRoot;
}

async function importFixture(base, env) {
  const src = join(base, "src");
  await writeSkill(src, "react-helper", {
    egaYaml: "schema_version: 1\nframeworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n",
  });
  const proj = join(base, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "package.json"), JSON.stringify({ dependencies: { react: "1" } }));
  const imported = runCli(["import", join(src, "react-helper"), "--namespace", "ega"], env);
  assert.equal(imported.status, 0);
  return proj;
}

// resolve: REQUIRED Wave-4 surface (SPEC-004 §5.3).

test("CLI resolve: full command works offline with frozen fields", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  const proj = await importFixture(base, env);
  const result = runCli(["resolve", "--project", proj, "--task", "please build widget with react"], env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const resolved = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(resolved).sort(), [...FROZEN_TOP_FIELDS].sort());
  assert.equal(resolved.mode, "suggest");
  assert.equal(resolved.routerContractVersion, 1);
  assert.ok(resolved.selected.some((skill) => skill.id === "ega/react-helper"));
  assert.ok(!JSON.stringify(resolved).includes("Guidance text"));
});

test("CLI resolve: missing task and bad budgets fail usage", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  const proj = await importFixture(base, env);
  const missing = runCli(["resolve", "--project", proj], env);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.ok(missing.stderr.includes("--task"));
  const badSkills = runCli(["resolve", "--project", proj, "--task", "x", "--max-skills", "9"], env);
  assert.equal(badSkills.status, 1);
  const badTokens = runCli(["resolve", "--project", proj, "--task", "x", "--max-tokens", "0"], env);
  assert.equal(badTokens.status, 1);
});

test("CLI resolve: explicit flag populates the explicit array", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  const proj = await importFixture(base, env);
  const result = runCli(
    ["resolve", "--project", proj, "--task", "build widget", "--explicit", "ega/react-helper"],
    env,
  );
  assert.equal(result.status, 0);
  const resolved = JSON.parse(result.stdout);
  assert.deepEqual(resolved.explicit.map((skill) => skill.id), ["ega/react-helper"]);
  assert.ok(!resolved.selected.some((skill) => skill.id === "ega/react-helper"));
});

test("CLI resolve: no-match is a normal LOW result with exit 0", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  const proj = await importFixture(base, env);
  const result = runCli(["resolve", "--project", proj, "--task", "xylophone quantum zebras"], env);
  assert.equal(result.status, 0);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.confidence, "LOW");
  assert.deepEqual(resolved.selected, []);
  assert.equal(resolved.automaticSelectedTokens, 0);
});

// resolve: the CLI passes --project through with NO policy, so the router
// derives the effective config/lock from the REAL project tree (EGA-587):
// a skills.deny entry in the target project's .egaskills.yaml must filter
// the automatic pool end-to-end, with the deny landing in `rejected`.

test("CLI resolve: deny config in the target project filters automatic results", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  const proj = await importFixture(base, env);
  await writeFile(
    join(proj, ".egaskills.yaml"),
    "schema_version: 1\nskills:\n  deny:\n    - ega/react-helper\n",
  );
  const result = runCli(["resolve", "--project", proj, "--task", "please build widget with react"], env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const resolved = JSON.parse(result.stdout);
  assert.ok(!resolved.selected.some((skill) => skill.id === "ega/react-helper"));
  assert.ok(!resolved.candidates.some((skill) => skill.id === "ega/react-helper"));
  const denied = resolved.rejected.find((skill) => skill.id === "ega/react-helper");
  assert.ok(denied !== undefined);
  assert.deepEqual(denied.reasons, ["SKILL_DENIED"]);
});
