// Read-only runtime acceptance — Agent B task B12.
//
// Proves the MCP runtime cannot mutate any input it reads: registry.sqlite,
// cache blobs, the project config/lock, the source directory, and the release
// manifest. Every tree is hashed before and after full legacy AND modern
// sessions (all four tools, success and failure paths), including a WAL-mode
// registry variant that checks SQLite leaves no -wal/-shm artifacts behind.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashNormalizedConfig, parseProjectConfig } from "../../packages/project/dist/index.js";
import { buildEraArtifact, COMPANION_PATH, SKILL_CORE, SKILL_ID } from "./helpers/era-fixture.mjs";
import {
  createStdioTransport,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  productResult,
} from "./helpers/sdk-era-client.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");
const requireFromRegistry = createRequire(new URL("../../packages/registry/package.json", import.meta.url));
const Database = requireFromRegistry("better-sqlite3");

/** Recursive manifest: relative path -> sha256 for files, "dir" for directories. */
function treeManifest(dir, prefix = "") {
  const manifest = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      manifest[rel] = "dir";
      Object.assign(manifest, treeManifest(full, rel));
    } else {
      manifest[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  }
  return manifest;
}

function makeProject(versionHash) {
  const projectDir = mkdtempSync(join(tmpdir(), "ega-readonly-project-"));
  const configText = "schema_version: 1\nrouting:\n  max_skills: 2\n";
  writeFileSync(join(projectDir, ".egaskills.yaml"), configText);
  const configHash = hashNormalizedConfig(parseProjectConfig(configText));
  writeFileSync(
    join(projectDir, ".egaskills.lock"),
    "generated_from:\n" +
      `  config_hash: ${configHash}\n` +
      "lockfile_version: 1\n" +
      "skills:\n" +
      "  ega/alpha:\n" +
      "    name: alpha\n" +
      `    version_hash: ${versionHash}\n` +
      "token_estimator: ega-o200k-v1\n",
  );
  return projectDir;
}

function makeSourceCheckout() {
  const sourceDir = mkdtempSync(join(tmpdir(), "ega-readonly-source-"));
  mkdirSync(join(sourceDir, "skills", "alpha"), { recursive: true });
  writeFileSync(join(sourceDir, "skills", "alpha", "SKILL.md"), "upstream checkout bytes\n");
  writeFileSync(join(sourceDir, "skill-archive.tar"), Buffer.alloc(64, 7));
  return sourceDir;
}

async function runSessions(t, artifactDir, projectDir, versionHash) {
  for (const era of ["legacy", "modern"]) {
    const transport = createStdioTransport({
      bin: BIN,
      cwd: REPO_ROOT,
      env: { ...process.env, EGA_SKILLS_HOME: artifactDir },
    });
    const client = new EraClient({
      supportedProtocolVersions: [era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION],
    });
    await client.connect(transport);
    if (era === "modern") await client.negotiateModernOnly();
    else await client.initializeLegacy();

    const call = (name, args) =>
      client.request({ method: "tools/call", params: { name, arguments: args } });
    const base = { project_path: projectDir };
    const search = await call("search", { query: "alpha", ...base });
    assert.equal(search.isError, false, JSON.stringify(search));
    const found = productResult(search).results[0];
    assert.equal(found.skill_id, SKILL_ID);
    assert.equal(found.version_hash, versionHash);

    const resolve = await call("resolve", { task: "alpha", ...base });
    assert.equal(resolve.isError, false, JSON.stringify(resolve));
    const inspect = await call("inspect", { skill_id: SKILL_ID, version_hash: versionHash, ...base });
    assert.notEqual(inspect.isError, true, JSON.stringify(inspect));
    const l2 = await call("get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      ...base,
    });
    assert.equal(l2.isError, false, JSON.stringify(l2));
    const l1 = await call("get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L1",
      max_tokens: 4000,
      ...base,
    });
    assert.equal(productResult(l1).content, SKILL_CORE);
    const companion = await call("get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      file_path: COMPANION_PATH,
      ...base,
    });
    assert.notEqual(companion.isError, true, JSON.stringify(companion));

    const refused = await call("get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      file_path: "hub-release.json",
      ...base,
    });
    assert.equal(refused.isError, true);

    await client.close();
    assert.equal((await transport.waitForExit()).code, 0, transport.stderr());
  }
}

test("B12 read-only runtime: no input tree changes across legacy and modern sessions", async (t) => {
  const fixture = await buildEraArtifact();
  const projectDir = makeProject(fixture.versionHash);
  const sourceDir = makeSourceCheckout();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  const before = {
    artifact: treeManifest(fixture.artifactDir),
    project: treeManifest(projectDir),
    source: treeManifest(sourceDir),
    sqlite: statSync(join(fixture.artifactDir, "registry.sqlite")),
  };
  assert.equal(before.artifact["registry.sqlite"] !== undefined, true);

  await runSessions(t, fixture.artifactDir, projectDir, fixture.versionHash);

  const after = {
    artifact: treeManifest(fixture.artifactDir),
    project: treeManifest(projectDir),
    source: treeManifest(sourceDir),
    sqlite: statSync(join(fixture.artifactDir, "registry.sqlite")),
  };

  assert.deepEqual(after.artifact, before.artifact, "artifact tree must be byte-identical");
  assert.deepEqual(after.project, before.project, "project config/lock must be byte-identical");
  assert.deepEqual(after.source, before.source, "source checkout must be byte-identical");
  assert.equal(after.sqlite.mtimeMs, before.sqlite.mtimeMs, "registry.sqlite mtime must not change");
  assert.equal(after.sqlite.size, before.sqlite.size);

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(
      Object.keys(after.artifact).some((path) => path.endsWith(suffix)),
      false,
      `no ${suffix} artifact may remain after a read-only session`,
    );
  }

  // The release manifest identity is intact and still descriptive of the
  // bytes actually served.
  const release = JSON.parse(readFileSync(fixture.artifactPaths.release, "utf8"));
  assert.equal(release.digest, fixture.releaseDigest);
  assert.equal(release.payload.skill_versions[SKILL_ID], fixture.versionHash);
});

test("B12 WAL-mode artifact: the documented read-only open leaves no -wal/-shm behind", async (t) => {
  const fixture = await buildEraArtifact();
  const projectDir = makeProject(fixture.versionHash);
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Convert the artifact registry to WAL, checkpoint it clean, and rebind the
  // package digest so the artifact is valid again.
  const sqlitePath = join(fixture.artifactDir, "registry.sqlite");
  const db = new Database(sqlitePath);
  try {
    assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const packagePath = join(fixture.artifactDir, "release-package.json");
  const releasePackage = JSON.parse(readFileSync(packagePath, "utf8"));
  releasePackage.sqlite_artifact_digest = `sha256:${createHash("sha256").update(readFileSync(sqlitePath)).digest("hex")}`;
  writeFileSync(packagePath, `${JSON.stringify(releasePackage, null, 2)}\n`);

  // The snapshot loader must still accept the artifact.
  const before = treeManifest(fixture.artifactDir);
  assert.equal(
    Object.keys(before).some((path) => path.endsWith("-wal") || path.endsWith("-shm")),
    false,
    "a checkpointed WAL database starts with no sidecar files",
  );

  await runSessions(t, fixture.artifactDir, projectDir, fixture.versionHash);

  const after = treeManifest(fixture.artifactDir);
  assert.deepEqual(after, before, "WAL-mode registry bytes and sidecars must be unchanged");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(
      Object.keys(after).some((path) => path.endsWith(suffix)),
      false,
      `no ${suffix} artifact may remain after a read-only session`,
    );
  }
});
