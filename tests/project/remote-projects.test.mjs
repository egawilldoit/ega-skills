import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRemoteLockPlan,
  createProjectContext,
  createRemoteLockPlan,
  digestProjectLock,
  hashNormalizedConfig,
  parseProjectConfig,
  validateLockfile,
  verifyProjectContext,
} from "../../packages/project/dist/index.js";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import { runRemoteLockApply } from "../../packages/cli/dist/index.js";

const projectRequire = createRequire(new URL("../../packages/project/package.json", import.meta.url));
const parseYaml = projectRequire("yaml").parse;
const projectPackageJson = fileURLToPath(new URL("../../packages/project/package.json", import.meta.url));
const projectDist = fileURLToPath(new URL("../../packages/project/dist/index.js", import.meta.url));

const digest = (hex) => `sha256:${hex.repeat(64 / hex.length)}`;
const lock = (skill, version, configHash = digest("a")) => ({
  lockfile_version: 1,
  token_estimator: "ega-o200k-v1",
  generated_from: { config_hash: configHash },
  skills: { [skill]: { name: skill.split("/")[1], version_hash: digest(version) } },
});

function planFor({ current, candidate, configDigest = digest("a") }) {
  return createRemoteLockPlan({
    projectConfigDigest: configDigest,
    existingLockDigest: digestProjectLock(current),
    targetReleaseDigest: digest("c"),
    current,
    candidate,
  });
}

async function waitForFile(path, what) {
  // Harness readiness wait only: the applies themselves are ordered by the
  // single-shot start barrier, never by this poll.
  const deadline = Date.now() + 120_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ProjectContext binds one immutable release and verifies its envelope", () => {
  const context = createProjectContext({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config_digest: digest("a"),
    lock_digest: digest("b"),
    release_digest: digest("c"),
    fingerprint_digest: null,
    context_contract: "E1",
  });
  assert.equal(verifyProjectContext(context).payload.release_digest, digest("c"));
  const forged = structuredClone(context);
  forged.payload.release_digest = digest("d");
  assert.throws(() => verifyProjectContext(forged));
  const extra = structuredClone(context);
  extra.payload.extra = "forbidden";
  extra.digest = createEnvelope({ object_type: extra.object_type, schema_version: extra.schema_version, payload: extra.payload }).digest;
  assert.throws(() => verifyProjectContext(extra));
});

test("remote lock plan is exact-release bound and applies only the reviewed candidate", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  assert.equal(plan.payload.target_release_digest, digest("c"));
  assert.deepEqual(plan.payload.changes, [{ skill_ref: "ega/alpha", old_version: digest("a"), new_version: digest("b") }]);
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") });
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")));
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith(".egaskills.lock")),
    [".egaskills.lock"],
    "no temp or guard artifacts may remain after a normal apply",
  );
});

test("remote lock apply rejects a stale existing lock and preserves it", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-stale-"));
  const path = join(dir, ".egaskills.lock");
  const newer = lock("ega/alpha", "d");
  writeFileSync(path, `${JSON.stringify(newer, null, 2)}\n`);
  const before = readFileSync(path);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: newer, projectConfigDigest: digest("a") }),
    /existing lock does not match/,
  );
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(dir), [".egaskills.lock"], "no temp files may remain");
});

test("remote lock apply rejects a plan for a different project config", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const path = join(mkdtempSync(join(tmpdir(), "ega-remote-lock-config-")), ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  const before = readFileSync(path);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("f") }),
    /project config does not match/,
  );
  assert.deepEqual(readFileSync(path), before);
});

test("remote lock apply rejects a transition that is not completely described", () => {
  const current = lock("ega/alpha", "a");
  current.skills["ega/beta"] = { name: "beta", version_hash: digest("e") };
  const candidate = lock("ega/alpha", "b");
  candidate.skills["ega/beta"] = { name: "beta", version_hash: digest("f") };
  const plan = createRemoteLockPlan({
    projectConfigDigest: digest("a"),
    existingLockDigest: digestProjectLock(current),
    targetReleaseDigest: digest("c"),
    current,
    candidate,
  });
  assert.equal(plan.payload.changes.length, 2);

  const subset = structuredClone(plan);
  subset.payload.changes = subset.payload.changes.filter((change) => change.skill_ref === "ega/alpha");
  subset.digest = createEnvelope({ object_type: subset.object_type, schema_version: subset.schema_version, payload: subset.payload }).digest;
  const path = join(mkdtempSync(join(tmpdir(), "ega-remote-lock-subset-")), ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  assert.throws(
    () => applyRemoteLockPlan(subset, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /completely describe/,
  );
});

test("remote lock apply refuses to apply when the lock is missing on disk", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-missing-"));
  const path = join(dir, ".egaskills.lock");

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /missing on disk/,
    "the caller-provided lock object must never substitute for the real file",
  );
  assert.deepEqual(readdirSync(dir), [], "a failed apply must not create a lock");
});

test("two competing applies from the same starting lock cannot both commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-race-"));
  const lockPath = join(dir, ".egaskills.lock");
  const configDigest = digest("a");
  const base = lock("ega/alpha", "a", configDigest);
  writeFileSync(lockPath, `${JSON.stringify(base, null, 2)}\n`);
  const planB = planFor({ current: base, candidate: lock("ega/alpha", "b", configDigest), configDigest });
  const planC = planFor({ current: base, candidate: lock("ega/alpha", "c", configDigest), configDigest });
  const planBPath = join(dir, "plan-b.json");
  const planCPath = join(dir, "plan-c.json");
  writeFileSync(planBPath, JSON.stringify(planB));
  writeFileSync(planCPath, JSON.stringify(planC));

  const readyB = join(dir, "ready-b");
  const readyC = join(dir, "ready-c");
  const resultB = join(dir, "result-b");
  const resultC = join(dir, "result-c");
  const startPath = join(dir, "start");

  const childScript = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
try {
  const require = createRequire(process.env.EGA_RACE_PROJECT_PKG);
  const { applyRemoteLockPlan, validateLockfile } = require(process.env.EGA_RACE_DIST);
  const parseYaml = require("yaml").parse;
  const lockPath = process.env.EGA_RACE_LOCK;
  const configDigest = process.env.EGA_RACE_CONFIG_DIGEST;
  const plan = JSON.parse(readFileSync(process.env.EGA_RACE_PLAN, "utf8"));
  // Both contenders observe the same starting disk state BEFORE the barrier,
  // exactly like two processes that each read A before either commits.
  const hint = validateLockfile(parseYaml(readFileSync(lockPath, "utf8")), configDigest);
  writeFileSync(process.env.EGA_RACE_READY, "1");
  const start = process.env.EGA_RACE_START;
  const barrierDeadline = Date.now() + 60_000;
  let opened = false;
  while (!opened && Date.now() < barrierDeadline) opened = existsSync(start);
  if (!opened) {
    writeFileSync(process.env.EGA_RACE_RESULT, "error:start barrier never opened");
    process.exit(0);
  }
  try {
    applyRemoteLockPlan(plan, lockPath, { currentLock: hint, projectConfigDigest: configDigest });
    writeFileSync(process.env.EGA_RACE_RESULT, "ok");
  } catch (error) {
    writeFileSync(process.env.EGA_RACE_RESULT, "error:" + String(error?.message ?? error));
  }
} catch (error) {
  // Startup failures must be diagnosable: report them through the result file.
  try {
    writeFileSync(process.env.EGA_RACE_RESULT, "error:startup:" + String(error?.message ?? error).slice(0, 400));
  } catch { /* nothing else to do */ }
}
process.exit(0);
`;
  const scriptPath = join(dir, "contender.mjs");
  writeFileSync(scriptPath, childScript);

  const childEnv = (planPath, ready, result) => ({
    ...process.env,
    EGA_RACE_PROJECT_PKG: projectPackageJson,
    EGA_RACE_DIST: projectDist,
    EGA_RACE_LOCK: lockPath,
    EGA_RACE_PLAN: planPath,
    EGA_RACE_CONFIG_DIGEST: configDigest,
    EGA_RACE_READY: ready,
    EGA_RACE_RESULT: result,
    EGA_RACE_START: startPath,
  });
  const childB = spawn(process.execPath, [scriptPath], { env: childEnv(planBPath, readyB, resultB), stdio: ["ignore", "ignore", "pipe"] });
  const childC = spawn(process.execPath, [scriptPath], { env: childEnv(planCPath, readyC, resultC), stdio: ["ignore", "ignore", "pipe"] });
  let childStderr = "";
  childB.stderr.on("data", (chunk) => { childStderr += chunk; });
  childC.stderr.on("data", (chunk) => { childStderr += chunk; });
  // Attached at spawn time: contenders exit quickly and the exit event fires once.
  const exitOf = (child) => new Promise((resolve) => child.once("exit", (code, signal) => resolve(`code=${String(code)} signal=${String(signal)}`)));
  const exitBPromise = exitOf(childB);
  const exitCPromise = exitOf(childC);

  // A contender that fails during startup reports through its result file
  // instead of its ready file; surface that instead of timing out.
  const waitForReadyOrResult = async (readyPath, resultPath, what) => {
    const deadline = Date.now() + 120_000;
    while (!existsSync(readyPath) && !existsSync(resultPath)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${readyPath}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!existsSync(readyPath)) {
      throw new Error(`${what} failed before readiness: ${readFileSync(resultPath, "utf8")}`);
    }
  };
  await waitForReadyOrResult(readyB, resultB, "contender B");
  await waitForReadyOrResult(readyC, resultC, "contender C");
  // Single-shot barrier: both contenders are live and blocking on this file.
  writeFileSync(startPath, "go");
  await waitForFile(resultB, "contender B result");
  await waitForFile(resultC, "contender C result");
  const [exitB, exitC] = await Promise.all([exitBPromise, exitCPromise]);

  const resultTextB = readFileSync(resultB, "utf8");
  const resultTextC = readFileSync(resultC, "utf8");
  const outcomes = [resultTextB, resultTextC];
  const successes = outcomes.filter((outcome) => outcome === "ok").length;
  assert.equal(
    successes,
    1,
    `exactly one competing apply may commit; got ${JSON.stringify(outcomes)} exits B=${exitB} C=${exitC} stderr=${childStderr}`,
  );

  const onDisk = validateLockfile(parseYaml(readFileSync(lockPath, "utf8")), configDigest);
  assert.ok(
    [digest("b"), digest("c")].includes(onDisk.skills["ega/alpha"].version_hash),
    `final disk state must be exactly B or C, got ${JSON.stringify(onDisk.skills)}`,
  );
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith(".egaskills.lock")).sort(),
    [".egaskills.lock"],
    "no temp or guard artifacts may remain",
  );

  const loserPlan = resultTextB === "ok" ? planC : planB;
  assert.throws(
    () => applyRemoteLockPlan(loserPlan, lockPath, { currentLock: base, projectConfigDigest: configDigest }),
    /existing lock does not match/,
    "retrying the losing original plan must converge to a stale rejection",
  );
});

test("a live mutation guard is never stolen by a concurrent apply", () => {
  const current = lock("ega/alpha", "a");
  const candidateB = lock("ega/alpha", "b");
  const candidateC = lock("ega/alpha", "c");
  const planB = planFor({ current, candidate: candidateB });
  const planC = planFor({ current, candidate: candidateC });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-guard-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);

  let innerError;
  applyRemoteLockPlan(planB, path, { currentLock: current, projectConfigDigest: digest("a") }, {
    beforeCommit: () => {
      try {
        applyRemoteLockPlan(planC, path, { currentLock: current, projectConfigDigest: digest("a") });
        innerError = new Error("inner apply unexpectedly succeeded while the guard was held");
      } catch (error) {
        innerError = error;
      }
    },
  });
  assert.match(String(innerError?.message ?? ""), /contended/, "a held guard must fail contention, never be stolen");
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")), "the outer apply must still commit");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith(".egaskills.lock")).sort(),
    [".egaskills.lock"],
  );
});

test("a stale mutation guard left by a dead process is reclaimed deterministically", async () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-stale-guard-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);

  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.once("exit", resolve));
  mkdirSync(`${path}.guard`, { recursive: true });
  writeFileSync(join(`${path}.guard`, `owner.${"d".repeat(64)}`), JSON.stringify({ pid: dead.pid, token: "d".repeat(64) }));

  applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") });
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")));
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith(".egaskills.lock")).sort(),
    [".egaskills.lock"],
    "the reclaimed guard must be cleaned up with the winning apply",
  );
});

test("a zero-progress write fails closed and preserves the prior lock", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-zerowrite-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  const before = readFileSync(path);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") }, {
      write: () => 0,
    }),
    /no progress/,
    "a writer that makes no progress must fail instead of publishing an incomplete lock",
  );
  assert.deepEqual(readFileSync(path), before, "the prior lock must remain byte-identical");
  assert.deepEqual(readdirSync(dir), [".egaskills.lock"], "the temp file must be cleaned up");
});

test("partial writes are driven to completion before fsync and rename", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-partial-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);

  let calls = 0;
  applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") }, {
    write: (fd, bytes, offset) => {
      calls += 1;
      const chunk = Math.min(9, bytes.length - offset);
      projectRequire("node:fs").writeSync(fd, bytes, offset, chunk);
      return chunk;
    },
  });
  assert.ok(calls >= 2, `the writer must loop over partial writes; got ${calls} call(s)`);
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")), "every byte must reach the committed lock");
});

test("a write failure before rename preserves the old lock and leaves no candidate", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-writefail-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  const before = readFileSync(path);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") }, {
      write: () => {
        throw Object.assign(new Error("injected write EIO"), { code: "EIO" });
      },
    }),
    /injected write EIO/,
  );
  assert.deepEqual(readFileSync(path), before, "the prior lock must remain byte-identical");
  assert.deepEqual(readdirSync(dir), [".egaskills.lock"], "no temp candidate may remain");
});

test("remote lock apply locates the discovered project boundary from a nested directory", () => {
  const base = mkdtempSync(join(tmpdir(), "ega-remote-lock-boundary-"));
  const project = join(base, "project");
  const nested = join(project, "packages", "app");
  mkdirSync(nested, { recursive: true });
  const configText = "schema_version: 1\n";
  writeFileSync(join(project, ".egaskills.yaml"), configText);
  const configDigest = hashNormalizedConfig(parseProjectConfig(configText));
  const current = lock("ega/alpha", "a", configDigest);
  const candidate = lock("ega/alpha", "b", configDigest);
  writeFileSync(join(project, ".egaskills.lock"), `${JSON.stringify(current, null, 2)}\n`);
  const plan = planFor({ current, candidate, configDigest });
  const planPath = join(base, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const result = runRemoteLockApply({ plan: planPath, project: nested });
  assert.equal(result.path, join(project, ".egaskills.lock"));
  assert.match(readFileSync(join(project, ".egaskills.lock"), "utf8"), new RegExp(digest("b")));
  assert.deepEqual(readdirSync(nested), [], "nested invocation must not write a lock");
});

test("a post-rename durability failure is reported as an explicit post-commit state", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-durability-"));
  const path = join(dir, ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") }, {
      syncDirectory: () => {
        throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      },
    }),
    /committed the candidate lock but directory durability sync failed/,
    "a durability failure after the rename must be reported as post-commit, not as a preserved old lock",
  );
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")), "the committed candidate must be complete on disk");
  assert.deepEqual(readdirSync(dir), [".egaskills.lock"], "no temp artifacts may remain");

  const onDisk = validateLockfile(parseYaml(readFileSync(path, "utf8")), digest("a"));
  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: onDisk, projectConfigDigest: digest("a") }),
    /existing lock does not match/,
    "retry with the already-applied candidate must converge to a deterministic stale rejection",
  );
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")));
});

test("remote lock apply rejects forged or malformed change summaries", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const path = join(mkdtempSync(join(tmpdir(), "ega-remote-lock-invalid-")), ".egaskills.lock");
  const forged = structuredClone(plan);
  forged.payload.changes[0].new_version = digest("d");
  forged.digest = createEnvelope({ object_type: forged.object_type, schema_version: forged.schema_version, payload: forged.payload }).digest;
  assert.throws(
    () => applyRemoteLockPlan(forged, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /does not match candidate lock/,
  );

  const extra = structuredClone(plan);
  extra.payload.changes[0].unexpected = true;
  extra.digest = createEnvelope({ object_type: extra.object_type, schema_version: extra.schema_version, payload: extra.payload }).digest;
  assert.throws(
    () => applyRemoteLockPlan(extra, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /unknown or missing fields/,
  );
});
