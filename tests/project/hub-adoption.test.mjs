import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  acquireHubLock,
  applyUpdatePlan,
  checkForUpdates,
  digestStagedTree,
  extractSelectedRoots,
  parseSourcesYaml,
  readJournal,
  recoverIfNeeded,
  requireCleanJournal,
  sourceConfigDigest,
  writeJournal,
} from "../../packages/project/dist/index.js";
import { buildHub, buildHubRelease } from "../../packages/project/dist/index.js";
import { runHubUpdate } from "../../packages/cli/dist/index.js";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import { importSkills, listSkillVersions, openRegistry } from "../../packages/registry/dist/index.js";

function git(dir, ...args) {
  execFileSync("git", ["-C", dir, "-c", "user.name=plan", "-c", "user.email=plan@t", "-c", "core.autocrlf=false", ...args], { stdio: "pipe" });
}

async function waitFor(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function spawnLockContender(hubDir, resultPath, releasePath) {
  const modulePath = new URL("../../packages/project/dist/index.js", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { acquireHubLock } from ${JSON.stringify(modulePath)};
    const hubDir = process.env.EGA_TEST_HUB;
    const resultPath = process.env.EGA_TEST_RESULT;
    const releasePath = process.env.EGA_TEST_RELEASE;
    try {
      const lock = acquireHubLock(hubDir);
      writeFileSync(resultPath, "acquired");
      while (!existsSync(releasePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      lock.release();
    } catch (error) {
      writeFileSync(resultPath, "error:" + (error?.code ?? "UNKNOWN"));
      process.exitCode = 0;
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, EGA_TEST_HUB: hubDir, EGA_TEST_RESULT: resultPath, EGA_TEST_RELEASE: releasePath },
    stdio: "ignore",
  });
}

async function exitedProcessPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return pid;
}

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} skill for adoption tests.\n---\n\n${body}\n`;
}

const SOURCES_YAML = `schema_version: 1
sources:
  plan:
    type: git
    repository: PLACEHOLDER
    ref: main
    namespace: plan
    selection:
      roots:
        - skills/alpha
        - skills/beta
    provenance_files:
      - LICENSE
`;

const BETA_A = skill("beta", "Beta body A.");
const BETA_B = skill("beta", "Beta body B, changed.");

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ega-adopt-repo-"));
  git(dir, "init", "-b", "main");
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  mkdirSync(join(dir, "skills", "beta"), { recursive: true });
  writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), skill("alpha", "Alpha body A."));
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), BETA_A);
  writeFileSync(join(dir, "LICENSE"), "License A.\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "A");
  const shaA = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), BETA_B);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "B");
  const shaB = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, shaA, shaB };
}

function checkoutAt(repo, sha) {
  const dir = mkdtempSync(join(tmpdir(), "ega-adopt-co-"));
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", repo, dir], { stdio: "pipe" });
  git(dir, "checkout", "--quiet", sha);
  return dir;
}

async function versionsOf(treeDir, namespace, ids) {
  const home = mkdtempSync(join(tmpdir(), "ega-adopt-home-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home }, userHome: tmpdir() });
  try {
    const summary = await importSkills(registry, { namespace, path: treeDir });
    assert.equal(summary.failed, 0);
    const out = {};
    for (const skillId of ids) {
      const rows = listSkillVersions(registry.db, skillId);
      out[skillId] = rows[rows.length - 1].versionHash;
    }
    return out;
  } finally {
    registry.close();
  }
}

function lockTextFor(record) {
  return lockTextForSources({ plan: record });
}

function lockTextForSources(records) {
  return `schema_version: 1\nsources:\n${Object.entries(records)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, record]) => `  ${name}:\n${Object.entries(record)
      .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
      .join("\n")}`)
    .join("\n")}\n`;
}

/** Hub adopted at commit A: vendored tree + lock record with real digests. */
async function setupHubAtA(repo, shaA) {
  const coA = checkoutAt(repo, shaA);
  const cfg = parseSourcesYaml(SOURCES_YAML.replace("PLACEHOLDER", repo)).sources["plan"];
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hub-"));
  const treeDir = join(hubDir, "trees", "plan");
  mkdirSync(treeDir, { recursive: true });
  const tree = extractSelectedRoots(coA, cfg.selection.roots, cfg.provenanceFiles, treeDir);
  const record = {
    source_config_digest: sourceConfigDigest(cfg),
    repository: repo,
    requested_ref: "main",
    namespace: "plan",
    selection: { roots: [...cfg.selection.roots] },
    provenance_files: [...cfg.provenanceFiles],
    resolved_commit: shaA,
    selected_skill_tree_digest: tree.treeDigest,
    vendored_snapshot_digest: tree.snapshotDigest,
    extraction_contract: 1,
  };
  writeFileSync(join(hubDir, "sources.lock.yaml"), lockTextFor(record));
  writeFileSync(join(hubDir, "sources.yaml"), SOURCES_YAML.replace("PLACEHOLDER", repo));
  writeFileSync(
    join(hubDir, "hub.yaml"),
    "schema_version: 1\nhub:\n  id: adoption-test\nowned: []\nexternal:\n  - source: plan\n",
  );
  const versions = await versionsOf(treeDir, "plan", ["plan/alpha", "plan/beta"]);
  return { cfg, hubDir, record, versions };
}

async function freshPlanAndStage(repo, hub) {
  const work = mkdtempSync(join(tmpdir(), "ega-adopt-work-"));
  const res = await checkForUpdates({
    adopted: {
      commit: hub.record.resolved_commit,
      snapshotDigest: hub.record.vendored_snapshot_digest,
      treeDigest: hub.record.selected_skill_tree_digest,
      versions: hub.versions,
    },
    config: hub.cfg,
    sourceId: "plan",
    workDir: work,
  });
  assert.equal(res.status, "UPDATE_AVAILABLE");
  const stageDir = mkdtempSync(join(tmpdir(), "ega-adopt-stage-"));
  const coB = checkoutAt(repo, res.plan.payload.target_commit);
  extractSelectedRoots(coB, hub.cfg.selection.roots, hub.cfg.provenanceFiles, stageDir);
  return { plan: res.plan, stageDir };
}

function codeOf(fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error("expected HubError, succeeded");
      },
      (e) => {
        assert.ok(e instanceof HubError, `expected HubError, got ${e}`);
        return e.code;
      },
    );
}

test("apply happy path swaps tree and lock, leaves no journal or lock", async () => {
  const { dir: repo, shaB } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const out = await applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir });
  assert.equal(out.record.resolved_commit, shaB);
  assert.equal(out.record.selected_skill_tree_digest, plan.payload.new_selected_tree_digest);
  assert.equal(out.record.vendored_snapshot_digest, plan.payload.new_vendored_snapshot_digest);
  assert.equal(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md"), "utf8"), BETA_B);
  assert.equal(readJournal(hub.hubDir), null);
  const lock = acquireHubLock(hub.hubDir);
  const ownerFile = readdirSync(join(hub.hubDir, ".hub.lock")).find((name) => name.startsWith("owner."));
  assert.ok(ownerFile);
  const owner = JSON.parse(readFileSync(join(hub.hubDir, ".hub.lock", ownerFile), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.token, /^[0-9a-f]{64}$/);
  lock.release();
});

test("provenance-only stage tampering fails before adoption and preserves both digests", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const beforeLock = readFileSync(join(hub.hubDir, "sources.lock.yaml"));
  const beforeTree = readFileSync(join(hub.hubDir, "trees", "plan", "skills", "alpha", "SKILL.md"));

  writeFileSync(join(stageDir, "LICENSE"), "Tampered provenance.\n");

  assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir })), "E_PLAN_DIGEST");
  assert.deepEqual(readFileSync(join(hub.hubDir, "sources.lock.yaml")), beforeLock);
  assert.deepEqual(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "alpha", "SKILL.md")), beforeTree);
  assert.equal(readJournal(hub.hubDir), null);
});

test("prospective validation preserves a custom declared owned root", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  mkdirSync(join(hub.hubDir, "custom", "ega", "local"), { recursive: true });
  writeFileSync(join(hub.hubDir, "custom", "ega", "local", "SKILL.md"), skill("local", "Local owned skill."));
  writeFileSync(join(hub.hubDir, "custom", "ega", "local", "ega.yaml"), "schema_version: 1\n");
  writeFileSync(
    join(hub.hubDir, "hub.yaml"),
    "schema_version: 1\nhub:\n  id: adoption-test\nowned:\n  - path: custom/ega\n    namespace: custom\nexternal:\n  - source: plan\n",
  );
  await buildHub(hub.hubDir);
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  await applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir });
  assert.equal(existsSync(join(hub.hubDir, "custom", "ega", "local", "SKILL.md")), true);
});

test("prospective full-Hub validation rejects an independent global catalog conflict atomically", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const beforeLock = readFileSync(join(hub.hubDir, "sources.lock.yaml"));
  const beforeTree = readFileSync(join(hub.hubDir, "trees", "plan", "skills", "alpha", "SKILL.md"));

  const ownedConflict = join(hub.hubDir, "owned", "plan", "alpha");
  mkdirSync(ownedConflict, { recursive: true });
  writeFileSync(join(ownedConflict, "SKILL.md"), beforeTree);
  writeFileSync(
    join(hub.hubDir, "hub.yaml"),
    "schema_version: 1\nhub:\n  id: adoption-test\nowned:\n  - path: owned/plan\n    namespace: plan\nexternal:\n  - source: plan\n",
  );

  assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir })), "E_BUILD_ATTESTATION");
  assert.deepEqual(readFileSync(join(hub.hubDir, "sources.lock.yaml")), beforeLock);
  assert.deepEqual(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "alpha", "SKILL.md")), beforeTree);
  assert.equal(readJournal(hub.hubDir), null);
});

test("canonical update lifecycle applies the immutable B plan after the tracked ref advances to C", async () => {
  const { dir: repo, shaB } = makeFixtureRepo();
  const shaA = makeFixtureRepoShaA(repo);
  const hub = await setupHubAtA(repo, shaA);
  const release1 = await buildHubRelease(hub.hubDir);
  const { plan } = await freshPlanAndStage(repo, hub);

  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), skill("alpha", "Alpha body C."));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "C");
  const shaC = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
  assert.notEqual(shaC, shaB);
  const planPath = join(mkdtempSync(join(tmpdir(), "ega-plan-file-")), "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const applied = await runHubUpdate({ hub: hub.hubDir, plan: planPath });
  assert.equal(applied.record.resolved_commit, shaB);
  assert.equal(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md"), "utf8"), BETA_B);
  assert.equal(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "alpha", "SKILL.md"), "utf8"), skill("alpha", "Alpha body A."));

  const release2 = await buildHubRelease(hub.hubDir);
  assert.notEqual(release2.release.digest, release1.release.digest);
  assert.equal(readFileSync(release1.artifactPaths.release, "utf8"), `${JSON.stringify(release1.release, null, 2)}\n`);
  assert.equal(release1.adoptedSources[0].resolvedCommit, shaA);
  assert.equal(release2.adoptedSources[0].resolvedCommit, shaB);
});

test("orphan staging from pre-journal crash is discarded under the mutation lock", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  mkdirSync(join(hub.hubDir, ".staging", "plan"), { recursive: true });
  writeFileSync(join(hub.hubDir, ".staging", "plan", "orphan.txt"), "orphan\n");
  await applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir });
  assert.equal(existsSync(join(hub.hubDir, ".staging")), false);
  assert.equal(readJournal(hub.hubDir), null);
});

test("PREPARED recovery discards staged data and preserves the adopted state", async () => {
  const { dir: repo } = makeFixtureRepo();
  const shaA = makeFixtureRepoShaA(repo);
  const hub = await setupHubAtA(repo, shaA);
  const lockBytes = readFileSync(join(hub.hubDir, "sources.lock.yaml"));
  const liveBytes = readFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md"));

  mkdirSync(join(hub.hubDir, ".staging", "plan"), { recursive: true });
  writeFileSync(join(hub.hubDir, ".staging", "plan", "staged.txt"), "staged\n");
  writeJournal(hub.hubDir, {
    backup: ".backup",
    expected_old_commit: shaA,
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "PREPARED",
    target_commit: "b".repeat(40),
  });

  assert.deepEqual(recoverIfNeeded(hub.hubDir), { recovered: true });
  assert.deepEqual(readFileSync(join(hub.hubDir, "sources.lock.yaml")), lockBytes);
  assert.deepEqual(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md")), liveBytes);
  assert.equal(existsSync(join(hub.hubDir, ".staging")), false);
  assert.equal(readJournal(hub.hubDir), null);
});

test("apply recovers a journal when the previous mutation lock owner is dead", async () => {
  const { dir: repo } = makeFixtureRepo();
  const shaA = makeFixtureRepoShaA(repo);
  const hub = await setupHubAtA(repo, shaA);
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const stalePid = await exitedProcessPid();
  writeFileSync(join(hub.hubDir, ".hub.lock"), `${stalePid}\n`);
  writeJournal(hub.hubDir, {
    backup: ".backup",
    expected_old_commit: shaA,
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "PREPARED",
    target_commit: plan.payload.target_commit,
  });

  await applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir });
  assert.equal(readJournal(hub.hubDir), null);
  assert.equal(existsSync(join(hub.hubDir, ".hub.lock")), false);
});

test("apply recovers a dead owner from the current directory lock protocol", async () => {
  const { dir: repo } = makeFixtureRepo();
  const shaA = makeFixtureRepoShaA(repo);
  const hub = await setupHubAtA(repo, shaA);
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const stalePid = await exitedProcessPid();
  mkdirSync(join(hub.hubDir, ".hub.lock"));
  writeFileSync(join(hub.hubDir, ".hub.lock", `owner.${"d".repeat(64)}`), JSON.stringify({ pid: stalePid, token: "d".repeat(64) }));
  writeJournal(hub.hubDir, {
    backup: ".backup",
    expected_old_commit: shaA,
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "PREPARED",
    target_commit: plan.payload.target_commit,
  });

  await applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir });
  assert.equal(readJournal(hub.hubDir), null);
  assert.equal(existsSync(join(hub.hubDir, ".hub.lock")), false);
});

function makeFixtureRepoShaA(repo) {
  return execFileSync("git", ["-C", repo, "rev-parse", "main~1"], { encoding: "utf8" }).trim();
}

test("foreign-config plan rejected (E_LOCK_MISMATCH)", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  // Same commits and tree, but bound to a different configuration intent.
  const foreign = {
    ...plan.payload,
    source_config_digest: `sha256:${"f".repeat(64)}`,
  };
  const resigned = createEnvelope({ object_type: "ega.update-plan", payload: foreign, schema_version: 1 });
  const foreignPlan = { digest: resigned.digest, object_type: "ega.update-plan", payload: foreign, schema_version: 1 };
  assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan: foreignPlan, stageDir })), "E_LOCK_MISMATCH");
});

test("wrong extraction contract rejected (E_PLAN_SCHEMA)", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const downgraded = { ...plan.payload, extraction_contract: 2 };
  const resigned = createEnvelope({ object_type: "ega.update-plan", payload: downgraded, schema_version: 1 });
  const downgradedPlan = { digest: resigned.digest, object_type: "ega.update-plan", payload: downgraded, schema_version: 1 };
  assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan: downgradedPlan, stageDir })), "E_PLAN_SCHEMA");
});

test("path-unsafe plan source id rejected before Hub lookup", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const unsafe = createEnvelope({
    object_type: "ega.update-plan",
    payload: { ...plan.payload, source_id: "../escape" },
    schema_version: 1,
  });
  assert.equal(
    await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan: unsafe, stageDir })),
    "E_PLAN_SCHEMA",
  );
});

test("stale plan rejected (E_PLAN_STALE)", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const bumped = { ...hub.record, resolved_commit: plan.payload.target_commit };
  writeFileSync(join(hub.hubDir, "sources.lock.yaml"), lockTextFor(bumped));
  assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir })), "E_PLAN_STALE");
});

test("tampered plan digest rejected (E_PLAN_DIGEST)", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const bad = { ...plan, digest: `sha256:${"0".repeat(64)}` };
  assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan: bad, stageDir })), "E_PLAN_DIGEST");
});

test("held Hub lock fails closed (E_HUB_LOCKED)", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const held = acquireHubLock(hub.hubDir);
  try {
    assert.equal(await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir })), "E_HUB_LOCKED");
  } finally {
    held.release();
  }
  await applyUpdatePlan({ hubDir: hub.hubDir, plan, stageDir });
  assert.equal(readJournal(hub.hubDir), null);
});

test("a released process cannot remove a replacement lock", async () => {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-lock-owner-"));
  const firstResult = join(hubDir, "first.result");
  const firstRelease = join(hubDir, "first.release");
  const first = spawnLockContender(hubDir, firstResult, firstRelease);
  await waitFor(firstResult);
  assert.equal(readFileSync(firstResult, "utf8"), "acquired");

  rmSync(join(hubDir, ".hub.lock"), { recursive: true });
  const replacement = acquireHubLock(hubDir);
  try {
    writeFileSync(firstRelease, "release");
    await new Promise((resolve, reject) => {
      first.once("error", reject);
      first.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`contender exited ${code}`)));
    });
    assert.equal(existsSync(join(hubDir, ".hub.lock")), true);
    const ownerFile = readdirSync(join(hubDir, ".hub.lock")).find((name) => name.startsWith("owner."));
    assert.ok(ownerFile);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(hubDir, ".hub.lock", ownerFile), "utf8")));
  } finally {
    replacement.release();
  }
});

test("two real contenders never both acquire Hub mutation authority", async () => {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-lock-contenders-"));
  const firstResult = join(hubDir, "first.result");
  const secondResult = join(hubDir, "second.result");
  const releasePath = join(hubDir, "release");
  const first = spawnLockContender(hubDir, firstResult, releasePath);
  const second = spawnLockContender(hubDir, secondResult, releasePath);
  await Promise.all([waitFor(firstResult), waitFor(secondResult)]);
  const results = [readFileSync(firstResult, "utf8"), readFileSync(secondResult, "utf8")];
  assert.equal(results.filter((result) => result === "acquired").length, 1);
  assert.equal(results.filter((result) => result.startsWith("error:E_HUB_LOCKED")).length, 1);
  writeFileSync(releasePath, "release");
  await Promise.all([
    new Promise((resolve, reject) => { first.once("error", reject); first.once("exit", resolve); }),
    new Promise((resolve, reject) => { second.once("error", reject); second.once("exit", resolve); }),
  ]);
});

test("two real stale-lock reclaimers cannot both acquire mutation authority", async () => {
  const { dir: repo } = makeFixtureRepo();
  const shaA = makeFixtureRepoShaA(repo);
  const hub = await setupHubAtA(repo, shaA);
  const stalePid = await exitedProcessPid();
  writeFileSync(join(hub.hubDir, ".hub.lock"), `${stalePid}\n`);
  writeJournal(hub.hubDir, {
    backup: ".backup",
    expected_old_commit: shaA,
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "PREPARED",
    target_commit: "b".repeat(40),
  });
  const resultPaths = [0, 1].map((index) => join(hub.hubDir, `.stale-contender-${index}.result`));
  const releasePaths = [0, 1].map((index) => join(hub.hubDir, `.stale-contender-${index}.release`));
  const children = resultPaths.map((resultPath, index) => spawnLockContender(hub.hubDir, resultPath, releasePaths[index]));
  await Promise.all(resultPaths.map(waitFor));
  const results = resultPaths.map((path) => readFileSync(path, "utf8"));
  assert.equal(results.filter((result) => result === "acquired").length, 1);
  assert.equal(results.filter((result) => result.startsWith("error:E_HUB_LOCKED")).length, 1);
  for (const releasePath of releasePaths) writeFileSync(releasePath, "release");
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  })));
  assert.equal(existsSync(join(hub.hubDir, ".hub.lock")), false);
});

test("crash after tree swap recovers exact previous state", async () => {
  const { dir: repo, shaB } = makeFixtureRepo();
  const shaA = makeFixtureRepoShaA(repo);
  const hub = await setupHubAtA(repo, shaA);
  const lockBytes = readFileSync(join(hub.hubDir, "sources.lock.yaml"));
  // Simulate crash between TREE_SWAPPED journal write and lock install:
  // backup holds A, live tree planted with B content, lock still at A.
  const backupTree = join(hub.hubDir, ".backup", "plan");
  mkdirSync(backupTree, { recursive: true });
  cpSync(join(hub.hubDir, "trees", "plan"), backupTree, { recursive: true });
  writeFileSync(join(hub.hubDir, ".backup", "sources.lock.yaml"), lockBytes);
  writeFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md"), BETA_B);
  writeJournal(hub.hubDir, {
    backup: ".backup",
    expected_old_commit: shaA,
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "TREE_SWAPPED",
    target_commit: shaB,
  });
  const res = recoverIfNeeded(hub.hubDir);
  assert.equal(res.recovered, true);
  assert.equal(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md"), "utf8"), BETA_A);
  assert.deepEqual(readFileSync(join(hub.hubDir, "sources.lock.yaml")), lockBytes);
  assert.equal(readJournal(hub.hubDir), null);
  assert.equal(existsSync(join(hub.hubDir, ".backup")), false);
  requireCleanJournal(hub.hubDir);
});

test("requireCleanJournal refuses while recovery is incomplete", () => {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hub-"));
  requireCleanJournal(hubDir);
  writeJournal(hubDir, {
    backup: ".backup",
    expected_old_commit: "a".repeat(40),
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "PREPARED",
    target_commit: "b".repeat(40),
  });
  assert.throws(() => requireCleanJournal(hubDir), (e) => e instanceof HubError && e.code === "E_RECOVERY_REQUIRED");
  recoverIfNeeded(hubDir);
  requireCleanJournal(hubDir);
});

test("journal-controlled paths are confined before recovery", () => {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hub-"));
  const outside = mkdtempSync(join(tmpdir(), "ega-outside-"));
  const marker = join(outside, "marker.txt");
  writeFileSync(marker, "keep\n");
  writeFileSync(
    join(hubDir, ".hub-journal.json"),
    JSON.stringify({
      backup: "../ega-outside-escape",
      expected_old_commit: "a".repeat(40),
      journal_version: 1,
      source_id: "plan",
      staging: ".staging",
      state: "PREPARED",
      target_commit: "b".repeat(40),
    }),
  );
  assert.throws(() => recoverIfNeeded(hubDir), (e) => e instanceof HubError && e.code === "E_JOURNAL_SCHEMA");
  assert.equal(readFileSync(marker, "utf8"), "keep\n");
});

test("plan for unadopted source rejected (E_LOCK_MISMATCH)", async () => {
  const { dir: repo } = makeFixtureRepo();
  const hub = await setupHubAtA(repo, makeFixtureRepoShaA(repo));
  const { plan, stageDir } = await freshPlanAndStage(repo, hub);
  const ghost = createEnvelope({
    object_type: "ega.update-plan",
    payload: { ...plan.payload, source_id: "ghost" },
    schema_version: 1,
  });
  assert.equal(
    await codeOf(() => applyUpdatePlan({ hubDir: hub.hubDir, plan: ghost, stageDir })),
    "E_LOCK_MISMATCH",
  );
});

test("absent journal reads null and needs no recovery", () => {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hub-"));
  assert.equal(readJournal(hubDir), null);
  assert.deepEqual(recoverIfNeeded(hubDir), { recovered: false });
});
