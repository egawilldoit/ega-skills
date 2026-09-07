import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HubError,
  casUpdateStable,
  createHubRelease,
  createReleasePackage,
  createStablePointer,
  isReleaseRetained,
  rollbackStable,
  verifyHubRelease,
} from "../../packages/project/dist/index.js";

const HASH = (char) => `sha256:${char.repeat(64)}`;

function fixture() {
  const skills = [
    { skillId: "ega/alpha", versionHash: HASH("a") },
    { skillId: "ega/beta", versionHash: HASH("b") },
  ];
  const artifacts = {
    aliasMap: { aliases: { alpha: "ega/alpha" } },
    searchIndexInput: {
      rows: [
        {
          aliases: ["alpha"],
          description: "Alpha",
          domains: ["engineering"],
          frameworks: [],
          name: "alpha",
          platforms: [],
          skill_id: "ega/alpha",
          triggers: ["alpha"],
          version_hash: HASH("a"),
        },
        {
          aliases: [],
          description: "Beta",
          domains: ["engineering"],
          frameworks: [],
          name: "beta",
          platforms: [],
          skill_id: "ega/beta",
          triggers: ["beta"],
          version_hash: HASH("b"),
        },
      ],
    },
    tokenArtifact: {
      counts: [
        { level: "L2", skill_id: "ega/alpha", tokens: 3, version_hash: HASH("a") },
        { level: "L2", skill_id: "ega/beta", tokens: 4, version_hash: HASH("b") },
      ],
      estimator: "ega-o200k-v1",
    },
  };
  return {
    adoptedSources: [],
    hubId: "personal",
    registryHome: "/not-semantic",
    skills,
    artifacts,
  };
}

test("HubRelease binds the semantic artifacts and excludes deployment identity", () => {
  const value = fixture();
  const release = createHubRelease(value, value.artifacts);
  verifyHubRelease(release, value.artifacts);
  assert.equal(release.object_type, "ega.hub-release");
  assert.equal(release.payload.hub_id, "personal");
  assert.equal(release.payload.skill_versions["ega/alpha"], HASH("a"));
  const packageA = createReleasePackage(release, HASH("c"), 2);
  const packageB = createReleasePackage(release, HASH("d"), 2);
  assert.equal(packageA.hub_release_digest, packageB.hub_release_digest);
  assert.notEqual(packageA.sqlite_artifact_digest, packageB.sqlite_artifact_digest);
});

test("HubRelease rejects semantic tampering and bad artifact binding", () => {
  const value = fixture();
  const release = createHubRelease(value, value.artifacts);
  assert.throws(() => verifyHubRelease({ ...release, payload: { ...release.payload, hub_id: "other" } }), (error) => error.code === "E_RELEASE_DIGEST");
  assert.throws(() => createReleasePackage(release, HASH("c"), 1), (error) => error.code === "E_PACKAGE_BINDING");
});

test("stable publication is monotonic CAS and rollback remains a new version", () => {
  const value = fixture();
  const release = createHubRelease(value, value.artifacts);
  const first = createStablePointer("personal", release, 1);
  const second = casUpdateStable(undefined, first);
  assert.deepEqual(second, first);
  assert.throws(() => casUpdateStable(first, { ...first, cas_version: 3 }), (error) => error instanceof HubError && error.code === "E_STABLE");
  const rolled = rollbackStable(first, HASH("e"));
  assert.equal(rolled.cas_version, 2);
  assert.equal(rolled.stable_release_digest, HASH("e"));
  assert.equal(isReleaseRetained(HASH("e"), [HASH("e")]), true);
  assert.equal(isReleaseRetained(HASH("f"), [HASH("e")]), false);
});
