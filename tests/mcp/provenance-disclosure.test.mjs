import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildHubRelease } from "../../packages/project/dist/index.js";
import { findAbsolutePaths, findHostAbsolutePaths } from "../helpers/absolute-path-detector.mjs";
import { buildMcpSession, buildHubFixture } from "./helpers/provenance-fixture.mjs";

/**
 * Machine-generated release documents. These carry only structural
 * provenance, so any absolute path in them is a defect.
 *
 * `search-index-input.json` and `token-artifact.json` are deliberately NOT in
 * this list: they embed authored skill descriptions, which may legitimately
 * contain slash-prefixed tokens such as "/technical-writing". They are covered
 * by the host-path assertion below instead, which is the actual disclosure
 * risk.
 */
const STRUCTURAL_RELEASE_FILES = [
  "hub-release.json",
  "release-package.json",
  "candidate.json",
  "release-diff.json",
  "alias-map.json",
];

function readSkillSources(artifactDir) {
  const Database = createRequire(join(process.cwd(), "packages", "registry", "package.json"))("better-sqlite3");
  const db = new Database(join(artifactDir, "registry.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT skill_id, source_type, local_path, repository, repository_path, commit_sha FROM skill_sources").all();
  } finally {
    db.close();
  }
}

test("exported registry stores no build-host absolute path in skill_sources", async (t) => {
  const fixture = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  const rows = readSkillSources(fixture.exportedDir);

  assert.equal(rows.length, 1, "fixture must import exactly one skill");
  for (const row of rows) {
    assert.deepEqual(
      findAbsolutePaths(row.local_path ?? ""),
      [],
      `skill_sources.local_path for ${row.skill_id} is a host absolute path: ${row.local_path}`,
    );
    assert.deepEqual(
      findHostAbsolutePaths(row.local_path ?? ""),
      [],
      `skill_sources.local_path for ${row.skill_id} discloses a build host: ${row.local_path}`,
    );
    assert.ok(
      (row.local_path ?? "").length > 0,
      "local_path must stay populated so the frozen inspect field keeps a value",
    );
  }
});

test("exported registry stores a deterministic, rebuild-stable logical path", async (t) => {
  const first = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  const second = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  const a = readSkillSources(first.exportedDir).map((r) => r.local_path);
  const b = readSkillSources(second.exportedDir).map((r) => r.local_path);
  // Two builds in two different temp directories must agree: a value that
  // carried the build host would differ between them.
  assert.deepEqual(a, b, "logical path must not depend on the build directory");
  assert.match(a[0], /^owned\/acme-owned\//, `expected a hub-relative owned path, got ${a[0]}`);
  assert.doesNotMatch(a[0], /ega-|worktree/i, "logical path must not embed a worktree name");
});

test("machine-generated release documents contain no absolute path of any style", async (t) => {
  const fixture = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  let scanned = 0;
  for (const name of STRUCTURAL_RELEASE_FILES) {
    const path = join(fixture.exportedDir, name);
    if (!existsSync(path)) continue;
    scanned += 1;
    const findings = findAbsolutePaths(readFileSync(path, "utf8"));
    assert.deepEqual(findings, [], `${name} contains an absolute path: ${JSON.stringify(findings.slice(0, 3))}`);
  }
  assert.ok(scanned > 0, "fixture must produce at least one structural release document");
});

test("no artifact file discloses a build host anywhere in its bytes", async (t) => {
  const fixture = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  for (const name of readdirSync(fixture.exportedDir)) {
    if (!name.endsWith(".json")) continue;
    const text = readFileSync(join(fixture.exportedDir, name), "utf8");
    const hostPaths = findHostAbsolutePaths(text);
    assert.deepEqual(
      hostPaths.map((f) => `${f.class}:${f.value}`),
      [],
      `${name} discloses a build-host path`,
    );
  }
});

test("inspect never returns an absolute build-host path in structuredContent", async (t) => {
  const fixture = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  const session = await buildMcpSession(t, fixture.exportedDir);
  const response = await session.call("inspect", { skill_id: "acme/widget" });
  const output = response.result.structuredContent;

  assert.equal(response.result.isError, false, JSON.stringify(response));
  assert.ok(Array.isArray(output.sources) && output.sources.length > 0, "expected at least one source");
  for (const source of output.sources) {
    assert.ok("local_path" in source, "the frozen local_path field must remain present");
    assert.deepEqual(
      findAbsolutePaths(source.local_path ?? ""),
      [],
      `inspect structuredContent disclosed a host path: ${source.local_path}`,
    );
  }
  assert.deepEqual(
    findAbsolutePaths(JSON.stringify(output)),
    [],
    "inspect structuredContent contains an absolute path somewhere",
  );
});

test("inspect text fallback never returns an absolute build-host path", async (t) => {
  const fixture = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  const session = await buildMcpSession(t, fixture.exportedDir);
  const response = await session.call("inspect", { skill_id: "acme/widget" });
  const text = response.result.content.map((c) => c.text).join("\n");

  assert.match(text, /inspect acme\/widget/, "fallback must still carry identity");
  assert.deepEqual(
    findAbsolutePaths(text),
    [],
    `inspect text fallback disclosed a host path: ${text}`,
  );
});

test("sanitizing the path preserves real source identity and lineage", async (t) => {
  const fixture = await buildHubFixture(t, { namespace: "acme", skill: "widget" });
  const row = readSkillSources(fixture.exportedDir)[0];
  assert.equal(row.skill_id, "acme/widget", "canonical Skill ID must survive");
  assert.equal(row.source_type, "local", "source type must survive");

  const release = JSON.parse(readFileSync(join(fixture.exportedDir, "hub-release.json"), "utf8"));
  assert.match(release.digest, /^sha256:[0-9a-f]{64}$/, "release digest must survive");
  const versionHash = release.payload.skill_versions["acme/widget"];
  assert.match(versionHash, /^sha256:[0-9a-f]{64}$/, "skill version hash must survive");

  // The lineage a consumer actually needs must still be resolvable.
  const session = await buildMcpSession(t, fixture.exportedDir);
  const inspected = await session.call("inspect", { skill_id: "acme/widget", version_hash: versionHash });
  const output = inspected.result.structuredContent;
  assert.equal(output.skill_id, "acme/widget");
  assert.equal(output.version_hash, versionHash, "inspect must resolve the preserved version hash");
  assert.equal(output.sources[0].observed_at !== null, true, "observation time must survive");
});
