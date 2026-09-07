import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  HubError,
  buildHub,
  checkAliasMap,
  checkSearchIndexInput,
  checkTokenArtifact,
  createReleaseFtsTable,
  deriveAliasMap,
  deriveSearchIndexInput,
  deriveTokenArtifact,
  digestStagedTree,
  parseSourcesYaml,
  queryReleaseFts,
  sourceConfigDigest,
  verifyReleaseCorpus,
} from "../../packages/project/dist/index.js";
import { openRegistry } from "../../packages/registry/dist/index.js";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/identities.js";

const registryRequire = createRequire(join(process.cwd(), "packages", "registry", "package.json"));
const Database = registryRequire("better-sqlite3");

function digestOf(value) {
  return `sha256:${sha256Hex(canonicalizeJson(value))}`;
}

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} skill for release-state tests.\n---\n\n${body}\n`;
}

function writeSkillFiles(base, skills) {
  for (const { name, body, dir, egaYaml } of skills) {
    const d = join(base, ...(dir ?? [name]).map((s) => s));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), skill(name, body));
    if (egaYaml) writeFileSync(join(d, "ega.yaml"), egaYaml);
  }
}

/**
 * Hub with owned ega/reviewer (alias code-review) + external plan
 * (alpha: alias alpha-fast + triggers/domains; beta: plain).
 * Lock digests are real.
 */
function setupStateHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-release-state-"));
  mkdirSync(join(hubDir, "owned", "ega", "reviewer"), { recursive: true });
  writeFileSync(join(hubDir, "owned", "ega", "reviewer", "SKILL.md"), skill("reviewer", "Review body."));
  writeFileSync(
    join(hubDir, "owned", "ega", "reviewer", "ega.yaml"),
    "schema_version: 1\naliases:\n  - code-review\ntriggers:\n  - review\n",
  );
  const treeBase = join(hubDir, "trees", "plan");
  writeSkillFiles(treeBase, [
    {
      body: "Alpha body.",
      dir: ["skills", "alpha"],
      egaYaml: "schema_version: 1\naliases:\n  - alpha-fast\ndomains:\n  - engineering\ntriggers:\n  - alpha\n  - testing\n",
      name: "alpha",
    },
    { body: "Beta body.", dir: ["skills", "beta"], name: "beta" },
  ]);
  writeFileSync(join(treeBase, "LICENSE"), "License.\n");
  const sourcesYaml =
    "schema_version: 1\nsources:\n  plan:\n    type: git\n    repository: https://example.com/plan\n    ref: main\n    namespace: plan\n    selection:\n      roots:\n        - skills/alpha\n        - skills/beta\n    provenance_files:\n      - LICENSE\n";
  writeFileSync(join(hubDir, "sources.yaml"), sourcesYaml);
  writeFileSync(
    join(hubDir, "hub.yaml"),
    "schema_version: 1\nhub:\n  id: personal\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal:\n  - source: plan\n",
  );
  const cfg = parseSourcesYaml(sourcesYaml).sources["plan"];
  const tree = digestStagedTree(treeBase, cfg.selection.roots);
  const lock = {
    schema_version: 1,
    sources: {
      plan: {
        source_config_digest: sourceConfigDigest(cfg),
        repository: "https://example.com/plan",
        requested_ref: "main",
        namespace: "plan",
        selection: { roots: ["skills/alpha", "skills/beta"] },
        provenance_files: ["LICENSE"],
        resolved_commit: "b".repeat(40),
        selected_skill_tree_digest: tree.treeDigest,
        vendored_snapshot_digest: tree.snapshotDigest,
        extraction_contract: 1,
      },
    },
  };
  writeFileSync(join(hubDir, "sources.lock.yaml"), JSON.stringify(lock, null, 2));
  return hubDir;
}

function codeOf(fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error("expected HubError, succeeded");
      },
      (e) => {
        assert.ok(e instanceof HubError, `expected HubError, got ${e}`);
        return e.code;
      },
    );
}

test("happy path derives release-scoped alias map, token artifact, and search input", async () => {
  const build = await buildHub(setupStateHub());
  const aliases = deriveAliasMap(build);
  assert.deepEqual(aliases, { aliases: { "alpha-fast": "plan/alpha", "code-review": "ega/reviewer" } });
  const tokens = deriveTokenArtifact(build);
  assert.equal(tokens.estimator, "ega-o200k-v1");
  assert.deepEqual(
    tokens.counts.map((c) => c.skill_id),
    ["ega/reviewer", "plan/alpha", "plan/beta"],
  );
  for (const c of tokens.counts) {
    assert.equal(c.level, "L2");
    assert.ok(Number.isInteger(c.tokens) && c.tokens > 0, `tokens for ${c.skill_id}`);
    assert.match(c.version_hash, /^sha256:[0-9a-f]{64}$/);
  }
  const versions = new Map(build.skills.map((s) => [s.skillId, s.versionHash]));
  for (const c of tokens.counts) assert.equal(c.version_hash, versions.get(c.skill_id));
  const input = deriveSearchIndexInput(build);
  assert.deepEqual(
    input.rows.map((r) => r.skill_id),
    ["ega/reviewer", "plan/alpha", "plan/beta"],
  );
  const alpha = input.rows.find((r) => r.skill_id === "plan/alpha");
  assert.deepEqual(alpha.aliases, ["alpha-fast"]);
  assert.deepEqual(alpha.domains, ["engineering"]);
  assert.deepEqual(alpha.triggers, ["alpha", "testing"]);
  const beta = input.rows.find((r) => r.skill_id === "plan/beta");
  assert.deepEqual(beta.aliases, []);
  // Pure checks accept the derived docs against the same catalog.
  checkAliasMap(aliases, build.skills.map((s) => s.skillId));
  checkTokenArtifact(tokens, Object.fromEntries(versions));
  checkSearchIndexInput(input);
});

test("derived state is deterministic (byte-identical digests)", async () => {
  const build = await buildHub(setupStateHub());
  const once = [
    digestOf(deriveAliasMap(build)),
    digestOf(deriveTokenArtifact(build)),
    digestOf(deriveSearchIndexInput(build)),
  ];
  const twice = [
    digestOf(deriveAliasMap(build)),
    digestOf(deriveTokenArtifact(build)),
    digestOf(deriveSearchIndexInput(build)),
  ];
  assert.deepEqual(once, twice);
});

test("alias targeting an unselected skill fails (E_ALIAS_SCOPE)", async () => {
  assert.equal(
    await codeOf(() => checkAliasMap({ aliases: { ghost: "zzz/gone" } }, ["ega/reviewer"])),
    "E_ALIAS_SCOPE",
  );
});

test("unsorted alias keys fail (E_ALIAS_SCOPE)", async () => {
  assert.equal(
    await codeOf(() =>
      checkAliasMap({ aliases: { "z-alias": "ega/reviewer", "a-alias": "ega/reviewer" } }, ["ega/reviewer"]),
    ),
    "E_ALIAS_SCOPE",
  );
});

test("token estimator mismatch fails (E_TOKEN_ARTIFACT)", async () => {
  const build = await buildHub(setupStateHub());
  const tokens = deriveTokenArtifact(build);
  assert.equal(
    await codeOf(() => checkTokenArtifact({ ...tokens, estimator: "other-v9" }, {})),
    "E_TOKEN_ARTIFACT",
  );
});

test("token coverage gap or extra row fails (E_TOKEN_ARTIFACT)", async () => {
  const build = await buildHub(setupStateHub());
  const tokens = deriveTokenArtifact(build);
  const versions = Object.fromEntries(build.skills.map((s) => [s.skillId, s.versionHash]));
  const missing = { ...tokens, counts: tokens.counts.slice(1) };
  assert.equal(await codeOf(() => checkTokenArtifact(missing, versions)), "E_TOKEN_ARTIFACT");
  const extra = {
    ...tokens,
    counts: [...tokens.counts, { skill_id: "zzz/extra", version_hash: tokens.counts[0].version_hash, level: "L2", tokens: 1 }],
  };
  assert.equal(await codeOf(() => checkTokenArtifact(extra, versions)), "E_TOKEN_ARTIFACT");
});

test("unsorted or duplicate search rows fail (E_SEARCH_INPUT)", async () => {
  const build = await buildHub(setupStateHub());
  const input = deriveSearchIndexInput(build);
  assert.equal(
    await codeOf(() => checkSearchIndexInput({ rows: [...input.rows].reverse() })),
    "E_SEARCH_INPUT",
  );
  assert.equal(
    await codeOf(() => checkSearchIndexInput({ rows: [...input.rows, input.rows[0]] })),
    "E_SEARCH_INPUT",
  );
});

test("missing token count in the build registry fails derivation (E_TOKEN_ARTIFACT)", async () => {
  const build = await buildHub(setupStateHub());
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: build.registryHome }, userHome: tmpdir() });
  try {
    registry.db.exec("DELETE FROM token_counts");
  } finally {
    registry.close();
  }
  assert.equal(await codeOf(() => deriveTokenArtifact(build)), "E_TOKEN_ARTIFACT");
});

test("release FTS corpus is isolated: R1 order invariant under R2", async () => {
  const build = await buildHub(setupStateHub());
  const r1 = deriveSearchIndexInput(build).rows;
  const db = new Database(":memory:");
  try {
    createReleaseFtsTable(db, "r1", r1);
    verifyReleaseCorpus(db, "r1", r1.length);
    const probe = "review OR testing OR alpha";
    const before = queryReleaseFts(db, "r1", probe);
    assert.ok(before.length > 0, "probe must match the R1 corpus");
    const r2 = [
      ...r1,
      {
        skill_id: "zzz/extra",
        version_hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        name: "extra",
        description: "Unrelated extra skill about gardening",
        domains: ["lifestyle"],
        platforms: ["other"],
        frameworks: [],
        triggers: ["gardening"],
        aliases: [],
      },
    ];
    createReleaseFtsTable(db, "r2", r2);
    const after = queryReleaseFts(db, "r1", probe);
    assert.deepEqual(after, before);
    verifyReleaseCorpus(db, "r1", r1.length);
  } finally {
    db.close();
  }
});

test("corpus row-count leak fails verification (E_SEARCH_ISOLATION)", async () => {
  const build = await buildHub(setupStateHub());
  const r1 = deriveSearchIndexInput(build).rows;
  const db = new Database(":memory:");
  try {
    createReleaseFtsTable(db, "r1", r1);
    db.prepare("DELETE FROM r1 WHERE skill_id = ?").run(r1[0].skill_id);
    assert.equal(await codeOf(() => verifyReleaseCorpus(db, "r1", r1.length)), "E_SEARCH_ISOLATION");
  } finally {
    db.close();
  }
});
