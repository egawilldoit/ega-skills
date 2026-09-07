import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  buildHub,
  casUpdateStable,
  createHubRelease,
  createReleasePackage,
  createStablePointer,
  deriveAliasMap,
  deriveSearchIndexInput,
  deriveTokenArtifact,
  isReleaseRetained,
  rollbackStable,
  verifyHubRelease,
} from "../../packages/project/dist/index.js";

const HASH = (char) => `sha256:${char.repeat(64)}`;

async function fixture(variant = "") {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-release-fixture-"));
  for (const name of ["alpha", "beta"]) {
    const skillDir = join(hubDir, "owned", "ega", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} ${variant}\n---\n\n${name} body ${variant}.\n`);
  }
  writeFileSync(join(hubDir, "owned", "ega", "alpha", "ega.yaml"), "schema_version: 1\naliases:\n  - alpha\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "owned", "ega", "beta", "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - beta\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: personal\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const build = await buildHub(hubDir);
  return {
    ...build,
    artifacts: {
      aliasMap: deriveAliasMap(build),
      searchIndexInput: deriveSearchIndexInput(build),
      tokenArtifact: deriveTokenArtifact(build),
    },
  };
}

test("HubRelease binds the semantic artifacts and excludes deployment identity", () => {
  return fixture().then((value) => {
  const release = createHubRelease(value, value.artifacts);
  verifyHubRelease(release, value.artifacts);
  assert.equal(release.object_type, "ega.hub-release");
  assert.equal(release.payload.hub_id, "personal");
  assert.equal(release.payload.skill_versions["ega/alpha"], value.skills.find((skill) => skill.skillId === "ega/alpha").versionHash);
  const packageA = createReleasePackage(release, HASH("c"), 2);
  const packageB = createReleasePackage(release, HASH("d"), 2);
  assert.equal(packageA.hub_release_digest, packageB.hub_release_digest);
  assert.notEqual(packageA.sqlite_artifact_digest, packageB.sqlite_artifact_digest);
  });
});

test("HubRelease rejects semantic tampering and bad artifact binding", () => {
  return fixture().then((value) => {
  const release = createHubRelease(value, value.artifacts);
  assert.throws(() => verifyHubRelease({ ...release, payload: { ...release.payload, hub_id: "other" } }), (error) => error.code === "E_RELEASE_DIGEST");
  assert.throws(() => createReleasePackage(release, HASH("c"), 1), (error) => error.code === "E_PACKAGE_BINDING");
  const wrongSearch = { ...value.artifacts.searchIndexInput, rows: value.artifacts.searchIndexInput.rows.map((row, index) => index === 0 ? { ...row, version_hash: HASH("f") } : row) };
  assert.throws(() => createHubRelease(value, { ...value.artifacts, searchIndexInput: wrongSearch }), (error) => error.code === "E_SEARCH_INPUT");
  });
});

test("stable publication is monotonic CAS and rollback remains a new version", () => {
  return Promise.all([fixture("one"), fixture("two")]).then(([value, retained]) => {
  const release = createHubRelease(value, value.artifacts);
  const retainedRelease = createHubRelease(retained, retained.artifacts);
  const first = createStablePointer("personal", release, 1);
  const second = casUpdateStable(undefined, first);
  assert.deepEqual(second, first);
  assert.throws(() => casUpdateStable(first, { ...first, cas_version: 3 }), (error) => error instanceof HubError && error.code === "E_STABLE");
  const rolled = rollbackStable(first, retainedRelease);
  assert.equal(rolled.cas_version, 2);
  assert.equal(rolled.stable_release_digest, retainedRelease.digest);
  assert.equal(isReleaseRetained(retainedRelease.digest, [retainedRelease.digest]), true);
  assert.equal(isReleaseRetained(HASH("f"), [HASH("e")]), false);
  assert.throws(() => rollbackStable(first, HASH("e")), (error) => error instanceof HubError && error.code === "E_RELEASE_SCHEMA");
  return fixture("cross").then((other) => {
    const otherRelease = createHubRelease({ ...other, hubId: "other" }, other.artifacts);
    assert.throws(() => rollbackStable(first, otherRelease), (error) => error instanceof HubError && error.code === "E_STABLE");
  });
  });
});
