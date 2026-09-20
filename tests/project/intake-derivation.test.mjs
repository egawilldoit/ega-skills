import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HubError,
  acquireSource,
  applyDerivationProposal,
  applyAdoptionPlan,
  createAdoptionPlan,
  createDerivationProposal,
  deriveCandidate,
  readHubIntakeState,
  stageAdoptionPlan,
  verifyDerivationProposal,
} from "../../packages/project/dist/index.js";
import { createEnvelope, hashBytes } from "../../packages/hashing/dist/index.js";
import { createImportPlan, emptyRegistryTarget, prepareSkillRoot } from "../../packages/registry/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");

function skill(name, description = `${name} derivation test skill.`, body = "body") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function writeSkill(root, text) {
  const directory = join(root, "skills", "alpha");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), text);
  return join(directory, "SKILL.md");
}

async function makePlan(base, text, namespace = "intake", sourceId = "local") {
  const source = join(base, "source");
  const skillPath = writeSkill(source, text);
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const acquired = acquireSource({ provenanceFiles: ["LICENSE"], roots: ["skills/alpha"], source, sourceType: "local" });
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace, target: emptyRegistryTarget() });
  const hub = join(base, "hub");
  mkdirSync(hub);
  const plan = createAdoptionPlan({ hub: readHubIntakeState(hub), importPlan, namespace, source: acquired, sourceId });
  await stageAdoptionPlan(plan, hub);
  rmSync(acquired.workspace, { recursive: true, force: true });
  return { hub, plan, skillPath };
}

function patchDocument(skillId, path, expectedBytes, replacement, reason = "reviewed compatibility repair") {
  return createEnvelope({
    object_type: "ega.derivation-patch",
    schema_version: 1,
    payload: {
      skill_id: skillId,
      path,
      expected_digest: hashBytes(expectedBytes),
      replacement,
      reason,
      rule_version: "D1-test-1",
    },
  });
}

test("CP-01: accepted unsupported-frontmatter repair preserves source and records exact lineage", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-derivation-repair-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const original = skill("alpha").replace("description:", "version: 1\ndescription:");
  const { hub, plan } = await makePlan(base, original);
  assert.equal(plan.payload.status, "BLOCKED");
  const stagedPath = join(hub, ".intake-staging", plan.digest.slice("sha256:".length), "source", "skills", "alpha", "SKILL.md");
  const originalBytes = readFileSync(stagedPath);
  const replacement = skill("alpha");
  const patch = patchDocument("intake/alpha", "skills/alpha/SKILL.md", originalBytes, replacement, "remove unsupported frontmatter version field");
  const result = await deriveCandidate({ candidate: plan, hubDir: hub, ownedId: "ega/alpha", patch });
  const proposal = verifyDerivationProposal(result.proposal);
  assert.equal(proposal.payload.original.version_hash, null);
  assert.equal(proposal.payload.patch.reason, "remove unsupported frontmatter version field");
  assert.equal(readFileSync(stagedPath, "utf8"), original);
  const prepared = await prepareSkillRoot(join(result.path, "source", "alpha"), "ega");
  assert.equal(prepared.skillId, "ega/alpha");
  assert.equal(prepared.versionHash, result.version_hash);
  assert.equal(JSON.parse(readFileSync(join(result.path, "derivation-plan.json"), "utf8")).digest, result.proposal.digest);
  const planPath = join(base, "candidate.json");
  const patchPath = join(base, "repair.json");
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  writeFileSync(patchPath, `${JSON.stringify(patch)}\n`);
  const cliResult = JSON.parse(execFileSync(process.execPath, [cli, "hub", "intake", "derive", "--candidate", planPath, "--patch", patchPath, "--owned-id", "ega/alpha", hub], { encoding: "utf8" }));
  assert.equal(cliResult.idempotent, true);
  assert.equal(cliResult.proposal.digest, result.proposal.digest);
});

test("CP-02: changing the staged input after proposal creation fails the exact precondition", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-derivation-stale-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makePlan(base, skill("alpha"));
  const stagedPath = join(hub, ".intake-staging", plan.digest.slice("sha256:".length), "source", "skills", "alpha", "SKILL.md");
  const before = readFileSync(stagedPath);
  const patch = patchDocument("intake/alpha", "skills/alpha/SKILL.md", before, skill("alpha", "repaired description"));
  const proposal = await createDerivationProposal({ candidate: plan, hubDir: hub, ownedId: "ega/alpha", patch });
  writeFileSync(stagedPath, skill("alpha", "tampered after proposal"));
  await assert.rejects(
    () => applyDerivationProposal({ hubDir: hub, proposal }),
    (error) => error instanceof HubError && error.code === "E_DERIVATION" && /precondition failed/.test(error.message),
  );
  assert.equal(readdirSync(join(hub, ".intake-staging")).filter((entry) => entry !== plan.digest.slice("sha256:".length)).length, 0);
});

test("CP-03: a different existing owned target is a conflict and is never overwritten", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-derivation-conflict-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const existing = await makePlan(join(base, "existing"), skill("alpha", "existing bytes"), "ega", "existing");
  await applyAdoptionPlan({ hubDir: existing.hub, plan: existing.plan });
  mkdirSync(join(existing.hub, "owned", "existing", "alpha"), { recursive: true });
  writeFileSync(join(existing.hub, "owned", "existing", "alpha", "SKILL.md"), skill("alpha", "existing derivative bytes"));
  const candidate = await makePlan(join(base, "candidate"), skill("alpha", "candidate bytes"), "intake", "candidate");
  await stageAdoptionPlan(candidate.plan, existing.hub);
  const stagedPath = join(existing.hub, ".intake-staging", candidate.plan.digest.slice("sha256:".length), "source", "skills", "alpha", "SKILL.md");
  const patch = patchDocument("intake/alpha", "skills/alpha/SKILL.md", readFileSync(stagedPath), skill("alpha", "different derivative bytes"));
  await assert.rejects(
    () => createDerivationProposal({ candidate: candidate.plan, hubDir: existing.hub, ownedId: "ega/alpha", patch }),
    (error) => error instanceof HubError && error.code === "E_DERIVATION" && /different bytes/.test(error.message),
  );
  assert.equal(readFileSync(join(existing.hub, "owned", "existing", "alpha", "SKILL.md"), "utf8"), skill("alpha", "existing derivative bytes"));
});

test("CP-04: overlong Unicode descriptions fail clearly without truncation or a derivative stage", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-derivation-limit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { hub, plan } = await makePlan(base, skill("alpha"));
  const stagedPath = join(hub, ".intake-staging", plan.digest.slice("sha256:".length), "source", "skills", "alpha", "SKILL.md");
  const before = readFileSync(stagedPath);
  const replacement = skill("alpha", "é".repeat(1025));
  const patch = patchDocument("intake/alpha", "skills/alpha/SKILL.md", before, replacement, "reviewed description rewrite");
  await assert.rejects(
    () => createDerivationProposal({ candidate: plan, hubDir: hub, ownedId: "ega/alpha", patch }),
    (error) => error instanceof HubError && error.code === "E_DERIVATION" && /1024/.test(error.message),
  );
  assert.deepEqual(readFileSync(stagedPath), before);
  assert.equal(readdirSync(join(hub, ".intake-staging")).filter((entry) => entry !== plan.digest.slice("sha256:".length)).length, 0);
});
