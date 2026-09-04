// SPEC-005 §5.1.9–§5.1.10 eligible-catalog lock generation/refresh (EGA-585).
//
// Exercises refreshLock end-to-end against REAL isolated temp registries
// (EGA_SKILLS_HOME) populated through the production importer (importSkills):
//   - eligible catalog is exactly {every current local version} minus the
//     §5.1.7 policy (namespaces.allow / namespaces.deny / skills.deny),
//     with skills.prefer NEVER filtering and routing fields never entering
//     eligibility;
//   - the emitted lock matches the §5.1.9 schema (sorted keys, name ==
//     portable-name component, version_hash == current version hash,
//     generated_from.config_hash == §5.1.8 hash) and round-trips through
//     validateLockfile;
//   - diff plus/minus/tilde (+/-/~) is exact and deterministically sorted,
//     both from a hand-built previous lock and from a real re-imported
//     version change;
//   - fail-closed integrity (§5.1.10 rule 4): corrupted cache blob →
//     E_CACHE_HASH_MISMATCH, dangling current pointer → E_VERSION_NOT_FOUND,
//     and a failed regeneration writes NOTHING;
//   - refreshLock never touches the network and honors only the explicit
//     registryHome parameter (never process.env.EGA_SKILLS_HOME).
//
// Tests import the built package (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RegistryError,
  getCurrentVersionHash,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";
import {
  E_CACHE_HASH_MISMATCH,
  E_VERSION_NOT_FOUND,
  hashNormalizedConfig,
  parseProjectConfig,
  refreshLock,
  validateLockfile,
} from "../../packages/project/dist/index.js";

const HEX_64_A = "ab".repeat(32); // a valid (unused) sha256 identity
const HEX_64_B = "cd".repeat(32); // a different valid (unused) sha256 identity

/** Isolated temp registry: registry opens against home; teardown closes + removes. */
function isolatedRegistry(t) {
  const base = mkdtempSync(join(tmpdir(), "ega-585-"));
  const home = join(base, "home");
  const src = join(base, "src");
  mkdirSync(src, { recursive: true });
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(() => {
    try {
      registry.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  return { registry, src, home };
}

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

/** Writes an authored skill root at dir/name (production importer reads it). */
function writeSkill(dir, name, options = {}) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name}.\n`;
  writeFileSync(join(root, "SKILL.md"), `${frontmatter(name, options.description ?? `${name} skill`)}${body}`);
  if (options.core !== undefined) {
    writeFileSync(join(root, "SKILL.core.md"), options.core);
  }
  writeFileSync(join(root, "ega.yaml"), options.egaYaml ?? `schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n`);
  return root;
}

async function importSkill(registry, src, name, namespace = "ega") {
  writeSkill(src, name);
  const summary = await importSkills(registry, { path: join(src, name), namespace });
  assert.deepEqual(summary, { imported: 1, unchanged: 0, failed: 0, failures: [] });
}

/** Recursive {relativePath: byteSize} snapshot; null when the dir is gone. */
function snapshotTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, rel);
      else out[rel] = statSync(full).size;
    }
  };
  walk(root, "");
  return out;
}

const configDefaults = () => parseProjectConfig("schema_version: 1\n");

test("SPEC-005 §5.1.10: eligible current catalog, exact lock shape, all-added diff, no writes", async (t) => {
  const { registry, src, home } = isolatedRegistry(t);
  await importSkill(registry, src, "alpha");
  await importSkill(registry, src, "beta");
  await importSkill(registry, src, "gamma");

  const expected = {
    "ega/alpha": getCurrentVersionHash(registry.db, "ega/alpha"),
    "ega/beta": getCurrentVersionHash(registry.db, "ega/beta"),
    "ega/gamma": getCurrentVersionHash(registry.db, "ega/gamma"),
  };

  const config = configDefaults();
  const configHash = hashNormalizedConfig(config);

  // Pure read: the registry home tree must be byte-identical before/after.
  const before = snapshotTree(home);
  const result = refreshLock({ registryHome: home, config });
  assert.deepEqual(snapshotTree(home), before, "refreshLock must never write anything");

  const { lock, diff } = result;
  assert.equal(lock.lockfile_version, 1);
  assert.equal(lock.token_estimator, "ega-o200k-v1");
  assert.equal(lock.generated_from.config_hash, configHash);

  // One entry per eligible canonical skill, keys sorted ascending, each at
  // EXACTLY its current version hash with name == portable-name component.
  assert.deepEqual(Object.keys(lock.skills), ["ega/alpha", "ega/beta", "ega/gamma"]);
  for (const [skillId, currentHash] of Object.entries(expected)) {
    const entry = lock.skills[skillId];
    assert.equal(entry.name, skillId.slice(skillId.indexOf("/") + 1));
    assert.equal(entry.version_hash, currentHash);
  }

  // All-added diff when no previous lock exists.
  assert.deepEqual(diff, {
    added: ["ega/alpha", "ega/beta", "ega/gamma"],
    removed: [],
    changed: [],
  });

  // The emitted lock is a valid V1 lockfile as-is (round-trip validation).
  const validated = validateLockfile(lock, configHash);
  assert.deepEqual(validated.skills, lock.skills);
  assert.deepEqual(Object.keys(validated.skills), Object.keys(lock.skills));
});

test("SPEC-005 §5.1.10 + §5.1.7: namespace allow/deny and skills.deny filtering", async (t) => {
  const { registry, src, home } = isolatedRegistry(t);
  await importSkill(registry, src, "alpha");
  await importSkill(registry, src, "beta");
  await importSkill(registry, src, "gamma");
  await importSkill(registry, src, "delta", "team");

  const ids = (result) => Object.keys(result.lock.skills);

  const cases = [
    {
      label: "namespaces.deny removes the whole namespace",
      yaml: "schema_version: 1\nnamespaces:\n  deny: [ega]\n",
      expected: ["team/delta"],
    },
    {
      label: "skills.deny removes exact canonical IDs only",
      yaml: "schema_version: 1\nskills:\n  deny: [ega/beta, ega/gamma]\n",
      expected: ["ega/alpha", "team/delta"],
    },
    {
      label: "namespaces.allow is a whitelist when non-empty",
      yaml: "schema_version: 1\nnamespaces:\n  allow: [team]\n",
      expected: ["team/delta"],
    },
    {
      label: "allow slash deny: deny always wins over allow",
      yaml: "schema_version: 1\nnamespaces:\n  allow: [ega, team]\n  deny: [team]\n",
      expected: ["ega/alpha", "ega/beta", "ega/gamma"],
    },
    {
      label: "non-installed policy targets are never an error (§5.1.6)",
      yaml: "schema_version: 1\nnamespaces:\n  deny: [ghost]\nskills:\n  deny: [ega/zeta]\n",
      expected: ["ega/alpha", "ega/beta", "ega/gamma", "team/delta"],
    },
  ];

  for (const { label, yaml, expected } of cases) {
    const config = parseProjectConfig(yaml);
    const result = refreshLock({ registryHome: home, config });
    assert.deepEqual(ids(result), expected, label);
    // Every filtered lock still validates as a V1 lockfile against ITS config.
    assert.deepEqual(
      validateLockfile(result.lock, hashNormalizedConfig(config)).skills,
      result.lock.skills,
      label,
    );
  }
});

test("SPEC-005 §5.1.10: prefer never filters; routing fields never enter eligibility", async (t) => {
  const { registry, src, home } = isolatedRegistry(t);
  await importSkill(registry, src, "alpha");
  await importSkill(registry, src, "beta");

  // prefer referencing an uninstalled skill must NOT pull it in and must
  // not error (policy never depends on the installation).
  const preferGhost = refreshLock({
    registryHome: home,
    config: parseProjectConfig("schema_version: 1\nskills:\n  prefer: [ega/ghost-skill]\n"),
  });
  assert.deepEqual(Object.keys(preferGhost.lock.skills), ["ega/alpha", "ega/beta"]);

  // prefer can NEVER rescue a skill removed by deny (namespace or skills).
  const preferVsDeny = refreshLock({
    registryHome: home,
    config: parseProjectConfig(
      "schema_version: 1\nskills:\n  prefer: [ega/beta]\n  deny: [ega/beta]\nnamespaces:\n  deny: [ega]\n",
    ),
  });
  assert.deepEqual(preferVsDeny.lock.skills, {});

  // Non-default routing fields affect the lock NOT at all: same eligible
  // catalog, same config hash identity for the same normalized config.
  const routingTuned = refreshLock({
    registryHome: home,
    config: parseProjectConfig("schema_version: 1\nrouting:\n  mode: suggest\n  max_skills: 1\n  max_tokens: 100\n"),
  });
  assert.deepEqual(Object.keys(routingTuned.lock.skills), ["ega/alpha", "ega/beta"]);
});

test("SPEC-005 §5.1.10 rule 6: diff plus/minus/tilde is exact and sorted", async (t) => {
  const { registry, src, home } = isolatedRegistry(t);
  await importSkill(registry, src, "alpha");
  await importSkill(registry, src, "beta");
  await importSkill(registry, src, "gamma");

  const config = configDefaults();
  const configHash = hashNormalizedConfig(config);
  const current = {
    alpha: getCurrentVersionHash(registry.db, "ega/alpha"),
    beta: getCurrentVersionHash(registry.db, "ega/beta"),
    gamma: getCurrentVersionHash(registry.db, "ega/gamma"),
  };

  // Hand-built previous lock (validated through the production validator):
  // alpha at a DIFFERENT (stale) hash -> tilde; gamma at the current hash ->
  // unchanged; ghost not installed -> minus; beta absent -> plus.
  const previousLock = validateLockfile(
    {
      lockfile_version: 1,
      token_estimator: "ega-o200k-v1",
      generated_from: { config_hash: configHash },
      skills: {
        "ega/alpha": { name: "alpha", version_hash: `sha256:${HEX_64_A}` },
        "ega/gamma": { name: "gamma", version_hash: current.gamma },
        "ega/ghost": { name: "ghost", version_hash: `sha256:${HEX_64_B}` },
      },
    },
    configHash,
  );

  const result = refreshLock({ registryHome: home, config }, previousLock);
  assert.deepEqual(result.diff, {
    added: ["ega/beta"],
    removed: ["ega/ghost"],
    changed: ["ega/alpha"],
  });
  assert.deepEqual(Object.keys(result.lock.skills), ["ega/alpha", "ega/beta", "ega/gamma"]);
  assert.equal(result.lock.skills["ega/alpha"].version_hash, current.alpha);
  assert.equal(result.lock.skills["ega/gamma"].version_hash, current.gamma);

  // Real version change through the production importer: re-importing the
  // edited alpha moves its current pointer, so the refresh reports ~alpha.
  writeSkill(src, "alpha", { body: "# alpha\n\nGuidance text for alpha.\n\n## Updated guidance\n" });
  const reimport = await importSkills(registry, { path: join(src, "alpha"), namespace: "ega" });
  assert.deepEqual(reimport, { imported: 1, unchanged: 0, failed: 0, failures: [] });
  const newAlphaHash = getCurrentVersionHash(registry.db, "ega/alpha");
  assert.notEqual(newAlphaHash, current.alpha);

  const refreshed = refreshLock({ registryHome: home, config }, result.lock);
  assert.deepEqual(refreshed.diff, {
    added: [],
    removed: [],
    changed: ["ega/alpha"],
  });
  assert.equal(refreshed.lock.skills["ega/alpha"].version_hash, newAlphaHash);
  assert.deepEqual(Object.keys(refreshed.lock.skills), ["ega/alpha", "ega/beta", "ega/gamma"]);
});

test("SPEC-005 §5.1.10 rule 4: fail-closed on corrupt/missing blob and dangling current pointer; nothing written", async (t) => {
  const { registry, src, home } = isolatedRegistry(t);
  await importSkill(registry, src, "alpha");
  await importSkill(registry, src, "beta");
  const config = configDefaults();

  const blobPath = (skillId, path) => {
    const row = registry.db
      .prepare("SELECT blob_hash FROM skill_files WHERE skill_id = ? AND path = ?")
      .get(skillId, path);
    assert.ok(row, `expected a skill_files row for ${skillId} ${path}`);
    const digest = row.blob_hash.slice("sha256:".length);
    return join(home, "cache", "sha256", digest.slice(0, 2), digest.slice(2));
  };

  const expectFailClosed = (fn, code, pattern) => {
    assert.throws(fn, (err) => {
      assert.ok(err instanceof RegistryError, `expected RegistryError, got ${err?.constructor?.name}: ${err?.message}`);
      assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
      assert.match(err.message, pattern);
      return true;
    });
  };

  // A REQUIRED blob whose bytes no longer match its hash fails the whole
  // regeneration with E_CACHE_HASH_MISMATCH (never silently omitted).
  const alphaSkillMd = blobPath("ega/alpha", "SKILL.md");
  writeFileSync(alphaSkillMd, "corrupted bytes that do not hash to the stored blob_hash");
  const before = snapshotTree(home);
  expectFailClosed(
    () => refreshLock({ registryHome: home, config }),
    E_CACHE_HASH_MISMATCH,
    /failed hash verification/,
  );
  assert.deepEqual(snapshotTree(home), before, "a failed regeneration must not write anything");

  // Restore alpha's blob through the production importer (content-addressed
  // write repairs the cache), so only beta is broken in each next scenario.
  rmSync(alphaSkillMd, { force: true });
  const repaired = await importSkills(registry, { path: join(src, "alpha"), namespace: "ega" });
  assert.deepEqual(repaired, { imported: 0, unchanged: 1, failed: 0, failures: [] });

  // A MISSING required blob is equally fail-closed.
  rmSync(blobPath("ega/beta", "SKILL.md"), { force: true });
  expectFailClosed(
    () => refreshLock({ registryHome: home, config }),
    E_CACHE_HASH_MISMATCH,
    /is missing/,
  );

  // Repair beta too, then leave a current_version_hash with NO matching
  // immutable skill_versions row (DB surgery: FK deferral is what makes this
  // state unreachable through the production importer). Fail-closed with
  // E_VERSION_NOT_FOUND — the broken skill is never silently omitted.
  const betaReimport = await importSkills(registry, { path: join(src, "beta"), namespace: "ega" });
  assert.deepEqual(betaReimport, { imported: 0, unchanged: 1, failed: 0, failures: [] });
  registry.db.exec("PRAGMA foreign_keys = OFF");
  registry.db.prepare("UPDATE skills SET current_version_hash = ? WHERE skill_id = ?").run(
    `sha256:${HEX_64_A}`,
    "ega/beta",
  );
  registry.db.exec("PRAGMA foreign_keys = ON");
  expectFailClosed(
    () => refreshLock({ registryHome: home, config }),
    E_VERSION_NOT_FOUND,
    /ega\/beta/,
  );
});

test("SPEC-005 §5.1.10: no network use; only the explicit registryHome is honored", async (t) => {
  const { registry, src, home } = isolatedRegistry(t);
  await importSkill(registry, src, "alpha");
  const config = configDefaults();

  // Any network attempt inside refreshLock must explode the test: the
  // refresh path is strictly local (sqlite + cache reads).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("refreshLock attempted network access");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // process.env.EGA_SKILLS_HOME must NEVER influence refreshLock — the
  // explicit registryHome parameter is authoritative for isolated registries.
  const originalEnv = process.env.EGA_SKILLS_HOME;
  process.env.EGA_SKILLS_HOME = join(tmpdir(), "ega-585-bogus-env-home");
  t.after(() => {
    if (originalEnv === undefined) delete process.env.EGA_SKILLS_HOME;
    else process.env.EGA_SKILLS_HOME = originalEnv;
  });

  const result = refreshLock({ registryHome: home, config });
  assert.deepEqual(Object.keys(result.lock.skills), ["ega/alpha"]);
  assert.equal(
    result.lock.skills["ega/alpha"].version_hash,
    getCurrentVersionHash(registry.db, "ega/alpha"),
  );
});