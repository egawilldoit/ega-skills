import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HubError,
  acquireSource,
  applyAdoptionPlan,
  buildHub,
  createAdoptionPlan,
  recoverAdoptionIfNeeded,
  readAdoptionJournal,
  readHubIntakeState,
  stageAdoptionPlan,
  parseSourcesLockYaml,
} from "../../packages/project/dist/index.js";
import { createImportPlan, emptyRegistryTarget } from "../../packages/registry/dist/index.js";

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} adoption test skill.\n---\n\n${body}\n`;
}

function writeSkill(root, relative, name, body) {
  const dir = join(root, ...relative.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill(name, body));
}

function git(dir, ...args) {
  execFileSync("git", ["-C", dir, "-c", "user.name=intake-test", "-c", "user.email=intake-test@example.test", ...args], { stdio: "pipe" });
}

function makeGitFixture() {
  const repo = mkdtempSync(join(tmpdir(), "ega-adopt-git-"));
  git(repo, "init", "-b", "main");
  writeSkill(repo, "skills/alpha", "alpha", "A");
  writeFileSync(join(repo, "LICENSE"), "License.\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "A");
  const commitA = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), skill("alpha", "B"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "B");
  const commitB = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), skill("alpha", "C"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "C");
  const commitC = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { commitA, commitB, commitC, repo };
}

async function makeLocalPlan(base) {
  const source = join(base, "source");
  writeSkill(source, "skills/alpha", "alpha", "local body");
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const acquired = acquireSource({ provenanceFiles: ["LICENSE"], roots: ["skills/alpha"], source, sourceType: "local" });
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: "intake", target: emptyRegistryTarget() });
  const hub = join(base, "hub");
  mkdirSync(hub);
  const plan = createAdoptionPlan({ hub: readHubIntakeState(hub), importPlan, namespace: "intake", source: acquired, sourceId: "local" });
  await stageAdoptionPlan(plan, hub);
  rmSync(acquired.workspace, { recursive: true, force: true });
  return { hub, plan };
}

test("AD-01: local first adoption commits an owned tree and complete Hub state", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-local-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makeLocalPlan(base);
  const result = await applyAdoptionPlan({ hubDir: hub, plan });
  assert.equal(result.status, "COMMITTED");
  assert.equal(existsSync(join(hub, "owned", "local", "skills", "alpha", "SKILL.md")), true);
  assert.match(readFileSync(join(hub, "hub.yaml"), "utf8"), /owned\/local/);
  assert.equal(readAdoptionJournal(hub), null);
  assert.equal((await buildHub(hub)).skills[0]?.skillId, "intake/alpha");
  const repeat = await applyAdoptionPlan({ hubDir: hub, plan });
  assert.equal(repeat.status, "ALREADY_APPLIED");
});

test("AD-03: stale adoption plan is rejected before any live mutation", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-stale-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makeLocalPlan(base);
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: changed\nowned: []\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  await assert.rejects(() => applyAdoptionPlan({ hubDir: hub, plan }), (error) => error instanceof HubError && error.code === "E_PLAN_STALE");
  assert.equal(readFileSync(join(hub, "hub.yaml"), "utf8"), "schema_version: 1\nhub:\n  id: changed\nowned: []\nexternal: []\n");
  assert.equal(existsSync(join(hub, ".adoption-journal.json")), false);
});

test("AD-04: an interrupted adoption restores the exact empty baseline", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-recovery-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makeLocalPlan(base);
  await assert.rejects(() => applyAdoptionPlan({ faultAfter: 1, hubDir: hub, plan }), /test fault/);
  assert.ok(readAdoptionJournal(hub));
  recoverAdoptionIfNeeded(hub);
  assert.equal(readAdoptionJournal(hub), null);
  assert.equal(existsSync(join(hub, "hub.yaml")), false);
  assert.equal(existsSync(join(hub, "owned", "local")), false);
  const result = await applyAdoptionPlan({ hubDir: hub, plan });
  assert.equal(result.status, "COMMITTED");
});

test("AD-06: a journal path escape fails closed without touching the sentinel", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-journal-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makeLocalPlan(base);
  await assert.rejects(() => applyAdoptionPlan({ faultAfter: "PREPARED", hubDir: hub, plan }), /test fault/);
  const journalPath = join(hub, ".adoption-journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries[0].path = "../sentinel";
  journal.allowed_paths[0] = "../sentinel";
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  const sentinel = join(base, "sentinel");
  writeFileSync(sentinel, "untouched\n");
  assert.throws(() => recoverAdoptionIfNeeded(hub), (error) => error instanceof HubError && error.code === "E_JOURNAL_SCHEMA");
  assert.equal(readFileSync(sentinel, "utf8"), "untouched\n");
});

test("AD-05: two sequential contenders converge to one committed adoption", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-idempotent-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makeLocalPlan(base);
  const first = await applyAdoptionPlan({ hubDir: hub, plan });
  const second = await applyAdoptionPlan({ hubDir: hub, plan });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(readHubIntakeState(hub).namespaces.includes("intake"), true);
});

test("AD-01/AD-02: Git first adoption commits the exact planned commit after the ref advances", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-git-plan-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fixture = makeGitFixture();
  t.after(() => rmSync(fixture.repo, { recursive: true, force: true }));
  const hub = join(base, "hub");
  mkdirSync(hub);
  const acquired = acquireSource({ commit: fixture.commitB, provenanceFiles: ["LICENSE"], ref: "main", roots: ["skills/alpha"], source: fixture.repo, sourceType: "git" });
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: "git", target: emptyRegistryTarget() });
  const plan = createAdoptionPlan({ hub: readHubIntakeState(hub), importPlan, namespace: "git", source: acquired, sourceId: "git-source" });
  rmSync(acquired.workspace, { recursive: true, force: true });
  await stageAdoptionPlan(plan, hub);
  const result = await applyAdoptionPlan({ hubDir: hub, plan });
  assert.equal(result.status, "COMMITTED");
  assert.equal(readFileSync(join(hub, "external", "git-source", "repo", "skills", "alpha", "SKILL.md"), "utf8"), skill("alpha", "B"));
  const lock = parseSourcesLockYaml(readFileSync(join(hub, "sources.lock.yaml"), "utf8"));
  assert.equal(lock.sources["git-source"]?.resolved_commit, fixture.commitB);
  assert.notEqual(fixture.commitB, fixture.commitC);
});

test("AD-07: the actual CLI apply command publishes the staged plan", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-adopt-cli-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "source");
  writeSkill(source, "skills/alpha", "alpha", "cli body");
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const hub = join(base, "hub");
  mkdirSync(hub);
  const planPath = join(base, "plan.json");
  const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");
  execFileSync(process.execPath, [cli, "hub", "intake", "plan", source, "--namespace", "cli", "--source-id", "local", "--root", "skills/alpha", "--provenance-file", "LICENSE", "--hub", hub, "--output", planPath]);
  execFileSync(process.execPath, [cli, "hub", "intake", "stage", "--plan", planPath, hub]);
  const output = execFileSync(process.execPath, [cli, "hub", "intake", "apply", "--plan", planPath, hub], { encoding: "utf8" });
  assert.match(output, /COMMITTED/);
  assert.match(execFileSync(process.execPath, [cli, "hub", "validate", hub], { encoding: "utf8" }), /"valid": true/);
});
