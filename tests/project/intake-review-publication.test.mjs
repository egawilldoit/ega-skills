import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acquireSource,
  applyAdoptionPlan,
  createAdoptionPlan,
  preflightPublication,
  readReviewRecords,
  readHubIntakeState,
  stageAdoptionPlan,
  writeCandidateReview,
} from "../../packages/project/dist/index.js";
import { createImportPlan, emptyRegistryTarget } from "../../packages/registry/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");

function skill(body) {
  return `---\nname: alpha\ndescription: alpha review test skill.\n---\n\n${body}\n`;
}

async function makeAdoptedHub(base, body = "v1") {
  const source = join(base, "source");
  mkdirSync(join(source, "skills", "alpha"), { recursive: true });
  writeFileSync(join(source, "skills", "alpha", "SKILL.md"), skill(body));
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const hub = join(base, "hub");
  mkdirSync(hub);
  const acquired = acquireSource({ provenanceFiles: ["LICENSE"], roots: ["skills/alpha"], source, sourceType: "local" });
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: "intake", target: emptyRegistryTarget() });
  const plan = createAdoptionPlan({ hub: readHubIntakeState(hub), importPlan, namespace: "intake", source: acquired, sourceId: "local" });
  const planPath = join(base, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await stageAdoptionPlan(plan, hub);
  await applyAdoptionPlan({ hubDir: hub, plan });
  rmSync(acquired.workspace, { recursive: true, force: true });
  return { hub, plan, planPath };
}

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

test("RV-01/RV-04: review and publication preflight bind the exact adopted version", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-review-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan, planPath } = await makeAdoptedHub(base);

  const blocked = runCli("hub", "release", "preflight", hub);
  assert.equal(blocked.status, 1);
  const blockedDoc = JSON.parse(blocked.stdout);
  assert.equal(blockedDoc.payload.status, "BLOCKED");
  assert.deepEqual(blockedDoc.payload.skill_versions, { "intake/alpha": JSON.parse(readFileSync(planPath, "utf8")).payload.candidates[0].version_hash });
  assert.equal(blockedDoc.payload.blockers[0].code, "MISSING_APPROVAL");

  const review = runCli("hub", "intake", "review", "--candidate", plan.digest, "--decision", "approve", "--expected-revision", "0", hub);
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).revision, 1);
  const ready = await preflightPublication(hub);
  assert.equal(ready.payload.status, "READY");
  assert.equal(ready.payload.reviews[0].decision, "APPROVED");

  // Simulate a new adopted version while retaining the old approval. The
  // preflight must report the changed bytes, not omit the skill.
  writeFileSync(join(hub, "owned", "local", "skills", "alpha", "SKILL.md"), skill("v2"));
  const stale = runCli("hub", "release", "preflight", hub);
  assert.equal(stale.status, 1);
  const staleDoc = JSON.parse(stale.stdout);
  assert.equal(staleDoc.payload.status, "BLOCKED");
  assert.equal(staleDoc.payload.skill_versions["intake/alpha"] !== ready.payload.skill_versions["intake/alpha"], true);
  assert.equal(staleDoc.payload.blockers[0].code, "STALE_APPROVAL");
});

test("RV-02: compare-and-swap review writes preserve history under competing writes", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-review-cas-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makeAdoptedHub(base);
  writeCandidateReview({ candidate: plan, decision: "APPROVED", expectedRevision: 0, hubDir: hub });
  const results = await Promise.allSettled([
    Promise.resolve().then(() => writeCandidateReview({ candidate: plan, decision: "REJECTED", expectedRevision: 1, hubDir: hub })),
    Promise.resolve().then(() => writeCandidateReview({ candidate: plan, decision: "REJECTED", expectedRevision: 1, hubDir: hub })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && /E_REVIEW_STALE/.test(String(result.reason?.message))).length, 1);
  const records = readReviewRecords(hub);
  assert.deepEqual(records.map((record) => record.payload.revision), [1, 2]);
  assert.equal(records[1].payload.previous_review_digest, records[0].digest);
});

test("RV-03: candidate text cannot claim approval authority", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-review-authority-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan, planPath } = await makeAdoptedHub(base);
  const forged = { ...plan, payload: { ...plan.payload, approved: true } };
  const forgedPath = join(base, "forged-plan.json");
  writeFileSync(forgedPath, `${JSON.stringify(forged)}\n`);
  const result = runCli("hub", "intake", "review", "--candidate", forgedPath, "--decision", "approve", "--expected-revision", "0", hub);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adoption plan envelope|E_PLAN_SCHEMA|E_ARTIFACT/);
  assert.equal(readReviewRecords(hub).length, 0);
  assert.equal(existsSync(planPath), true);
});
