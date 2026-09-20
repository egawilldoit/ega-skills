import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEnvelope, hashBytes } from "../../packages/hashing/dist/index.js";
import { buildHubRelease, verifyReleaseCandidate } from "../../packages/project/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");
const validateArtifact = join(process.cwd(), "scripts", "hosted", "validate-artifact.mjs");

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

function jsonOutput(result) {
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

function runSuccessfulCli(...args) {
  const result = runCli(...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return jsonOutput(result);
}

function writeEmptyHub(hub) {
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: derivative-e2e\nowned: []\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
}

function skill(name, description = `${name} derivative skill.`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`;
}

function patchDocument(skillId, path, expectedBytes, replacement) {
  return createEnvelope({
    object_type: "ega.derivation-patch",
    schema_version: 1,
    payload: {
      skill_id: `intake/${skillId}`,
      path: `skills/${skillId}/SKILL.md`,
      expected_digest: hashBytes(expectedBytes),
      replacement,
      reason: "reviewed compatibility repair",
      rule_version: "D1-cli-e2e-1",
    },
  });
}

function makeSource(base, name, text) {
  const source = join(base, name);
  const root = join(source, "skills", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), text);
  writeFileSync(join(source, "LICENSE"), `License for ${name}.\n`);
  return source;
}

test("W4: CLI derives, reviews, and publishes two owned skills under one declared namespace", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-derivative-publication-e2e-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const hub = join(base, "hub");
  mkdirSync(hub);
  writeEmptyHub(hub);

  // Seed the owned namespace through the regular intake workflow. The later
  // alpha and beta candidates must reuse this declared root without replacing
  // the unrelated seed skill.
  const seedSource = makeSource(base, "seed", skill("seed"));
  const seedPlanPath = join(base, "seed-plan.json");
  runSuccessfulCli("hub", "intake", "plan", seedSource, "--namespace", "ega", "--source-id", "seed", "--root", "skills/seed", "--provenance-file", "LICENSE", "--hub", hub, "--output", seedPlanPath);
  runSuccessfulCli("hub", "intake", "stage", "--plan", seedPlanPath, hub);
  const seedPlan = JSON.parse(readFileSync(seedPlanPath, "utf8"));
  runSuccessfulCli("hub", "intake", "review", "--candidate", seedPlan.digest, "--decision", "approve", "--expected-revision", "0", hub);
  runSuccessfulCli("hub", "intake", "apply", "--plan", seedPlanPath, hub);
  const baseline = await buildHubRelease(hub);

  const source = makeSource(base, "alpha", skill("alpha").replace("description:", "version: 1\ndescription:"));
  const planPath = join(base, "alpha-plan.json");
  const planned = runCli("hub", "intake", "plan", source, "--namespace", "intake", "--source-id", "alpha-source", "--root", "skills/alpha", "--provenance-file", "LICENSE", "--hub", hub, "--output", planPath);
  assert.equal(planned.status, 1, planned.stderr);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  runSuccessfulCli("hub", "intake", "stage", "--plan", planPath, hub);

  const staged = join(hub, ".intake-staging", plan.digest.slice("sha256:".length), "source", "skills", "alpha", "SKILL.md");
  const patchPath = join(base, "alpha-patch.json");
  writeFileSync(patchPath, `${JSON.stringify(patchDocument("alpha", "skills/alpha/SKILL.md", readFileSync(staged), skill("alpha", "canonical alpha")), null, 2)}\n`);
  const derived = runSuccessfulCli("hub", "intake", "derive", "--candidate", plan.digest, "--patch", patchPath, "--owned-id", "ega/alpha", hub);
  assert.equal(derived.candidate.payload.target.skill_id, "ega/alpha");
  const candidateDigest = derived.candidate.digest;
  runSuccessfulCli("hub", "intake", "review", "--candidate", candidateDigest, "--decision", "approve", "--expected-revision", "0", hub);
  const applied = runSuccessfulCli("hub", "intake", "apply", "--candidate", candidateDigest, hub);
  assert.equal(applied.status, "COMMITTED");
  assert.equal(existsSync(join(hub, "owned", "seed", "skills", "seed", "SKILL.md")), true);
  assert.equal(readFileSync(join(hub, "owned", "seed", "alpha", "SKILL.md"), "utf8"), skill("alpha", "canonical alpha"));

  const betaSource = makeSource(base, "beta", skill("beta").replace("description:", "version: 1\ndescription:"));
  const betaPlanPath = join(base, "beta-plan.json");
  const betaPlanned = runCli("hub", "intake", "plan", betaSource, "--namespace", "intake", "--source-id", "beta-source", "--root", "skills/beta", "--provenance-file", "LICENSE", "--hub", hub, "--output", betaPlanPath);
  assert.equal(betaPlanned.status, 1, betaPlanned.stderr);
  const betaPlan = JSON.parse(readFileSync(betaPlanPath, "utf8"));
  runSuccessfulCli("hub", "intake", "stage", "--plan", betaPlanPath, hub);
  const betaStaged = join(hub, ".intake-staging", betaPlan.digest.slice("sha256:".length), "source", "skills", "beta", "SKILL.md");
  const betaOriginalBytes = readFileSync(betaStaged);
  const betaPatchPath = join(base, "beta-patch.json");
  writeFileSync(betaPatchPath, `${JSON.stringify(patchDocument("beta", "skills/beta/SKILL.md", betaOriginalBytes, skill("beta", "canonical beta")), null, 2)}\n`);
  const betaDerived = runSuccessfulCli("hub", "intake", "derive", "--candidate", betaPlan.digest, "--patch", betaPatchPath, "--owned-id", "ega/beta", hub);
  const betaDigest = betaDerived.candidate.digest;
  assert.equal(betaDerived.candidate.payload.original.skill_id, "intake/beta");
  assert.equal(betaDerived.candidate.payload.original.input_file_digest, hashBytes(betaOriginalBytes));
  assert.deepEqual(betaDerived.candidate.payload.provenance.provenance_files, ["LICENSE"]);
  assert.equal(betaDerived.candidate.payload.target.skill_id, "ega/beta");
  runSuccessfulCli("hub", "intake", "review", "--candidate", betaDigest, "--decision", "approve", "--expected-revision", "0", hub);

  const betaStage = join(hub, ".intake-staging", betaDerived.proposal.digest.slice("sha256:".length), "source", "beta", "SKILL.md");
  const betaBytes = readFileSync(betaStage);
  writeFileSync(betaStage, "tampered\n");
  const rejected = runCli("hub", "intake", "apply", "--candidate", betaDigest, hub);
  assert.equal(rejected.status, 4);
  assert.match(rejected.stderr, /derived candidate bytes|candidate/);
  assert.equal(existsSync(join(hub, "owned", "seed", "beta", "SKILL.md")), false);
  writeFileSync(betaStage, betaBytes);

  const betaApplied = runSuccessfulCli("hub", "intake", "apply", "--candidate", betaDigest, hub);
  assert.equal(betaApplied.status, "COMMITTED");
  assert.equal(readFileSync(join(hub, "owned", "seed", "alpha", "SKILL.md"), "utf8"), skill("alpha", "canonical alpha"));
  assert.equal(readFileSync(join(hub, "owned", "seed", "beta", "SKILL.md"), "utf8"), skill("beta", "canonical beta"));
  assert.deepEqual(readFileSync(join(betaSource, "skills", "beta", "SKILL.md")), betaOriginalBytes);
  const receipts = readdirSync(join(hub, ".intake-provenance")).filter((entry) => entry.startsWith("derivative-"));
  assert.equal(receipts.length, 2);
  assert.equal(JSON.parse(readFileSync(join(hub, ".intake-provenance", receipts[1]), "utf8")).provenance.files[0].path, "LICENSE");

  const candidateDir = join(base, "candidate");
  const exportedDir = join(base, "exported");
  const preview = runSuccessfulCli("hub", "release", "preview", "--hub", hub, "--against", baseline.artifactPaths.release, "--output-dir", candidateDir);
  const exported = runSuccessfulCli("hub", "release", "export", "--candidate", join(candidateDir, "candidate.json"), "--out", exportedDir);
  assert.equal(exported.release_digest, preview.candidate.payload.release_digest);
  assert.equal(verifyReleaseCandidate(exportedDir).release.digest, preview.candidate.payload.release_digest);
  const validate = spawnSync(process.execPath, [validateArtifact, exportedDir], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(validate.status, 0, `${validate.stderr}\n${validate.stdout}`);
  const exportedRelease = JSON.parse(readFileSync(join(exportedDir, "hub-release.json"), "utf8"));
  assert.equal(exportedRelease.payload.skill_versions["ega/beta"], betaDerived.candidate.payload.target.version_hash);
  assert.ok(exportedRelease.payload.skill_versions["ega/alpha"]);
  assert.ok(exportedRelease.payload.skill_versions["ega/beta"]);
});
