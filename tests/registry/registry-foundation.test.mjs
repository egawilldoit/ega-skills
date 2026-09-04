import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  openRegistry,
  resolveRegistryHome,
} from "../../packages/registry/dist/index.js";
import { assertFts5Available } from "../../packages/registry/dist/fts5.js";

const requireFromRegistry = createRequire(
  new URL("../../packages/registry/package.json", import.meta.url),
);
const Database = requireFromRegistry("better-sqlite3");
const tempRoots = new Set();

async function makeTempRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `ega-registry-${name}-`));
  tempRoots.add(root);
  return root;
}

function envFor(home) {
  return { EGA_SKILLS_HOME: home };
}

function requiredCoreTables(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all()
      .map(({ name }) => name),
  );
}

function insertSkillFixture(db, index) {
  const suffix = String(index).padStart(3, "0");
  const skillId = `bench/skill-${suffix}`;
  const versionHash = `sha256:${index.toString(16).padStart(64, "0")}`;
  const blobHash = `sha256:${(index + 1000).toString(16).padStart(64, "0")}`;

  db.prepare(
    "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES (?, ?, ?, ?)",
  ).run(skillId, "bench", `skill-${suffix}`, versionHash);
  db.prepare(
    "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class) VALUES (?, ?, ?, ?, ?)",
  ).run(skillId, versionHash, "{}", "MISSING", "NORMAL");
  db.prepare(
    "INSERT INTO skill_files (skill_id, version_hash, path, role, blob_hash, byte_size, content_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(skillId, versionHash, "SKILL.md", "skill-body", blobHash, 64, "TEXT");
  db.prepare(
    "INSERT INTO token_counts (blob_hash, estimator_id, token_count) VALUES (?, ?, ?)",
  ).run(blobHash, "ega-o200k-v1", 16);
  db.prepare("INSERT INTO skill_aliases (alias, skill_id) VALUES (?, ?)").run(
    `alias-${suffix}`,
    skillId,
  );
  db.prepare(
    "INSERT INTO skill_sources (skill_id, version_hash, source_type, local_path, repository, commit_sha, repository_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(skillId, versionHash, "local", `/fixture/skill-${suffix}`, null, null, null);
  db.prepare(
    "INSERT INTO skill_fts (skill_id, version_hash, name, description, domains, platforms, frameworks, triggers, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    skillId,
    versionHash,
    `skill-${suffix}`,
    `Representative skill ${suffix}`,
    "engineering",
    "cross-platform",
    "node",
    "representative benchmark",
    `alias-${suffix}`,
  );
}

test.after(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("default home resolves to ~/.ega-skills without touching the real home", () => {
  const resolved = resolveRegistryHome({}, "/virtual/user-home");
  assert.equal(resolved, join("/virtual/user-home", ".ega-skills"));
});

test("EGA_SKILLS_HOME creates an isolated registry home", async () => {
  const root = await makeTempRoot("home-create");
  const home = join(root, "isolated-home");
  const registry = openRegistry({ env: envFor(home) });
  registry.close();

  assert.equal((await stat(home)).isDirectory(), true);
  assert.equal(existsSync(join(home, "registry.sqlite")), true);
});

test("registry creates the frozen V1 directory layout", async () => {
  const root = await makeTempRoot("layout");
  const home = join(root, "home");
  const registry = openRegistry({ env: envFor(home) });
  registry.close();

  for (const directory of ["cache/sha256", "logs", "config"]) {
    assert.equal((await stat(join(home, directory))).isDirectory(), true, directory);
  }
  assert.equal((await stat(join(home, "registry.sqlite"))).isFile(), true);
});

test("two EGA_SKILLS_HOME overrides never share registry state", async () => {
  const root = await makeTempRoot("override-isolation");
  const homeA = join(root, "a");
  const homeB = join(root, "b");

  const a = openRegistry({ env: envFor(homeA) });
  a.db.prepare("INSERT INTO token_counts (blob_hash, estimator_id, token_count) VALUES (?, ?, ?)").run(
    `sha256:${"a".repeat(64)}`,
    "ega-o200k-v1",
    7,
  );
  a.close();

  const b = openRegistry({ env: envFor(homeB) });
  const count = b.db.prepare("SELECT count(*) AS count FROM token_counts").get().count;
  b.close();

  assert.equal(count, 0);
  assert.notEqual(join(homeA, "registry.sqlite"), join(homeB, "registry.sqlite"));
});

test("fresh registry creates a real SQLite database at the current schema version", async () => {
  const root = await makeTempRoot("fresh-db");
  const home = join(root, "home");
  const registry = openRegistry({ env: envFor(home) });

  assert.equal(registry.db.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
  assert.equal(registry.paths.database, join(home, "registry.sqlite"));
  registry.close();
});

test("fresh migrations create every frozen V1 table", async () => {
  const root = await makeTempRoot("fresh-migration");
  const registry = openRegistry({ env: envFor(join(root, "home")) });
  const tables = requiredCoreTables(registry.db);

  for (const table of [
    "skills",
    "skill_versions",
    "skill_files",
    "token_counts",
    "skill_aliases",
    "skill_sources",
    "skill_fts",
  ]) {
    assert.equal(tables.has(table), true, `missing table ${table}`);
  }
  registry.close();
});

test("reopening an existing registry preserves state without rerunning migration 1", async () => {
  const root = await makeTempRoot("reopen");
  const home = join(root, "home");
  const first = openRegistry({ env: envFor(home) });
  first.db.prepare("INSERT INTO token_counts (blob_hash, estimator_id, token_count) VALUES (?, ?, ?)").run(
    `sha256:${"b".repeat(64)}`,
    "ega-o200k-v1",
    11,
  );
  first.close();

  const second = openRegistry({ env: envFor(home) });
  assert.equal(second.db.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
  assert.equal(
    second.db.prepare("SELECT token_count FROM token_counts WHERE estimator_id = ?").get("ega-o200k-v1")
      .token_count,
    11,
  );
  second.close();
});

test("startup verifies FTS5 and migration uses the frozen tokenizer", async () => {
  const root = await makeTempRoot("fts5");
  const registry = openRegistry({ env: envFor(join(root, "home")) });
  assert.doesNotThrow(() => assertFts5Available(registry.db));

  const sql = registry.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skill_fts'")
    .get().sql;
  assert.match(sql, /fts5/i);
  assert.match(sql, /unicode61\s+remove_diacritics\s+1/i);
  registry.close();
});

test("FTS5 probe failure maps exactly to E_REGISTRY_FTS5_UNAVAILABLE", async () => {
  const root = await makeTempRoot("fts5-missing");
  const db = new Database(join(root, "probe.sqlite"));
  assert.throws(
    () => assertFts5Available(db, "ega_missing_fts5_module"),
    (error) => error?.code === "E_REGISTRY_FTS5_UNAVAILABLE",
  );
  db.close();
});

test("newer on-disk schema is rejected with E_REGISTRY_SCHEMA_NEWER", async () => {
  const root = await makeTempRoot("newer-schema");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const db = new Database(join(home, "registry.sqlite"));
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  db.close();

  assert.throws(
    () => openRegistry({ env: envFor(home) }),
    (error) => error?.code === "E_REGISTRY_SCHEMA_NEWER",
  );
});

test("migration failures map exactly to E_REGISTRY_MIGRATION", async () => {
  const root = await makeTempRoot("migration-error");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const db = new Database(join(home, "registry.sqlite"));
  db.exec("CREATE TABLE skills (unexpected TEXT NOT NULL)");
  db.pragma("user_version = 0");
  db.close();

  assert.throws(
    () => openRegistry({ env: envFor(home) }),
    (error) => error?.code === "E_REGISTRY_MIGRATION",
  );
});

test("database-open failures map exactly to E_REGISTRY_DB_OPEN", async () => {
  const root = await makeTempRoot("db-open-error");
  const home = join(root, "home");
  await mkdir(join(home, "registry.sqlite"), { recursive: true });

  assert.throws(
    () => openRegistry({ env: envFor(home) }),
    (error) => error?.code === "E_REGISTRY_DB_OPEN",
  );
});

test("home creation failures map exactly to E_REGISTRY_HOME", async () => {
  const root = await makeTempRoot("home-error");
  const blockingFile = join(root, "not-a-directory");
  await writeFile(blockingFile, "blocked", "utf8");

  assert.throws(
    () => openRegistry({ env: envFor(join(blockingFile, "child")) }),
    (error) => error?.code === "E_REGISTRY_HOME",
  );
});

test("foreign keys are enabled and reject orphan alias rows", async () => {
  const root = await makeTempRoot("foreign-keys");
  const registry = openRegistry({ env: envFor(join(root, "home")) });

  assert.equal(registry.db.pragma("foreign_keys", { simple: true }), 1);
  assert.throws(() =>
    registry.db.prepare("INSERT INTO skill_aliases (alias, skill_id) VALUES (?, ?)").run(
      "orphan-alias",
      "missing/skill",
    ),
  );
  registry.close();
});

test("foundation creates the expected relational indexes and global alias uniqueness", async () => {
  const root = await makeTempRoot("indexes");
  const registry = openRegistry({ env: envFor(join(root, "home")) });
  const indexes = new Set(
    registry.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
      .all()
      .map(({ name }) => name),
  );

  for (const index of [
    "idx_skills_name",
    "idx_skill_versions_version_hash",
    "idx_skill_files_blob_hash",
    "idx_skill_aliases_skill_id",
    "idx_skill_sources_version",
  ]) {
    assert.equal(indexes.has(index), true, `missing index ${index}`);
  }

  const aliasIndexes = registry.db.pragma("index_list('skill_aliases')");
  assert.equal(aliasIndexes.some(({ unique }) => unique === 1), true);
  registry.close();
});

test("no V1 table requires or exposes a display_name column", async () => {
  const root = await makeTempRoot("no-display-name");
  const registry = openRegistry({ env: envFor(join(root, "home")) });

  for (const table of [
    "skills",
    "skill_versions",
    "skill_files",
    "token_counts",
    "skill_aliases",
    "skill_sources",
    "skill_fts",
  ]) {
    const columns = registry.db.pragma(`table_info('${table}')`).map(({ name }) => name);
    assert.equal(columns.includes("display_name"), false, table);
  }
  registry.close();
});

test("skill_versions stores trust_level NOT NULL with default UNKNOWN", async () => {
  const root = await makeTempRoot("trust-default");
  const registry = openRegistry({ env: envFor(join(root, "home")) });
  const skillId = "owned-by-nobody/trust-test";
  const versionHash = `sha256:${"c".repeat(64)}`;

  registry.db.exec("BEGIN");
  try {
    registry.db
      .prepare("INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES (?, ?, ?, ?)")
      .run(skillId, "owned-by-nobody", "trust-test", versionHash);
    registry.db
      .prepare(
        "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class) VALUES (?, ?, ?, ?, ?)",
      )
      .run(skillId, versionHash, "{}", "MISSING", "NORMAL");
    registry.db.exec("COMMIT");
  } catch (error) {
    registry.db.exec("ROLLBACK");
    throw error;
  }

  const row = registry.db
    .prepare("SELECT trust_level FROM skill_versions WHERE skill_id = ? AND version_hash = ?")
    .get(skillId, versionHash);
  assert.equal(row.trust_level, "UNKNOWN");

  const trustColumn = registry.db
    .pragma("table_info('skill_versions')")
    .find(({ name }) => name === "trust_level");
  assert.equal(trustColumn.notnull, 1);
  assert.match(String(trustColumn.dflt_value), /UNKNOWN/);
  registry.close();
});

test("concurrent isolated homes do not cross-write", async () => {
  const root = await makeTempRoot("concurrent-homes");
  const homes = Array.from({ length: 8 }, (_, index) => join(root, `home-${index}`));

  await Promise.all(
    homes.map(async (home, index) => {
      await new Promise((resolve) => setImmediate(resolve));
      const registry = openRegistry({ env: envFor(home) });
      registry.db
        .prepare("INSERT INTO token_counts (blob_hash, estimator_id, token_count) VALUES (?, ?, ?)")
        .run(`sha256:${index.toString(16).padStart(64, "0")}`, `fixture-${index}`, index);
      registry.close();
    }),
  );

  for (const [index, home] of homes.entries()) {
    const registry = openRegistry({ env: envFor(home) });
    const rows = registry.db.prepare("SELECT estimator_id FROM token_counts").all();
    assert.deepEqual(rows, [{ estimator_id: `fixture-${index}` }]);
    registry.close();
  }
});

test("representative 100-skill registry opens within the 250 ms target", async (t) => {
  const root = await makeTempRoot("open-benchmark");
  const home = join(root, "home");
  const registry = openRegistry({ env: envFor(home) });

  registry.db.exec("BEGIN");
  try {
    for (let index = 0; index < 100; index += 1) insertSkillFixture(registry.db, index);
    registry.db.exec("COMMIT");
  } catch (error) {
    registry.db.exec("ROLLBACK");
    throw error;
  }
  registry.close();

  const warmup = openRegistry({ env: envFor(home) });
  warmup.close();

  const started = performance.now();
  const reopened = openRegistry({ env: envFor(home) });
  const elapsedMs = performance.now() - started;
  reopened.close();

  t.diagnostic(`100-skill registry open: ${elapsedMs.toFixed(2)} ms`);
  assert.ok(elapsedMs <= 250, `registry open took ${elapsedMs.toFixed(2)} ms (> 250 ms)`);
});
