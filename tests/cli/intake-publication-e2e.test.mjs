import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildHubRelease, verifyReleaseCandidate } from "../../packages/project/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");
const validateArtifact = join(process.cwd(), "scripts", "hosted", "validate-artifact.mjs");

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
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
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: e2e-hub\nowned: []\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
}

test("E2E-01: actual intake CLI publishes the exact approved candidate", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-publication-e2e-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const source = join(base, "source");
  const skill = join(source, "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: Alpha intake end-to-end skill.\n---\n\nUse Alpha for the reviewed intake workflow.\n");
  writeFileSync(join(source, "LICENSE"), "License.\n");

  const hub = join(base, "hub");
  mkdirSync(hub);
  writeEmptyHub(hub);
  const planPath = join(base, "plan.json");
  const candidateDir = join(base, "candidate");
  const exportedDir = join(base, "exported");

  const baseline = await buildHubRelease(hub);
  const planned = runSuccessfulCli(
    "hub", "intake", "plan", source,
    "--namespace", "intake",
    "--source-id", "local-alpha",
    "--root", "skills/alpha",
    "--provenance-file", "LICENSE",
    "--hub", hub,
    "--output", planPath,
  );
  assert.equal(planned.blocked_count, 0);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(plan.payload.candidates[0].skill_id, "intake/alpha");

  runSuccessfulCli("hub", "intake", "stage", "--plan", planPath, hub);
  const applied = runSuccessfulCli("hub", "intake", "apply", "--plan", planPath, hub);
  assert.equal(applied.status, "COMMITTED");
  assert.equal(existsSync(join(hub, "owned", "local-alpha", "skills", "alpha", "SKILL.md")), true);

  const pending = runCli("hub", "release", "preflight", hub);
  assert.equal(pending.status, 1);
  assert.equal(jsonOutput(pending).payload.status, "BLOCKED");

  const reviewed = runSuccessfulCli(
    "hub", "intake", "review",
    "--candidate", plan.digest,
    "--decision", "approve",
    "--expected-revision", "0",
    hub,
  );
  assert.equal(reviewed.revision, 1);

  const ready = runSuccessfulCli("hub", "release", "preflight", hub);
  assert.equal(ready.payload.status, "READY");
  const preview = runSuccessfulCli(
    "hub", "release", "preview",
    "--hub", hub,
    "--against", baseline.artifactPaths.release,
    "--output-dir", candidateDir,
  );
  assert.equal(preview.status, "READY");
  const previewReleaseDigest = JSON.parse(readFileSync(join(candidateDir, "hub-release.json"), "utf8")).digest;
  assert.equal(preview.candidate.payload.release_digest, previewReleaseDigest);
  assert.equal(existsSync(join(candidateDir, "publication-preflight.json")), true);

  const exported = runSuccessfulCli(
    "hub", "release", "export",
    "--candidate", join(candidateDir, "candidate.json"),
    "--out", exportedDir,
  );
  assert.equal(exported.release_digest, preview.candidate.payload.release_digest);
  assert.equal(verifyReleaseCandidate(exportedDir).release.digest, preview.candidate.payload.release_digest);
  const validate = spawnSync(process.execPath, [validateArtifact, exportedDir], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(validate.status, 0, `${validate.stderr}\n${validate.stdout}`);
  assert.equal(readFileSync(join(source, "skills", "alpha", "SKILL.md"), "utf8").includes("Alpha intake"), true);
});
