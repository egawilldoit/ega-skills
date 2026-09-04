// G040 golden import-integration test (TEST-001 §5.1.4, EGA-581).
//
// G040 (IMPORT_INTEGRATION / duplicate-alias-import) proves the frozen
// alias-collision contract end to end: skill-frontend-mobile-v1
// (ega/frontend-mobile) and skill-alias-conflict-v1
// (experimental/mobile-alias-conflict) both declare the canonical alias
// `mobile-ui`. Importing both into ONE fresh registry must fail the SECOND
// import with E_ALIAS_CONFLICT while the first skill stays current — in
// EITHER import order. Not a router scenario (never runs through
// runGoldenScenario / determinism x10).
//
// Materialization mirrors buildRegistryForCatalog (golden-setup.mjs):
// byte-deterministic fixture files, production-stripped SKILL.md frontmatter
// (routing relevance flows exclusively through ega.yaml), and the production
// importer with an explicit namespace per canonical id.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getAliasOwner,
  getCurrentVersion,
  importSkills,
  openRegistry,
} from "../../../packages/registry/dist/index.js";
import { SKILL_FIXTURES } from "./catalog-data.mjs";
import { materializeSkill } from "./skill-materialize.mjs";

const MOBILE_FIXTURE = "skill-frontend-mobile-v1"; // ega/frontend-mobile, alias mobile-ui
const CONFLICT_FIXTURE = "skill-alias-conflict-v1"; // experimental/mobile-alias-conflict, alias mobile-ui

/**
 * Reduce the materialized SKILL.md to production-valid portable frontmatter
 * (identical to golden-setup.mjs): the strict portableFrontmatterSchema
 * rejects the materializer's routing fields, so only name/description stay —
 * aliases reach the importer through ega.yaml.
 */
function productionSkillMd(skillMd) {
  const lines = skillMd.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) {
    throw new Error(`materialized SKILL.md lacks YAML frontmatter delimiters`);
  }
  const kept = lines
    .slice(1, end)
    .filter((line) => /^(name|description): /.test(line));
  return ["---", ...kept, ...lines.slice(end)].join("\n");
}

/**
 * Materialize one fixture into the shared temp tree and return its import
 * coordinates. Routed via the canonical id: namespace before `/`, portable
 * directory name after it.
 */
async function writeMaterializedSkill(base, fixtureId) {
  const fixture = SKILL_FIXTURES.find((entry) => entry.fixtureId === fixtureId);
  if (fixture === undefined) {
    throw new RangeError(`Unknown skill fixture id: ${fixtureId}`);
  }
  const slash = fixture.canonicalId.indexOf("/");
  const namespace = fixture.canonicalId.slice(0, slash);
  const name = fixture.canonicalId.slice(slash + 1);
  const root = join(base, "src", namespace, name);

  const materialized = materializeSkill(fixture);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), productionSkillMd(materialized.skillMd));
  if (materialized.coreMdOrNull !== null) {
    await writeFile(join(root, "SKILL.core.md"), materialized.coreMdOrNull);
  }
  await writeFile(join(root, "ega.yaml"), materialized.egaYaml);
  return { root, namespace };
}

/**
 * One fresh temp registry per subtest. Single owned teardown (EGA-565): the
 * registry MUST close before the temp tree is removed.
 */
async function freshRegistry(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-golden-g040-"));
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(async () => {
    try {
      registry.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  return { base, registry };
}

test("G040: mobile first — alias-conflict import fails E_ALIAS_CONFLICT, frontend-mobile stays current", async (t) => {
  const { base, registry } = await freshRegistry(t);
  const { db } = registry;

  const mobile = await writeMaterializedSkill(base, MOBILE_FIXTURE);
  const conflict = await writeMaterializedSkill(base, CONFLICT_FIXTURE);

  // First import: ega/frontend-mobile claims alias mobile-ui.
  const first = await importSkills(registry, { path: mobile.root, namespace: mobile.namespace });
  assert.equal(first.imported, 1, "mobile import must land exactly one version");
  assert.equal(first.failed, 0, `mobile import must not fail: ${JSON.stringify(first.failures)}`);
  assert.equal(getAliasOwner(db, "mobile-ui"), "ega/frontend-mobile");

  // Second import: experimental/mobile-alias-conflict collides on mobile-ui.
  const second = await importSkills(registry, { path: conflict.root, namespace: conflict.namespace });
  assert.equal(second.imported, 0, "conflicting import must land no version");
  assert.equal(second.failed, 1);
  assert.equal(second.failures.length, 1);
  assert.equal(
    second.failures[0].error,
    'Alias "mobile-ui" is already owned by "ega/frontend-mobile" and cannot map to "experimental/mobile-alias-conflict".',
  );

  // First remains current; the failed claimant left no current version and
  // the alias ownership never moved.
  const current = getCurrentVersion(db, "ega/frontend-mobile");
  assert.ok(
    typeof current.versionHash === "string" && current.versionHash.length > 0,
    "ega/frontend-mobile must remain current after the failed import",
  );
  assert.throws(
    () => getCurrentVersion(db, "experimental/mobile-alias-conflict"),
    /no current version/,
    "failed claimant must be fully rolled back (E_VERSION_NOT_FOUND)",
  );
  assert.equal(getAliasOwner(db, "mobile-ui"), "ega/frontend-mobile");
});

test("G040 reversed: alias-conflict first — mobile import fails E_ALIAS_CONFLICT, alias-conflict stays current", async (t) => {
  const { base, registry } = await freshRegistry(t);
  const { db } = registry;

  const conflict = await writeMaterializedSkill(base, CONFLICT_FIXTURE);
  const mobile = await writeMaterializedSkill(base, MOBILE_FIXTURE);

  // First import: experimental/mobile-alias-conflict claims alias mobile-ui.
  const first = await importSkills(registry, { path: conflict.root, namespace: conflict.namespace });
  assert.equal(first.imported, 1, "alias-conflict import must land exactly one version");
  assert.equal(first.failed, 0, `alias-conflict import must not fail: ${JSON.stringify(first.failures)}`);
  assert.equal(getAliasOwner(db, "mobile-ui"), "experimental/mobile-alias-conflict");

  // Second import: ega/frontend-mobile collides on mobile-ui.
  const second = await importSkills(registry, { path: mobile.root, namespace: mobile.namespace });
  assert.equal(second.imported, 0, "conflicting mobile import must land no version");
  assert.equal(second.failed, 1);
  assert.equal(second.failures.length, 1);
  assert.equal(
    second.failures[0].error,
    'Alias "mobile-ui" is already owned by "experimental/mobile-alias-conflict" and cannot map to "ega/frontend-mobile".',
  );

  // First remains current; the failed mobile claimant left no current
  // version and the alias ownership never moved.
  const current = getCurrentVersion(db, "experimental/mobile-alias-conflict");
  assert.ok(
    typeof current.versionHash === "string" && current.versionHash.length > 0,
    "experimental/mobile-alias-conflict must remain current after the failed import",
  );
  assert.throws(
    () => getCurrentVersion(db, "ega/frontend-mobile"),
    /no current version/,
    "failed mobile claimant must be fully rolled back (E_VERSION_NOT_FOUND)",
  );
  assert.equal(getAliasOwner(db, "mobile-ui"), "experimental/mobile-alias-conflict");
});