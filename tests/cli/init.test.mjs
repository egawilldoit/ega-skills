// SPEC-005 §5.1.5 rule 3 `ega-skills init` (EGA-583).
//
// init must write a deterministic, human-readable `.egaskills.yaml`: schema
// version 1, the routing defaults (suggest / 3 / 5000), four empty policy
// lists, and locking.required: true (a committed project attests LOCKED
// mode). The document is byte-frozen — no timestamps — so an overwritten
// file is byte-identical. Existing configs are refused without --force.
// init touches NO registry state: it runs with an isolated EGA_SKILLS_HOME
// and scrubbed proxies and never creates the home directory.
//
// Tests exercise the BUILT CLI (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseProjectConfig } from "../../packages/project/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntrypoint = join(root, "packages", "cli", "bin", "ega-skills.mjs");

const expectedYaml = `schema_version: 1
routing:
  mode: suggest
  max_skills: 3
  max_tokens: 5000
namespaces:
  allow: []
  deny: []
skills:
  prefer: []
  deny: []
locking:
  required: true
`;

const expectedNormalized = {
  schema_version: 1,
  routing: { mode: "suggest", max_skills: 3, max_tokens: 5000 },
  namespaces: { allow: [], deny: [] },
  skills: { prefer: [], deny: [] },
  locking: { required: true },
};

async function isolatedDir(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-583-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function runInit(args, cwd, env) {
  return spawnSync(process.execPath, [cliEntrypoint, "init", ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

// Offline, isolated home: no network (proxies scrubbed), no ambient
// EGA_SKILLS_HOME, and init must never create that home directory.
function offlineEnv(base) {
  return {
    ...process.env,
    EGA_SKILLS_HOME: join(base, "home"),
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
  };
}

test("CLI init: writes the frozen locked-mode config (required true) offline", async (t) => {
  const base = await isolatedDir(t);
  const project = join(base, "project");
  await mkdir(project);
  const file = join(project, ".egaskills.yaml");

  const result = runInit([], project, offlineEnv(base));
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { path: file, written: true });

  const text = await readFile(file, "utf8");
  assert.equal(text, expectedYaml);
  // Independent structural check via the project parser: required stays true.
  assert.deepEqual(parseProjectConfig(text), expectedNormalized);
  // No registry/home side effects and no network involvement.
  assert.equal(await pathExists(join(base, "home")), false);
});

test("CLI init: rewrite with --force is byte-identical (deterministic output)", async (t) => {
  const base = await isolatedDir(t);
  const project = join(base, "project");
  await mkdir(project);
  const env = offlineEnv(base);

  const first = runInit([], project, env);
  assert.equal(first.status, 0);
  const firstBytes = await readFile(join(project, ".egaskills.yaml"));

  const second = runInit(["--force"], project, env);
  assert.equal(second.status, 0);
  assert.equal(second.stderr, "");
  assert.equal(second.stdout, first.stdout); // same absolute path reported
  assert.deepEqual(await readFile(join(project, ".egaskills.yaml")), firstBytes);
});

test("CLI init: refuses to overwrite an existing config without --force", async (t) => {
  const base = await isolatedDir(t);
  const project = join(base, "project");
  await mkdir(project);
  const file = join(project, ".egaskills.yaml");
  const env = offlineEnv(base);

  assert.equal(runInit([], project, env).status, 0);
  const before = await readFile(file);

  const refused = runInit([], project, env);
  assert.equal(refused.status, 1);
  assert.equal(refused.signal, null);
  assert.equal(refused.stdout, "");
  assert.ok(refused.stderr.includes("Refusing to overwrite"));
  assert.ok(refused.stderr.includes("--force"));
  assert.ok(refused.stderr.includes('Run "ega-skills --help" for usage.'));
  // Failed attempt mutates nothing.
  assert.deepEqual(await readFile(file), before);
});

test("CLI init: explicit project dir, missing dir and unknown options fail deterministically", async (t) => {
  const base = await isolatedDir(t);
  const project = join(base, "project");
  await mkdir(project);
  const sub = join(project, "sub");
  await mkdir(sub);

  // Positional project dir wins over cwd.
  const explicit = runInit(["sub"], project, offlineEnv(base));
  assert.equal(explicit.status, 0);
  assert.equal(JSON.parse(explicit.stdout).path, join(sub, ".egaskills.yaml"));
  assert.equal(await readFile(join(sub, ".egaskills.yaml"), "utf8"), expectedYaml);

  const missing = runInit([join(base, "nope")], project, offlineEnv(base));
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("does not exist"));

  const unknownFlag = runInit(["--bogus"], project, offlineEnv(base));
  assert.equal(unknownFlag.status, 1);
  assert.equal(unknownFlag.stdout, "");
  assert.ok(unknownFlag.stderr.includes("Unknown command or option: --bogus"));

  const extraArg = runInit(["sub", "extra"], project, offlineEnv(base));
  assert.equal(extraArg.status, 1);
  assert.ok(extraArg.stderr.includes("Unknown command or option: extra"));
});