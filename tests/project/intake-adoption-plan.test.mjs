import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HubError,
  acquireSource,
  createAdoptionPlan,
  readHubIntakeState,
  stageAdoptionPlan,
  verifyAdoptionPlan,
} from "../../packages/project/dist/index.js";
import { createImportPlan, emptyRegistryTarget } from "../../packages/registry/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");

function git(dir, ...args) {
  execFileSync("git", ["-C", dir, "-c", "user.name=intake-test", "-c", "user.email=intake-test@example.test", "-c", "core.autocrlf=false", ...args], { stdio: "pipe" });
}

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} intake test skill.\n---\n\n${body}\n`;
}

function writeSkill(root, relative, name, body) {
  const dir = join(root, ...relative.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill(name, body));
  return dir;
}

function makeGitFixture() {
  const repo = mkdtempSync(join(tmpdir(), "ega-intake-git-"));
  git(repo, "init", "-b", "main");
  writeSkill(repo, "skills/alpha", "alpha", "A");
  writeFileSync(join(repo, "LICENSE"), "License A.\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "A");
  const commitA = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "skills/alpha", "SKILL.md"), skill("alpha", "B"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "B");
  const commitB = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "skills/alpha", "SKILL.md"), skill("alpha", "C"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "C");
  const commitC = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { commitA, commitB, commitC, repo };
}

function codeOf(fn) {
  try {
    fn();
    assert.fail("expected HubError");
  } catch (error) {
    assert.ok(error instanceof HubError, `expected HubError, got ${String(error)}`);
    return error.code;
  }
}

test("P03 exact Git acquisition reads the approved commit even after the ref advances", (t) => {
  const fixture = makeGitFixture();
  t.after(() => rmSync(fixture.repo, { recursive: true, force: true }));
  const acquired = acquireSource({
    commit: fixture.commitB,
    provenanceFiles: ["LICENSE"],
    ref: "main",
    roots: ["skills/alpha"],
    source: fixture.repo,
    sourceType: "git",
  });
  t.after(() => rmSync(acquired.workspace, { recursive: true, force: true }));
  assert.equal(acquired.resolvedCommit, fixture.commitB);
  assert.deepEqual(acquired.selectedSkills, ["skills/alpha"]);
  assert.equal(readFileSync(join(acquired.snapshotDir, "skills", "alpha", "SKILL.md"), "utf8"), skill("alpha", "B"));
  assert.notEqual(fixture.commitB, fixture.commitC);
});

test("P03 rejects ambiguous GitHub tree URLs and overlapping selected roots", () => {
  assert.equal(codeOf(() => acquireSource({ roots: ["skills"], source: "https://github.com/example/repo/tree/main/skills" })), "E_SOURCE_SCHEMA");
  assert.equal(codeOf(() => acquireSource({ roots: ["skills", "skills/alpha"], source: "/tmp/source", sourceType: "local" })), "E_SOURCE_SELECTION");
});

test("P03 local CLI plan and stage leave live Hub contracts untouched", (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-local-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "source");
  writeSkill(source, "skills/alpha", "alpha", "local");
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const hub = join(base, "hub");
  mkdirSync(hub);
  const planPath = join(base, "adoption-plan.json");
  const planResult = spawnSync(process.execPath, [cli, "hub", "intake", "plan", source, "--namespace", "intake", "--source-id", "local", "--root", "skills/alpha", "--provenance-file", "LICENSE", "--hub", hub, "--output", planPath], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(plan.payload.status, "READY");
  assert.equal(readHubIntakeState(hub).sourceIds.length, 0);
  assert.equal(existsSync(join(hub, "hub.yaml")), false);
  assert.equal(existsSync(join(hub, "sources.yaml")), false);
  assert.equal(existsSync(join(hub, "sources.lock.yaml")), false);

  const stageResult = spawnSync(process.execPath, [cli, "hub", "intake", "stage", "--plan", planPath, hub], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(stageResult.status, 0, stageResult.stderr);
  const staged = JSON.parse(stageResult.stdout);
  assert.equal(existsSync(join(staged.path, "source", "skills", "alpha", "SKILL.md")), true);
  assert.equal(existsSync(join(hub, "hub.yaml")), false);
  assert.equal(existsSync(join(hub, "sources.yaml")), false);
  assert.equal(existsSync(join(hub, "sources.lock.yaml")), false);

  const secondStage = spawnSync(process.execPath, [cli, "hub", "intake", "stage", "--plan", planPath, hub], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(secondStage.status, 0, secondStage.stderr);
  assert.deepEqual(JSON.parse(secondStage.stdout), staged);
});

test("P03 stage rejects a source changed after planning and preserves the Hub", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-stale-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "source");
  writeSkill(source, "skills/alpha", "alpha", "original");
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const acquired = acquireSource({ provenanceFiles: ["LICENSE"], roots: ["skills/alpha"], source, sourceType: "local" });
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: "intake", target: emptyRegistryTarget() });
  const plan = createAdoptionPlan({
    hub: readHubIntakeState(join(base, "hub")),
    importPlan,
    namespace: "intake",
    source: acquired,
    sourceId: "local",
  });
  rmSync(acquired.workspace, { recursive: true, force: true });
  writeFileSync(join(source, "skills", "alpha", "SKILL.md"), skill("alpha", "changed"));
  await assert.rejects(
    () => stageAdoptionPlan(plan, join(base, "hub")),
    (error) => error instanceof HubError && error.code === "E_PLAN_DIGEST",
  );
  assert.equal(existsSync(join(base, "hub", "hub.yaml")), false);
  assert.equal(existsSync(join(base, "hub", ".intake-staging")), false);
});

test("P03 adoption plans bind namespace, candidates, and conflicts", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-bindings-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "source");
  writeSkill(source, "skills/alpha", "alpha", "body");
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const acquired = acquireSource({ provenanceFiles: ["LICENSE"], roots: ["skills/alpha"], source, sourceType: "local" });
  t.after(() => rmSync(acquired.workspace, { recursive: true, force: true }));
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: "intake", target: emptyRegistryTarget() });
  const blocked = createAdoptionPlan({
    hub: { baselineDigest: "sha256:" + "a".repeat(64), namespaces: ["intake"], sourceIds: ["local"] },
    importPlan,
    namespace: "intake",
    source: acquired,
    sourceId: "local",
  });
  assert.equal(blocked.payload.status, "BLOCKED");
  assert.deepEqual(blocked.payload.diagnostics.map(({ code }) => code), ["E_SOURCE_ID_CONFLICT", "E_NAMESPACE_CONFLICT"]);
  assert.doesNotThrow(() => verifyAdoptionPlan(blocked));
});
