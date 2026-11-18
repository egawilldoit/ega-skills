/**
 * Clean release lifecycle coverage for the catalog reset.
 *
 * Uses temporary hubs and temporary release files. No committed skill is
 * asserted, no fake skill is added to the catalog, and no production system is
 * contacted. "Publish" here means the local, governed artifact build that
 * `main`-branch CI/Vercel publishes from; discovery is the registry's own FTS.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildHubRelease } from "../../packages/project/dist/index.js";
import { openRegistry, searchSkills } from "../../packages/registry/dist/index.js";
import { loadExpectedCatalog } from "../../scripts/release/verify-live.mjs";

const REPO_ROOT = join(process.cwd());
const VALIDATE_ARTIFACT = join(REPO_ROOT, "scripts/hosted/validate-artifact.mjs");
const ARTIFACT = join(REPO_ROOT, "packages/mcp/artifact");

function digest(letter) {
  return `sha256:${letter.repeat(64)}`;
}

function writeReleaseFiles(dir, skillIds) {
  const skillVersions = {};
  for (const [index, id] of skillIds.entries()) {
    skillVersions[id] = digest((index + 1).toString(16));
  }
  const manifest = {
    digest: digest("a"),
    object_type: "ega.hub-release",
    payload: { hub_id: "personal", skill_versions: skillVersions },
  };
  const releasePackage = {
    hub_release_digest: manifest.digest,
    sqlite_artifact_digest: digest("b"),
    snapshot_rows: skillIds.length,
  };
  const manifestPath = join(dir, "hub-release.json");
  const packagePath = join(dir, "release-package.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(packagePath, JSON.stringify(releasePackage));
  return { manifestPath, packagePath };
}

function makeEmptyHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-clean-hub-"));
  mkdirSync(join(hubDir, "owned", "ega"), { recursive: true });
  writeFileSync(
    join(hubDir, "hub.yaml"),
    "schema_version: 1\nhub:\n  id: personal\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n",
  );
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

function addSkill(hubDir, name) {
  const skillDir = join(hubDir, "owned", "ega", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} validation skill for the clean release test.\n---\n\nUse ${name} when validating a clean release.\n`,
  );
  writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains: [engineering]\ntriggers: [${name}]\n`);
  return `ega/${name}`;
}

// --- empty release integrity ------------------------------------------------

test("post-promotion verification accepts an empty catalog manifest", () => {
  // Reset contract: `verify-release.yml` runs verify-live against the committed
  // release. An empty active catalog is a valid release, so the manifest loader
  // must accept zero skills rather than treating them as a config failure.
  const dir = mkdtempSync(join(tmpdir(), "ega-clean-manifest-"));
  try {
    const { manifestPath, packagePath } = writeReleaseFiles(dir, []);
    const expected = loadExpectedCatalog({ manifestPath, packagePath });
    assert.equal(expected.skills.length, 0, "an empty release must be a valid verification baseline");
    assert.equal(expected.snapshotRows, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a newly added skill is accepted by the same manifest loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "ega-clean-manifest-add-"));
  try {
    const { manifestPath, packagePath } = writeReleaseFiles(dir, ["ega/alpha"]);
    const expected = loadExpectedCatalog({ manifestPath, packagePath });
    assert.deepEqual(
      expected.skills.map(([id]) => id),
      ["ega/alpha"],
    );
    assert.equal(expected.snapshotRows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid release manifests still fail after the reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "ega-clean-manifest-bad-"));
  try {
    const { manifestPath, packagePath } = writeReleaseFiles(dir, ["ega/alpha"]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const releasePackage = JSON.parse(readFileSync(packagePath, "utf8"));

    // Digest not bound to the release package.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, digest: digest("c") }));
    assert.throws(() => loadExpectedCatalog({ manifestPath, packagePath }), /does not match/u);

    // Malformed version hash.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, payload: { ...manifest.payload, skill_versions: { "ega/alpha": "not-a-digest" } } }));
    assert.throws(() => loadExpectedCatalog({ manifestPath, packagePath }), /invalid version hash/u);

    // Row count drift.
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(packagePath, JSON.stringify({ ...releasePackage, snapshot_rows: 2 }));
    assert.throws(() => loadExpectedCatalog({ manifestPath, packagePath }), /count.*match|does not match/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- empty -> add -> publish -> discover -----------------------------------

test("empty -> add -> publish -> discover works from temporary fixtures", async () => {
  const hubDir = makeEmptyHub();
  const homes = [];
  try {
    // 1. Empty release is buildable and validates as a deployment candidate.
    const empty = await buildHubRelease(hubDir);
    homes.push(empty.registryHome);
    assert.deepEqual(empty.skills, []);
    assert.equal(Object.keys(empty.release.payload.skill_versions).length, 0);
    const emptyValidation = spawnSync(process.execPath, [VALIDATE_ARTIFACT, empty.registryHome], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(emptyValidation.status, 0, emptyValidation.stderr);
    assert.match(emptyValidation.stdout, /skills=0/u);

    // 2. An empty release discovers nothing instead of failing.
    const emptyRegistry = openRegistry({ env: { EGA_SKILLS_HOME: empty.registryHome }, readonly: true });
    try {
      assert.deepEqual(searchSkills(emptyRegistry.db, "alpha", { ftsTable: empty.ftsTable }), []);
    } finally {
      emptyRegistry.close();
    }

    // 3. Add one new skill and rebuild: a new immutable release identity.
    const newId = addSkill(hubDir, "alpha");
    const added = await buildHubRelease(hubDir);
    homes.push(added.registryHome);
    assert.deepEqual(added.skills.map((skill) => skill.skillId), [newId]);
    assert.notEqual(added.release.digest, empty.release.digest, "a new skill must produce a new release identity");
    const addedValidation = spawnSync(process.execPath, [VALIDATE_ARTIFACT, added.registryHome], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(addedValidation.status, 0, addedValidation.stderr);
    assert.match(addedValidation.stdout, /skills=1/u);

    // 4. Discover the new skill through the release-scoped FTS table.
    const addedRegistry = openRegistry({ env: { EGA_SKILLS_HOME: added.registryHome }, readonly: true });
    try {
      const hits = searchSkills(addedRegistry.db, "alpha", { ftsTable: added.ftsTable });
      assert.ok(hits.some((hit) => hit.skillId === newId), `expected to discover ${newId}, got ${JSON.stringify(hits)}`);
    } finally {
      addedRegistry.close();
    }
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    rmSync(hubDir, { recursive: true, force: true });
  }
});

// --- release integrity and rollback references ------------------------------

test("the committed artifact keeps a distinct, valid previous-release identity", () => {
  const current = JSON.parse(readFileSync(join(ARTIFACT, "hub-release.json"), "utf8"));
  const previousPath = join(ARTIFACT, "previous-hub-release.json");
  assert.ok(readFileSync(previousPath, "utf8").length > 0, "previous-hub-release.json must be retained");
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  const digestPattern = /^sha256:[0-9a-f]{64}$/u;
  assert.match(String(current.digest), digestPattern);
  assert.match(String(previous.digest), digestPattern);
  assert.notEqual(previous.digest, current.digest, "rollback must point at a different immutable release");
});

test("the committed release-package digest is bound to the current release", () => {
  const current = JSON.parse(readFileSync(join(ARTIFACT, "hub-release.json"), "utf8"));
  const releasePackage = JSON.parse(readFileSync(join(ARTIFACT, "release-package.json"), "utf8"));
  assert.equal(releasePackage.hub_release_digest, current.digest);
  assert.match(String(releasePackage.sqlite_artifact_digest), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(releasePackage.snapshot_rows, Object.keys(current.payload.skill_versions).length);
});
