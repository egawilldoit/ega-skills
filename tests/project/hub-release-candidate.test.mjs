import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEnvelope, sha256Hex } from "../../packages/hashing/dist/index.js";
import {
  approvalSetDigest,
  buildHubRelease,
  createArtifactCandidate,
  createReleaseCandidate,
  createReleaseDiff,
  createReleasePackage,
  exportReleaseCandidate,
  exportLegacyReleaseCandidate,
  verifyReleaseCandidate,
  writeArtifactCandidate,
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

function repeatedDigest(character) {
  return `sha256:${character.repeat(64)}`;
}

function governedPublication(build, base = build.release) {
  const reviews = Object.entries(build.release.payload.skill_versions).sort(([left], [right]) => left.localeCompare(right)).map(([skill_id, version_hash], index) => ({
    candidate_digest: repeatedDigest(String(index + 1)),
    decision: "APPROVED",
    revision: 1,
    review_digest: repeatedDigest(String(index + 3)),
    skill_id,
    version_hash,
  }));
  const preflight = createEnvelope({
    object_type: "ega.publication-preflight",
    payload: {
      approval_set_digest: approvalSetDigest(reviews),
      blockers: [],
      hub_id: build.release.payload.hub_id,
      reviews,
      skill_versions: build.release.payload.skill_versions,
      status: "READY",
    },
    schema_version: 2,
  });
  return { preflight, releaseDiff: createReleaseDiff(base, build.release) };
}

function rebindCandidate(candidatePath, preflight, releaseDiff = undefined) {
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  const publication = {
    ...candidate.payload.publication,
    approval_set_digest: preflight.payload.approval_set_digest,
    preflight_digest: preflight.digest,
    ...(releaseDiff === undefined ? {} : {
      release_diff_digest: releaseDiff.digest,
      previous_release_digest: releaseDiff.payload.base_release_digest,
    }),
  };
  writeFileSync(candidatePath, `${JSON.stringify(createEnvelope({
    object_type: candidate.object_type,
    payload: { ...candidate.payload, publication },
    schema_version: candidate.schema_version,
  }), null, 2)}\n`);
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

  const firstCandidate = createArtifactCandidate(first);
  const secondCandidate = createArtifactCandidate(second);
  const firstVerified = writeArtifactCandidate(first, join(workspace, "candidate-one"), firstCandidate);
  const secondVerified = writeArtifactCandidate(second, join(workspace, "candidate-two"), secondCandidate);
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
  writeArtifactCandidate(build, source, createArtifactCandidate(build));
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
  writeArtifactCandidate(build, source, createArtifactCandidate(build));
  rmSync(hub, { recursive: true, force: true });
  const exported = exportLegacyReleaseCandidate(join(source, "candidate.json"), join(workspace, "exported"));
  assert.equal(exported.release.digest, build.release.digest);
  assert.equal(verifyReleaseCandidate(join(workspace, "exported")).release.digest, build.release.digest);

  const cliResult = spawnSync(process.execPath, [cli, "hub", "release", "export", "--candidate", join(source, "candidate.json"), "--out", join(workspace, "cli-export"), "--legacy"], { encoding: "utf8" });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).release_digest, build.release.digest);
  assert.equal(existsSync(join(workspace, "cli-export", "registry.sqlite")), true);
});

test("RL-08: governed export binds complete approval receipts and rejects tampering", async (t) => {
  const hub = makeHub();
  const workspace = mkdtempSync(join(tmpdir(), "ega-release-governed-"));
  t.after(() => {
    rmSync(hub, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const build = await buildHubRelease(hub);
  const publication = governedPublication(build);
  const source = join(workspace, "source");
  writeReleaseCandidate(build, source, createReleaseCandidate(build, {
    preflight: publication.preflight,
    previousReleaseDigest: build.release.digest,
    releaseDiff: publication.releaseDiff,
  }), publication);
  const exported = exportReleaseCandidate(join(source, "candidate.json"), join(workspace, "exported"));
  assert.equal(exported.candidate.schema_version, 2);

  const expectRejected = (name, mutate) => {
    const tampered = join(workspace, name);
    cpSync(source, tampered, { recursive: true });
    mutate(tampered);
    assert.throws(() => exportReleaseCandidate(join(tampered, "candidate.json"), join(workspace, `${name}-export`)), /candidate|publication|preflight|release diff|approval/i);
  };

  expectRejected("missing-receipt", (directory) => rmSync(join(directory, "publication-preflight.json")));
  expectRejected("altered-receipt", (directory) => {
    const receipt = JSON.parse(readFileSync(join(directory, "publication-preflight.json"), "utf8"));
    receipt.payload.status = "BLOCKED";
    writeFileSync(join(directory, "publication-preflight.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  });
  expectRejected("wrong-approval-digest", (directory) => {
    const receipt = JSON.parse(readFileSync(join(directory, "publication-preflight.json"), "utf8"));
    receipt.payload.approval_set_digest = repeatedDigest("f");
    writeFileSync(join(directory, "publication-preflight.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  });

  const blocked = createEnvelope({
    object_type: publication.preflight.object_type,
    payload: {
      ...publication.preflight.payload,
      blockers: [{
        approved_version_hash: null,
        code: "MISSING_APPROVAL",
        expected_version_hash: Object.values(build.release.payload.skill_versions)[0],
        review_digest: null,
        skill_id: Object.keys(build.release.payload.skill_versions)[0],
      }],
      status: "BLOCKED",
    },
    schema_version: publication.preflight.schema_version,
  });
  expectRejected("blocked-receipt", (directory) => {
    writeFileSync(join(directory, "publication-preflight.json"), `${JSON.stringify(blocked, null, 2)}\n`);
    rebindCandidate(join(directory, "candidate.json"), blocked);
  });

  const mismatched = createEnvelope({
    object_type: publication.preflight.object_type,
    payload: {
      ...publication.preflight.payload,
      reviews: publication.preflight.payload.reviews.map((review, index) => index === 0 ? { ...review, version_hash: repeatedDigest("e") } : review),
      skill_versions: { ...publication.preflight.payload.skill_versions, [Object.keys(build.release.payload.skill_versions)[0]]: repeatedDigest("e") },
      approval_set_digest: approvalSetDigest(publication.preflight.payload.reviews.map((review, index) => index === 0 ? { ...review, version_hash: repeatedDigest("e") } : review)),
    },
    schema_version: publication.preflight.schema_version,
  });
  expectRejected("mismatched-skill", (directory) => {
    writeFileSync(join(directory, "publication-preflight.json"), `${JSON.stringify(mismatched, null, 2)}\n`);
    rebindCandidate(join(directory, "candidate.json"), mismatched);
  });

  const otherHub = makeHub();
  writeFileSync(join(otherHub, "owned", "ega", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: changed candidate skill.\n---\n\nChanged.\n");
  const otherBuild = await buildHubRelease(otherHub);
  t.after(() => rmSync(otherHub, { recursive: true, force: true }));
  expectRejected("swapped-diff", (directory) => writeFileSync(join(directory, "release-diff.json"), `${JSON.stringify(createReleaseDiff(build.release, otherBuild.release), null, 2)}\n`));
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
