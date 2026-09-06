import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  acquireHubLock,
  applyUpdatePlan,
  checkForUpdates,
  extractSelectedRoots,
  parseSourcesYaml,
  readJournal,
  recoverIfNeeded,
  requireCleanJournal,
  writeJournal,
} from "../../packages/project/dist/index.js";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import { importSkills, listSkillVersions, openRegistry } from "../../packages/registry/dist/index.js";

function git(dir, ...args) {
  execFileSync("git", ["-C", dir, "-c", "user.name=plan", "-c", "user.email=plan@t", ...args], { stdio: "pipe" });
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
  execFileSync("git", ["clone", "--quiet", repo, dir], { stdio: "pipe" });
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
  return `schema_version: 1\nsources:\n  plan:\n${Object.entries(record)
    .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
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
    source_config_digest: "sha256:00",
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
  assert.equal(readFileSync(join(hub.hubDir, "trees", "plan", "skills", "beta", "SKILL.md"), "utf8"), BETA_B);
  assert.equal(readJournal(hub.hubDir), null);
  const lock = acquireHubLock(hub.hubDir);
  lock.release();
});

function makeFixtureRepoShaA(repo) {
  return execFileSync("git", ["-C", repo, "rev-parse", "main~1"], { encoding: "utf8" }).trim();
}

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
