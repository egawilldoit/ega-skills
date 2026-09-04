import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  buildMatchInput,
  normalizeSearchQuery,
  openRegistry,
  rebuildSkillFts,
  recordVersion,
  searchSkills,
  serializeFtsArray,
  upsertVersionFts,
} from "../../packages/registry/dist/index.js";

async function isolatedRegistry(t) {
  // Single owned teardown: SQLite MUST close before the temp dir is removed
  // (Windows EBUSY — see EGA-565). Never split into two t.after().
  const home = await mkdtemp(join(tmpdir(), "ega-569-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(async () => {
    try {
      registry.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  return registry;
}

const VA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function seed(db, skillId, versionHash, fields = {}) {
  recordVersion(db, {
    skillId,
    versionHash,
    manifestJson: "{}",
    l1Status: "MISSING",
    l2SizeClass: "NORMAL",
  });
  upsertVersionFts(db, {
    skillId,
    versionHash,
    name: skillId.split("/")[1],
    description: "",
    domains: [],
    platforms: [],
    frameworks: [],
    triggers: [],
    aliases: [],
    ...fields,
  });
}

function hits(db, query, options) {
  return searchSkills(db, query, options).map((h) => `${h.skillId}@${h.versionHash.slice(7, 15)}`);
}

// SPEC-003 §5.1.5 normalization.

// SPEC-003 §5.1.5: exact trim/extract/lowercase/dedupe contract.
test("SPEC-003 §5.1.5: query normalization is deterministic", () => {
  assert.deepEqual(normalizeSearchQuery("  Design DESIGN design  "), ["design"]);
  assert.deepEqual(normalizeSearchQuery("web-mobile_ui"), ["web", "mobile", "ui"]);
  assert.deepEqual(normalizeSearchQuery("say \"hi\" *:*"), ["say", "hi"]);
  assert.deepEqual(normalizeSearchQuery("   "), []);
  assert.deepEqual(normalizeSearchQuery("***"), []);
  assert.deepEqual(normalizeSearchQuery("Déjà VU déjà"), ["déjà", "vu"]);
  assert.deepEqual(normalizeSearchQuery("HELLO"), ["hello"]);
});

// SPEC-003 §5.1.5: per-term quote/escape with OR join; null when termless.
test("SPEC-003 §5.1.5: MATCH input quotes terms and OR-joins them", () => {
  assert.equal(buildMatchInput(["design", "mobile"]), '"design" OR "mobile"');
  assert.equal(buildMatchInput(['a"b']), '"a""b"');
  assert.equal(buildMatchInput([]), null);
});

test("SPEC-003 §5.1.5: routing arrays serialize newline-joined", () => {
  assert.equal(serializeFtsArray(["web", "mobile"]), "web\nmobile");
  assert.equal(serializeFtsArray([]), "");
});

// SPEC-003 §5.1.4 indexed columns + tokenizer.

// SPEC-003 §5.1.4–§5.1.5: frozen tokenizer and exact indexed columns.
test("SPEC-003 §5.1.4: FTS table uses the frozen tokenizer and columns", async (t) => {
  const registry = await isolatedRegistry(t);
  const ddl = registry.db
    .prepare("SELECT sql AS sql FROM sqlite_master WHERE name = 'skill_fts'")
    .get().sql;
  assert.ok(ddl.includes("tokenize = 'unicode61 remove_diacritics 1'"), "frozen tokenizer");
  for (const column of [
    "skill_id UNINDEXED",
    "version_hash UNINDEXED",
    "name",
    "description",
    "domains",
    "platforms",
    "frameworks",
    "triggers",
    "aliases",
  ]) {
    assert.ok(ddl.includes(column), `indexed column ${column}`);
  }
  for (const forbidden of ["anti_triggers", "body", "references", "assets", "scripts", "l1", "l2"]) {
    assert.ok(!ddl.toLowerCase().includes(forbidden), `must not index ${forbidden}`);
  }
});

// Diacritics folding proves remove_diacritics 1 is live (not just declared).
test("SPEC-003 §5.1.5: diacritics fold per the frozen tokenizer", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/cafe", VA, { description: "café au lait" });
  assert.deepEqual(hits(registry.db, "cafe"), ["ega/cafe@aaaaaaaa"]);
  assert.deepEqual(hits(registry.db, "café"), ["ega/cafe@aaaaaaaa"]);
});

// SPEC-003 §5.1.4: bodies are never searchable (no body field exists to index).
test("SPEC-003 §5.1.4: L1/L2 bodies are not indexed", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/a", VA, { description: "visible routing text" });
  assert.deepEqual(hits(registry.db, "visible"), ["ega/a@aaaaaaaa"]);
  assert.deepEqual(hits(registry.db, "quasitransmigration"), []);
});

// SPEC-003 §5.1.5: injection-like input cannot alter MATCH syntax.
test("SPEC-003 §5.1.5: injection-like queries stay parameterized", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/design", VA, { description: "design tokens" });
  seed(registry.db, "ega/other", VA, { description: "unrelated words here" });
  // Pure syntax matches nothing (no lexical terms, no MATCH executed).
  assert.deepEqual(hits(registry.db, "*"), []);
  assert.deepEqual(hits(registry.db, '" OR "'), []);
  // A hostile query behaves EXACTLY like its benign term equivalent.
  assert.deepEqual(hits(registry.db, "design) OR (1=1"), hits(registry.db, "design or 1"));
  assert.deepEqual(hits(registry.db, "skill_id:ega/design"), hits(registry.db, "skill id ega design"));
  // Column-filter syntax cannot restrict to one skill.
  assert.ok(hits(registry.db, "skill_id:ega/design").length >= 1);
  assert.deepEqual(hits(registry.db, 'design"'), hits(registry.db, "design"));
});

// SPEC-003 §5.1.5–§5.1.6 ordering and rebuild.

// SPEC-003 §5.1.6: exact lexical ties are stable by (skill_id, version_hash).
test("SPEC-003 §5.1.6: lexical ties break by skill_id then version_hash", async (t) => {
  const registry = await isolatedRegistry(t);
  const text = { description: "identical tie text" };
  seed(registry.db, "ega/zeta", VA, text);
  seed(registry.db, "ega/alpha", VA, text);
  seed(registry.db, "ega/mid", VA, text);
  assert.deepEqual(hits(registry.db, "identical"), [
    "ega/alpha@aaaaaaaa",
    "ega/mid@aaaaaaaa",
    "ega/zeta@aaaaaaaa",
  ]);
  // Same-skill version tie under a locked pair orders by version_hash.
  seed(registry.db, "ega/alpha", VB, text);
  const locked = new Map([
    ["ega/alpha", VA],
    ["ega/zeta", VA],
  ]);
  assert.deepEqual(hits(registry.db, "identical", { locked }), [
    "ega/alpha@aaaaaaaa",
    "ega/zeta@aaaaaaaa",
  ]);
  // Deterministic across repeated runs.
  assert.deepEqual(hits(registry.db, "identical"), hits(registry.db, "identical"));
});

// SPEC-003 §5.1.5: rebuild is deterministic regardless of input order.
test("SPEC-003 §5.1.5: full rebuild produces the same relative order", async (t) => {
  const registry = await isolatedRegistry(t);
  const rows = ["one", "two", "three", "four", "five"].map((name, i) => ({
    skillId: `ega/${name}`,
    versionHash: VA,
    name,
    description: `shared rebuild vocabulary ${i % 2 === 0 ? "even" : "odd"}`,
    domains: [],
    platforms: [],
    frameworks: [],
    triggers: [],
    aliases: [],
  }));
  for (const row of rows) {
    recordVersion(registry.db, {
      skillId: row.skillId,
      versionHash: row.versionHash,
      manifestJson: "{}",
      l1Status: "MISSING",
      l2SizeClass: "NORMAL",
    });
    upsertVersionFts(registry.db, row);
  }
  const before = hits(registry.db, "shared");
  rebuildSkillFts(registry.db, [...rows].reverse());
  const after = hits(registry.db, "shared");
  assert.deepEqual(after, before);
  rebuildSkillFts(registry.db, rows);
  assert.deepEqual(hits(registry.db, "shared"), before);
});

// SPEC-003 §5.1.6 visibility.

// SPEC-003 §5.1.6: unlocked search exposes ONLY current-version rows.
test("SPEC-003 §5.1.6: historical rows never compete in unlocked search", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/a", VA, { description: "old words current elsewhere" });
  seed(registry.db, "ega/a", VB, { description: "new words current here" });
  // "old" exists only in the historical row: invisible when unlocked.
  assert.deepEqual(hits(registry.db, "old"), []);
  assert.deepEqual(hits(registry.db, "new"), ["ega/a@bbbbbbbb"]);
});

// SPEC-003 §5.1.6: locked search exposes ONLY exact locked-version rows.
test("SPEC-003 §5.1.6: locked search exposes exact locked versions", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/a", VA, { description: "old words pinned" });
  seed(registry.db, "ega/a", VB, { description: "new words current" });
  seed(registry.db, "ega/b", VA, { description: "old words elsewhere" });
  const locked = new Map([["ega/a", VA]]);
  assert.deepEqual(hits(registry.db, "old", { locked }), ["ega/a@aaaaaaaa"]);
  assert.deepEqual(hits(registry.db, "new", { locked }), []);
  assert.deepEqual(hits(registry.db, "old", { locked: new Map() }), []);
});

// SPEC-003 §5.1.6: a normal import mutates only the exact version FTS row.
test("SPEC-003 §5.1.6: import mutates only the exact version FTS row", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/a", VA, { description: "alpha row text" });
  const count = (v) =>
    registry.db
      .prepare("SELECT COUNT(*) AS n FROM skill_fts WHERE skill_id = 'ega/a' AND version_hash = ?")
      .get(v).n;
  assert.equal(count(VA), 1);
  // A real import records the new version (moving current) and upserts its
  // exact FTS row in the same per-skill flow.
  recordVersion(registry.db, {
    skillId: "ega/a",
    versionHash: VB,
    manifestJson: "{}",
    l1Status: "MISSING",
    l2SizeClass: "NORMAL",
  });
  upsertVersionFts(registry.db, {
    skillId: "ega/a",
    versionHash: VB,
    name: "a",
    description: "beta row text",
    domains: [],
    platforms: [],
    frameworks: [],
    triggers: [],
    aliases: [],
  });
  assert.equal(count(VA), 1);
  assert.equal(count(VB), 1);
  assert.deepEqual(hits(registry.db, "alpha"), []);
  assert.deepEqual(hits(registry.db, "beta"), ["ega/a@bbbbbbbb"]);
  // Re-upserting the same version keeps exactly one row.
  upsertVersionFts(registry.db, {
    skillId: "ega/a",
    versionHash: VB,
    name: "a",
    description: "beta row text revised",
    domains: [],
    platforms: [],
    frameworks: [],
    triggers: [],
    aliases: [],
  });
  assert.equal(count(VB), 1);
});

// Routing arrays index every element; stored newline-joined.
test("SPEC-003 §5.1.5: routing arrays index newline-joined in canonical order", async (t) => {
  const registry = await isolatedRegistry(t);
  seed(registry.db, "ega/a", VA, {
    domains: ["web", "mobile"],
    triggers: ["deploy app"],
    aliases: ["ship", "launch"],
  });
  assert.deepEqual(hits(registry.db, "mobile"), ["ega/a@aaaaaaaa"]);
  assert.deepEqual(hits(registry.db, "launch"), ["ega/a@aaaaaaaa"]);
  const stored = registry.db
    .prepare("SELECT domains AS d, aliases AS a FROM skill_fts WHERE skill_id = 'ega/a'")
    .get();
  assert.equal(stored.d, "web\nmobile");
  assert.equal(stored.a, "ship\nlaunch");
});

// SPEC-003 §5.1.5: warm p95 target on a 100-skill reference registry.
test("SPEC-003 §5.1.5: warm 100-skill search trends toward p95 <= 100 ms", async (t) => {
  const registry = await isolatedRegistry(t);
  for (let i = 0; i < 100; i += 1) {
    const suffix = String(i).padStart(3, "0");
    seed(registry.db, `bench/skill-${suffix}`, VA, {
      description: `benchmark skill ${suffix} shared vocabulary`,
      domains: ["engineering"],
      triggers: [`trigger-${suffix}`],
    });
  }
  assert.ok(hits(registry.db, "shared").length > 0);
  const samples = [];
  for (let i = 0; i < 50; i += 1) {
    const start = performance.now();
    searchSkills(registry.db, "shared vocabulary");
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  console.log(`ℹ warm FTS search p95 over 50 runs: ${p95.toFixed(2)} ms`);
  assert.ok(p95 <= 100, `warm FTS p95 was ${p95.toFixed(2)} ms`);
});
