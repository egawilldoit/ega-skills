import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildHub, buildHubRelease, validateCollections } from "../../packages/project/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");

function makeHub() {
  const hub = mkdtempSync(join(tmpdir(), "ega-collections-"));
  mkdirSync(join(hub, "owned", "ega", "alpha"), { recursive: true });
  writeFileSync(join(hub, "owned", "ega", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: alpha collection test skill.\n---\n\nCollection body.\n");
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: collections-test\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hub;
}

function writeCollections(hub, text) {
  mkdirSync(join(hub, "intake"), { recursive: true });
  writeFileSync(join(hub, "intake", "collections.yaml"), text);
}

function validCollections(membership = "[engineering, testing]") {
  return `schema_version: 1\nrevision: 1\ncollections:\n  - key: engineering\n    label: Engineering\n  - key: testing\n    label: Testing\nmemberships:\n  ega/alpha: ${membership}\n`;
}

test("CL-01: moving browse membership preserves skill/version and release semantics", async (t) => {
  const hub = makeHub();
  t.after(() => rmSync(hub, { recursive: true, force: true }));
  writeCollections(hub, validCollections());

  const firstBuild = await buildHub(hub);
  const firstRelease = await buildHubRelease(hub);
  const first = await validateCollections(hub);
  assert.equal(first.payload.status, "VALID");
  assert.deepEqual(first.payload.memberships, { "ega/alpha": ["engineering", "testing"] });

  writeCollections(hub, validCollections("[engineering]").replace("revision: 1", "revision: 2"));
  const secondBuild = await buildHub(hub);
  const secondRelease = await buildHubRelease(hub);
  const second = JSON.parse(spawnSync(process.execPath, [cli, "hub", "collections", "validate", "--hub", hub], { encoding: "utf8" }).stdout);
  assert.equal(second.payload.status, "VALID");
  assert.deepEqual(second.payload.memberships, { "ega/alpha": ["engineering"] });
  assert.deepEqual(secondBuild.skills, firstBuild.skills);
  assert.equal(secondRelease.release.digest, firstRelease.release.digest);
});

test("CL-02: collection validation diagnoses cycles, unknown skills, and normalized duplicates", async (t) => {
  const hub = makeHub();
  t.after(() => rmSync(hub, { recursive: true, force: true }));
  writeCollections(hub, `schema_version: 1
revision: 3
collections:
  - key: Engineering
    label: Engineering
  - key: engineering
    label: Engineering duplicate
  - key: loop-a
    label: Loop A
    parent: loop-b
  - key: loop-b
    label: Loop B
    parent: loop-a
  - key: orphan
    label: Orphan
    parent: missing
memberships:
  ega/alpha: [engineering, engineering]
  missing/skill: [orphan]
`);

  const result = spawnSync(process.execPath, [cli, "hub", "collections", "validate", "--hub", hub], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.payload.status, "BLOCKED");
  const codes = new Set(document.payload.diagnostics.map((entry) => entry.code));
  assert.equal(codes.has("DUPLICATE_NORMALIZED_KEY"), true);
  assert.equal(codes.has("PARENT_CYCLE"), true);
  assert.equal(codes.has("UNKNOWN_SKILL_REFERENCE"), true);
  assert.equal(codes.has("UNKNOWN_PARENT"), true);
  assert.equal(codes.has("DUPLICATE_MEMBERSHIP"), true);
});
