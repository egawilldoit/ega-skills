// EGA-616: `ega-skills lock` — init → lock → resolve without hand-editing.
// Exercises the BUILT CLI end to end (offline, isolated home):
//   - lock without init fails closed with a clear pointer;
//   - init → lock writes a deterministic, validating `.egaskills.lock`;
//   - second plain lock refuses (points at --refresh);
//   - init → import → lock → resolve works (LOCKED acceptance);
//   - lock --refresh picks up newly imported skills with a +/-/~ diff;
//   - refresh with no changes is a byte-identical no-op.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  hashNormalizedConfig,
  parseProjectConfig,
} from "../../packages/project/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntrypoint = join(root, "packages", "cli", "bin", "ega-skills.mjs");

async function isolatedBase(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-616-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

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

function runCli(args, cwd, env) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

async function writeSkill(src, name, description) {
  const dir = join(src, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nGuidance for ${name}.\n`,
  );
  await writeFile(
    join(dir, "ega.yaml"),
    "schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n",
  );
}

function lockPath(project) {
  return join(project, ".egaskills.lock");
}

async function setupProject(t, skills) {
  const base = await isolatedBase(t);
  const project = join(base, "project");
  const src = join(base, "src");
  await mkdir(project, { recursive: true });
  await mkdir(src, { recursive: true });
  const env = offlineEnv(base);
  assert.equal(runCli(["init"], project, env).status, 0);
  for (const [name, description] of skills) {
    await writeSkill(src, name, description);
  }
  if (skills.length > 0) {
    const imported = runCli(["import", src, "--namespace", "ega"], project, env);
    assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  }
  return { base, project, src, env };
}

test("CLI lock: refuses without a project config (points at init)", async (t) => {
  const base = await isolatedBase(t);
  const project = join(base, "project");
  await mkdir(project, { recursive: true });
  const result = runCli(["lock"], project, offlineEnv(base));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /init/i);
});

test("CLI lock: init then lock writes a validating deterministic lock", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  const result = runCli(["lock"], project, env);
  assert.equal(result.status, 0, `lock failed: ${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.diff, { added: ["ega/alpha"], removed: [], changed: [] });
  const text = await readFile(lockPath(project), "utf8");
  const configText = await readFile(join(project, ".egaskills.yaml"), "utf8");
  const configHash = hashNormalizedConfig(parseProjectConfig(configText));
  // Structural freeze: exact header, pinned config hash, sorted entries.
  assert.ok(text.includes(`config_hash: ${configHash}`));
  assert.ok(text.includes("lockfile_version: 1"));
  assert.ok(text.includes("token_estimator: ega-o200k-v1"));
  const entryLine = text.split("\n").find((line) => line.startsWith("  ega/alpha:"));
  assert.ok(entryLine !== undefined, "lock must pin ega/alpha");
  assert.match(text, /version_hash: sha256:[0-9a-f]{64}/);
  // Validity proof: the resolver enforces the lock (E_LOCK_* on any drift).
  const resolved = runCli(["resolve", "--project", project, "--task", "build thing"], project, env);
  assert.equal(resolved.status, 0, `locked resolve failed: ${resolved.stderr}`);
});

test("CLI lock: second plain lock refuses and points at --refresh", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  assert.equal(runCli(["lock"], project, env).status, 0);
  const again = runCli(["lock"], project, env);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /--refresh/);
});

test("CLI lock: init, import, lock, then resolve works LOCKED", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  assert.equal(runCli(["lock"], project, env).status, 0);
  const resolved = runCli(["resolve", "--project", project, "--task", "build thing"], project, env);
  assert.equal(resolved.status, 0, `resolve failed: ${resolved.stderr}`);
  const body = JSON.parse(resolved.stdout);
  assert.ok(
    [...(body.selected ?? []), ...(body.candidates ?? [])].some((s) =>
      JSON.stringify(s).includes("ega/alpha"),
    ),
    "locked resolve must surface ega/alpha",
  );
});

test("CLI lock --refresh: picks up newly imported skills with an added diff", async (t) => {
  const { project, src, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  assert.equal(runCli(["lock"], project, env).status, 0);
  await writeSkill(src, "beta", "beta skill");
  const imported = runCli(["import", src, "--namespace", "ega"], project, env);
  assert.equal(imported.status, 0, `re-import failed: ${imported.stderr}`);
  const refreshed = runCli(["lock", "--refresh"], project, env);
  assert.equal(refreshed.status, 0, `refresh failed: ${refreshed.stderr}`);
  assert.deepEqual(JSON.parse(refreshed.stdout).diff, {
    added: ["ega/beta"],
    removed: [],
    changed: [],
  });
  const resolved = runCli(["resolve", "--project", project, "--task", "build thing"], project, env);
  assert.equal(resolved.status, 0);
  assert.ok(
    JSON.stringify(JSON.parse(resolved.stdout)).includes("ega/beta"),
    "post-refresh resolve must surface ega/beta",
  );
});

test("CLI lock --refresh: no changes is a byte-identical no-op with empty diff", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  assert.equal(runCli(["lock"], project, env).status, 0);
  const before = await readFile(lockPath(project), "utf8");
  const refreshed = runCli(["lock", "--refresh"], project, env);
  assert.equal(refreshed.status, 0, `refresh failed: ${refreshed.stderr}`);
  assert.deepEqual(JSON.parse(refreshed.stdout).diff, { added: [], removed: [], changed: [] });
  assert.equal(await readFile(lockPath(project), "utf8"), before);
});

test("CLI lock --refresh: reports created false even with no previous lock", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  const refreshed = runCli(["lock", "--refresh"], project, env);
  assert.equal(refreshed.status, 0, `refresh failed: ${refreshed.stderr}`);
  const summary = JSON.parse(refreshed.stdout);
  assert.equal(summary.created, false);
  assert.deepEqual(summary.diff, { added: ["ega/alpha"], removed: [], changed: [] });
});

test("CLI lock: symlinked lock paths are refused, never followed", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  const { symlink, unlink } = await import("node:fs/promises");
  const target = join(project, "elsewhere.lock");
  await writeFile(target, "stale: true\n");
  try {
    await symlink(target, lockPath(project));
  } catch {
    t.skip("symlink creation needs privileges on this platform");
    return;
  }
  t.after(() => unlink(lockPath(project)).catch(() => {}));
  for (const args of [["lock"], ["lock", "--refresh"]]) {
    const result = runCli(args, project, env);
    assert.notEqual(result.status, 0, `${args.join(" ")} must refuse a symlinked lock`);
    assert.match(result.stderr, /symlink/i);
  }
  assert.equal(await readFile(target, "utf8"), "stale: true\n");
});

test("CLI lock: a planted temp-path symlink cannot redirect the write", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  const { symlink, unlink } = await import("node:fs/promises");
  const target = join(project, "decoy.txt");
  await writeFile(target, "decoy\n");
  const tempLink = `${lockPath(project)}.tmp`;
  try {
    await symlink(target, tempLink);
  } catch {
    t.skip("symlink creation needs privileges on this platform");
    return;
  }
  t.after(() => unlink(tempLink).catch(() => {}));
  const result = runCli(["lock"], project, env);
  assert.equal(result.status, 0, `lock failed: ${result.stderr}`);
  // The planted link was never followed: decoy intact, real lock written.
  assert.equal(await readFile(target, "utf8"), "decoy\n");
  assert.ok((await readFile(lockPath(project), "utf8")).includes("ega/alpha"));
});

test("CLI lock: temp-name collisions retry cleanly and leak no stray files", async (t) => {
  const { project, env } = await setupProject(t, [["alpha", "alpha skill"]]);
  const { mkdir, readdir, rm } = await import("node:fs/promises");
  // Occupy the deterministic first candidate with a directory: exclusive
  // creation collides (EEXIST), the write retries elsewhere and succeeds.
  const blocker = `${lockPath(project)}.tmp`;
  await mkdir(blocker);
  t.after(() => rm(blocker, { recursive: true, force: true }));
  const result = runCli(["lock"], project, env);
  assert.equal(result.status, 0, `lock failed: ${result.stderr}`);
  assert.ok((await readFile(lockPath(project), "utf8")).includes("ega/alpha"));
  const leftovers = (await readdir(project)).filter(
    (name) => name.startsWith(".egaskills.lock.tmp-"),
  );
  assert.deepEqual(leftovers, [], "no retried temp files may leak");
});
