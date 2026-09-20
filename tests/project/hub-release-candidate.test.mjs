import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Hex } from "../../packages/hashing/dist/index.js";
import {
  buildHubRelease,
  createReleaseCandidate,
  createReleasePackage,
  exportReleaseCandidate,
  verifyReleaseCandidate,
  writeReleaseCandidate,
} from "../../packages/project/dist/index.js";

const requireFromProject = createRequire(new URL("../../packages/project/package.json", import.meta.url));
const Database = requireFromProject("better-sqlite3");
const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");

function makeHub() {
  const hub = mkdtempSync(join(tmpdir(), "ega-release-candidate-"));
  for (const name of ["alpha", "beta"]) {
    const skill = join(hub, "owned", "ega", name);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} candidate test skill.\n---\n\nUse ${name}.\n`);
  }
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: candidate-test\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hub;
}

function rewriteSQLiteDigest(build) {
  const database = new Database(join(build.registryHome, "registry.sqlite"));
  database.pragma("user_version = 17");
  database.close();
  const digest = `sha256:${sha256Hex(readFileSync(join(build.registryHome, "registry.sqlite")))}`;
  const releasePackage = createReleasePackage(build.release, digest, build.skills.length);
  writeFileSync(join(build.registryHome, "release-package.json"), `${JSON.stringify(releasePackage, null, 2)}\n`);
  return { ...build, releasePackage };
}

test("RL-01: semantic release identity survives different SQLite bytes", async (t) => {
  const hub = makeHub();
  const workspace = mkdtempSync(join(tmpdir(), "ega-release-candidate-test-"));
  t.after(() => {
    rmSync(hub, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const first = await buildHubRelease(hub);
  const second = rewriteSQLiteDigest(await buildHubRelease(hub));
  assert.equal(first.release.digest, second.release.digest);
  assert.notEqual(first.releasePackage.sqlite_artifact_digest, second.releasePackage.sqlite_artifact_digest);

  const firstCandidate = createReleaseCandidate(first);
  const secondCandidate = createReleaseCandidate(second);
  const firstVerified = writeReleaseCandidate(first, join(workspace, "candidate-one"), firstCandidate);
  const secondVerified = writeReleaseCandidate(second, join(workspace, "candidate-two"), secondCandidate);
  assert.equal(verifyReleaseCandidate(firstVerified.directory).release.digest, first.release.digest);
  assert.equal(verifyReleaseCandidate(secondVerified.directory).release.digest, second.release.digest);
});

test("RL-02: corrupted candidate artifacts are rejected before export", async (t) => {
  const hub = makeHub();
  const workspace = mkdtempSync(join(tmpdir(), "ega-release-candidate-corrupt-"));
  t.after(() => {
    rmSync(hub, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const build = await buildHubRelease(hub);
  const source = join(workspace, "source");
  writeReleaseCandidate(build, source, createReleaseCandidate(build));
  writeFileSync(join(source, "registry.sqlite"), "corrupt\n");
  assert.throws(() => verifyReleaseCandidate(source), /candidate|digest|blob/i);
  assert.equal(existsSync(join(workspace, "export")), false);
});

test("RL-03: export uses the retained candidate after Hub sources disappear", async (t) => {
  const hub = makeHub();
  const workspace = mkdtempSync(join(tmpdir(), "ega-release-candidate-export-"));
  t.after(() => {
    rmSync(hub, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const build = await buildHubRelease(hub);
  const source = join(workspace, "candidate");
  writeReleaseCandidate(build, source, createReleaseCandidate(build));
  rmSync(hub, { recursive: true, force: true });
  const exported = exportReleaseCandidate(join(source, "candidate.json"), join(workspace, "exported"));
  assert.equal(exported.release.digest, build.release.digest);
  assert.equal(verifyReleaseCandidate(join(workspace, "exported")).release.digest, build.release.digest);

  const cliResult = spawnSync(process.execPath, [cli, "hub", "release", "export", "--candidate", join(source, "candidate.json"), "--out", join(workspace, "cli-export")], { encoding: "utf8" });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).release_digest, build.release.digest);
  assert.equal(existsSync(join(workspace, "cli-export", "registry.sqlite")), true);
});

test("release preview CLI blocks an unreviewed catalog", async (t) => {
  const hub = makeHub();
  const workspace = mkdtempSync(join(tmpdir(), "ega-release-preview-"));
  t.after(() => {
    rmSync(hub, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const base = await buildHubRelease(hub);
  const result = spawnSync(process.execPath, [cli, "hub", "release", "preview", "--hub", hub, "--against", base.artifactPaths.release, "--output-dir", join(workspace, "candidate")], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "BLOCKED");
  assert.equal(output.preflight.payload.status, "BLOCKED");
});
