// Source-observation timestamps (AMEND-07, EGA-612).
//
// SPEC-003 §5.1.15 (as amended): every skill_sources row carries observed_at
// (ISO-8601 UTC record instant). Migration 002 backfills pre-existing rows
// with the migration instant; the importer and recordSourceObservation stamp
// new rows with the record instant. observed_at stays EXCLUDED from version
// identity (SPEC-002 untouched).
//
// Tests import the built packages (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  getCurrentVersionHash,
  getSkillVersion,
  importSkills,
  listVersionSources,
  openRegistry,
  recordSourceObservation,
  REGISTRY_MIGRATIONS,
} from "../../packages/registry/dist/index.js";

const requireFromRegistry = createRequire(
  new URL("../../packages/registry/package.json", import.meta.url),
);
const Database = requireFromRegistry("better-sqlite3");

const tempRoots = new Set();
function makeTempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `ega-sources-${name}-`));
  tempRoots.add(root);
  return root;
}
test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tempRoots.clear();
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function openHome(home) {
  return openRegistry({ env: { EGA_SKILLS_HOME: home } });
}

// --- Recording ---------------------------------------------------------------------

test("sources: recordSourceObservation stamps the record instant by default", () => {
  const home = makeTempRoot("stamp");
  const registry = openHome(home);
  try {
    registry.db.exec("BEGIN IMMEDIATE");
    registry.db.exec(
      "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level) VALUES ('ega/a', 'sha256:1', '{}', 'MISSING', 'NORMAL', 'UNKNOWN')",
    );
    registry.db.exec(
      "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES ('ega/a', 'ega', 'a', 'sha256:1')",
    );
    registry.db.exec("COMMIT");
    const before = new Date().toISOString();
    const { sourceId } = recordSourceObservation(registry.db, "ega/a", "sha256:1", {
      sourceType: "local",
      localPath: "/v1",
    });
    const after = new Date().toISOString();
    const [row] = listVersionSources(registry.db, "ega/a", "sha256:1");
    assert.equal(row.sourceId, sourceId);
    assert.match(row.observedAt ?? "", ISO_RE, "stored instant is ISO-8601 UTC");
    assert.ok(before <= row.observedAt && row.observedAt <= after, "stamp is the record moment");
  } finally {
    registry.close();
  }
});

test("sources: explicit observedAt is honored, malformed is rejected", () => {
  const home = makeTempRoot("explicit");
  const registry = openHome(home);
  try {
    registry.db.exec("BEGIN IMMEDIATE");
    registry.db.exec(
      "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level) VALUES ('ega/a', 'sha256:1', '{}', 'MISSING', 'NORMAL', 'UNKNOWN')",
    );
    registry.db.exec(
      "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES ('ega/a', 'ega', 'a', 'sha256:1')",
    );
    registry.db.exec("COMMIT");
    recordSourceObservation(registry.db, "ega/a", "sha256:1", {
      sourceType: "git",
      repository: "https://example.test/repo",
      observedAt: "2026-01-02T03:04:05.000Z",
    });
    const [row] = listVersionSources(registry.db, "ega/a", "sha256:1");
    assert.equal(row.observedAt, "2026-01-02T03:04:05.000Z");
    assert.throws(
      () =>
        recordSourceObservation(registry.db, "ega/a", "sha256:1", {
          sourceType: "local",
          observedAt: "not-a-timestamp",
        }),
      TypeError,
    );
  } finally {
    registry.close();
  }
});

// --- Migration -----------------------------------------------------------------------

/** Builds a version-1 registry file with one sourced version, bypassing openRegistry. */
function buildV1Home() {
  const home = makeTempRoot("v1home");
  const dbPath = join(home, "registry.sqlite");
  const db = new Database(dbPath);
  try {
    const initial = REGISTRY_MIGRATIONS.find((m) => m.version === 1);
    assert.ok(initial, "migration 001 exists");
    db.exec(initial.sql);
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level) VALUES ('ega/a', 'sha256:1', '{}', 'MISSING', 'NORMAL', 'UNKNOWN')",
    );
    db.exec(
      "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES ('ega/a', 'ega', 'a', 'sha256:1')",
    );
    db.exec("COMMIT");
    db.exec(
      "INSERT INTO skill_sources (skill_id, version_hash, source_type, local_path, repository, commit_sha, repository_path) VALUES ('ega/a', 'sha256:1', 'local', '/v1', NULL, NULL, NULL), ('ega/a', 'sha256:1', 'git', NULL, 'https://example.test/r', 'abc', 'x')",
    );
    db.pragma("user_version = 1");
  } finally {
    db.close();
  }
  return home;
}

test("sources: migration 002 backfills real instants without touching identity", () => {
  const home = buildV1Home();
  const registry = openHome(home);
  try {
    assert.equal(
      registry.db.pragma("user_version", { simple: true }),
      CURRENT_SCHEMA_VERSION,
      "v1 registry migrates to current on open",
    );
    assert.equal(CURRENT_SCHEMA_VERSION, 2);
    const sources = listVersionSources(registry.db, "ega/a", "sha256:1");
    assert.equal(sources.length, 2);
    for (const source of sources) {
      assert.match(source.observedAt ?? "", ISO_RE, "backfilled instant is ISO-8601 UTC");
    }
    // Identity untouched: version row and current pointer survive migration.
    const version = getSkillVersion(registry.db, "ega/a", "sha256:1");
    assert.equal(version.versionHash, "sha256:1");
    assert.equal(getCurrentVersionHash(registry.db, "ega/a"), "sha256:1");
    // Insertion order preserved among backfilled rows.
    assert.deepEqual(
      sources.map((s) => s.sourceType),
      ["local", "git"],
    );
    // Repeated reads are stable.
    assert.deepEqual(listVersionSources(registry.db, "ega/a", "sha256:1"), sources);
  } finally {
    registry.close();
  }
});

test("sources: fresh registries record importer instants; re-import adds no rows", async () => {
  const base = makeTempRoot("import");
  const home = join(base, "home");
  const src = join(base, "src", "a");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "SKILL.md"), "---\nname: a\ndescription: a skill\n---\n# a\n\nBody.\n");
  await writeFile(join(src, "ega.yaml"), "schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n");
  const before = new Date().toISOString();
  const first = openHome(home);
  let versionHash;
  try {
    const summary = await importSkills(first, { path: src, namespace: "ega" });
    assert.equal(summary.failed, 0);
    versionHash = getCurrentVersionHash(first.db, "ega/a");
  } finally {
    first.close();
  }
  const after = new Date().toISOString();
  const second = openHome(home);
  try {
    const secondSummary = await importSkills(second, { path: src, namespace: "ega" });
    assert.deepEqual(
      [secondSummary.imported, secondSummary.failed],
      [0, 0],
      "re-import is a no-op (dedup preserved)",
    );
    const sources = listVersionSources(second.db, "ega/a", versionHash);
    assert.equal(sources.length, 1, "no duplicate source rows on re-import");
    assert.match(sources[0].observedAt ?? "", ISO_RE);
    assert.ok(before <= sources[0].observedAt && sources[0].observedAt <= after);
  } finally {
    second.close();
  }
});
