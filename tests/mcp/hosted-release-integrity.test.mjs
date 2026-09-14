import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import { loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";
import { sha256Hex } from "../../packages/hashing/dist/index.js";

const requireFromRegistry = createRequire(new URL("../../packages/registry/package.json", import.meta.url));
const Database = requireFromRegistry("better-sqlite3");

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-release-integrity-"));
  for (const name of ["alpha", "beta"]) {
    const skillDir = join(hubDir, "owned", "ega", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} integrity skill.\n---\n\nUse ${name}.\n`);
    writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${name}\naliases:\n  - ${name}-alias\n`);
  }
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: release-integrity\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

async function freshRelease() {
  const build = await buildHubRelease(makeHub());
  return build.registryHome;
}

function mutate(dbPath, statements) {
  const db = new Database(dbPath);
  try {
    db.exec("BEGIN");
    for (const statement of statements) db.prepare(statement.sql).run(...(statement.params ?? []));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function repackage(artifactDir) {
  const packagePath = join(artifactDir, "release-package.json");
  const releasePackage = JSON.parse(readFileSync(packagePath, "utf8"));
  releasePackage.sqlite_artifact_digest = `sha256:${sha256Hex(readFileSync(join(artifactDir, "registry.sqlite")))}`;
  writeFileSync(packagePath, `${JSON.stringify(releasePackage, null, 2)}\n`);
}

function expectSnapshotRejected(artifactDir, message) {
  assert.throws(() => loadHostedReleaseSnapshot(artifactDir), (error) => {
    assert.equal(error?.code, "E_SNAPSHOT_INVALID", `${message}: ${String(error)}`);
    return true;
  });
}

test("a valid built release loads", async () => {
  const artifactDir = await freshRelease();
  const snapshot = loadHostedReleaseSnapshot(artifactDir);
  assert.match(snapshot.releaseDigest, /^sha256:[0-9a-f]{64}$/);
});

test("tampered release FTS rows are rejected even with an updated package checksum", async () => {
  const artifactDir = await freshRelease();
  const snapshot = loadHostedReleaseSnapshot(artifactDir);
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE skill_fts SET description = 'tampered description' WHERE skill_id = 'ega/alpha'",
  }, {
    sql: `UPDATE ${snapshot.ftsTable} SET description = 'tampered description' WHERE skill_id = 'ega/alpha'`,
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "tampered FTS");
});

test("tampered runtime manifests are rejected even with an updated package checksum", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE skill_versions SET manifest_json = replace(manifest_json, 'alpha integrity skill', 'evil skill') WHERE skill_id = 'ega/alpha'",
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "tampered manifest");
});

test("a manifest-only portable.license tamper is rejected", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE skill_versions SET manifest_json = replace(manifest_json, '\"name\":\"alpha\"}', '\"name\":\"alpha\",\"license\":\"EVIL\"}') WHERE skill_id = 'ega/alpha'",
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "portable.license tamper");
});

test("a manifest-only routing.anti_triggers tamper is rejected", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE skill_versions SET manifest_json = replace(manifest_json, '\"anti_triggers\":[]', '\"anti_triggers\":[\"tampered\"]') WHERE skill_id = 'ega/alpha'",
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "anti_triggers tamper");
});

test("a manifest-only files[].content_kind tamper is rejected", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE skill_versions SET manifest_json = replace(manifest_json, '\"content_kind\":\"TEXT\"', '\"content_kind\":\"BINARY\"') WHERE skill_id = 'ega/alpha'",
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "content_kind tamper");
});

test("tampered token metadata is rejected even with an updated package checksum", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE token_counts SET token_count = token_count + 1",
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "tampered token counts");
});

test("an extra runtime skill is rejected even with an updated package checksum", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [
    { sql: "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES ('ega/extra', 'ega', 'extra', 'sha256:0000000000000000000000000000000000000000000000000000000000000000')" },
    { sql: "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level) VALUES ('ega/extra', 'sha256:0000000000000000000000000000000000000000000000000000000000000000', '{}', 'MISSING', 'NORMAL', 'UNKNOWN')" },
  ]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "extra skill");
});

test("a tampered alias table is rejected even with an updated package checksum", async () => {
  const artifactDir = await freshRelease();
  mutate(join(artifactDir, "registry.sqlite"), [{
    sql: "UPDATE skill_aliases SET skill_id = 'ega/beta' WHERE alias = 'alpha-alias'",
  }]);
  repackage(artifactDir);
  expectSnapshotRejected(artifactDir, "tampered aliases");
});

test("a missing content blob is rejected", async () => {
  const artifactDir = await freshRelease();
  const snapshot = loadHostedReleaseSnapshot(artifactDir);
  const db = new Database(join(artifactDir, "registry.sqlite"), { readonly: true });
  let blobHash;
  try {
    const row = db.prepare("SELECT blob_hash FROM skill_files WHERE skill_id = 'ega/alpha' AND path = 'SKILL.md'").get();
    blobHash = row.blob_hash;
  } finally {
    db.close();
  }
  const digest = blobHash.slice("sha256:".length);
  const blobPath = join(artifactDir, "cache", "sha256", digest.slice(0, 2), digest.slice(2));
  assert.equal(existsSync(blobPath), true);
  unlinkSync(blobPath);
  assert.equal(snapshot.releaseDigest.length > 0, true);
  expectSnapshotRejected(artifactDir, "missing blob");
});

test("a semantically identical SQLite rebuild with different bytes still loads", async () => {
  const artifactDir = await freshRelease();
  const dbPath = join(artifactDir, "registry.sqlite");
  const before = readFileSync(dbPath);
  const db = new Database(dbPath);
  try {
    db.pragma("page_size = 8192");
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  const after = readFileSync(dbPath);
  assert.notDeepEqual(after, before, "VACUUM with a new page size must change the bytes");
  repackage(artifactDir);
  const snapshot = loadHostedReleaseSnapshot(artifactDir);
  assert.match(snapshot.releaseDigest, /^sha256:[0-9a-f]{64}$/);
  rmSync(artifactDir, { recursive: true, force: true });
});
