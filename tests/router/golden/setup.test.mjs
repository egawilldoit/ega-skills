// Setup test for the golden router catalogs (TEST-001, EGA-580).
//
// Exercises golden-setup.mjs against the frozen golden-hashes.json:
//   - router-default builds exactly 16 current versions in a fresh temp home
//   - router-default-plus-experimental builds 17 (16 default + experimental)
//   - large-only builds 1, lexical-tie-only builds 2
//   - every built version hash equals the frozen golden-hashes.json entry
//   - smoke resolve through the PRODUCTION resolver: nextjs-web project +
//     task "Fix a hydration mismatch" must select ega/react-frontend
//
// Evidence-flow note: materializeSkill() emits routing fields in the SKILL.md
// frontmatter, but the production schema strips them at import (strict
// portableFrontmatterSchema) and the materialized ega.yaml carries only
// `schema_version: 1` — so this suite doubles as the probe for whether
// trigger/framework evidence survives into the resolver at all. The smoke
// assertion reports the ACTUAL selected list in its message on failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveSkills } from "../../../packages/router/dist/index.js";
import {
  buildGoldenProject,
  buildRegistryForCatalog,
} from "./golden-setup.mjs";

const GOLDEN_HASHES = JSON.parse(
  await readFile(new URL("./golden-hashes.json", import.meta.url), "utf8"),
);

const CATALOG_COUNTS = {
  "router-default": 16,
  "router-default-plus-experimental": 17,
  "large-only": 1,
  "lexical-tie-only": 2,
};

test("golden catalogs build exact current-version counts in isolated homes", async () => {
  for (const [catalogName, expected] of Object.entries(CATALOG_COUNTS)) {
    const { home, versionHashes } = await buildRegistryForCatalog(catalogName);
    assert.equal(
      Object.keys(versionHashes).length,
      expected,
      `${catalogName} current version count mismatch (home was fresh: ${home})`,
    );
  }
});

test("router-default holds exactly 16 current versions (helper-internal assert)", async () => {
  // The helper itself throws CATALOG_COUNT_INVALID if this ever breaks; a
  // passing build is the assertion. Build it twice to prove each call gets a
  // FRESH temp home with no cross-catalog leakage.
  const first = await buildRegistryForCatalog("router-default");
  const second = await buildRegistryForCatalog("router-default");
  assert.notEqual(first.home, second.home, "each build must get a fresh temp home");
});

test("all catalog version hashes equal the frozen golden-hashes.json", async () => {
  const mismatches = [];
  const catalogs = Object.keys(CATALOG_COUNTS);
  for (const catalogName of catalogs) {
    const { home, versionHashes } = await buildRegistryForCatalog(catalogName);
    for (const [fixtureId, computed] of Object.entries(versionHashes)) {
      const frozen = GOLDEN_HASHES[fixtureId]?.versionHash;
      if (frozen === undefined) {
        mismatches.push(`${catalogName}/${fixtureId}: missing from golden-hashes.json`);
      } else if (computed !== frozen) {
        mismatches.push(
          `${catalogName}/${fixtureId}: computed ${computed} !== frozen ${frozen} (home ${home})`,
        );
      }
    }
  }
  assert.deepEqual(mismatches, [], `golden versionHash divergence:\n${mismatches.join("\n")}`);
});

test("smoke: production resolver selects ega/react-frontend for nextjs-web + hydration mismatch", async () => {
  const { home } = await buildRegistryForCatalog("router-default");
  const { projectPath } = await buildGoldenProject("nextjs-web");

  const result = await resolveSkills({
    task: "Fix a hydration mismatch",
    projectPath,
    env: { ...process.env, EGA_SKILLS_HOME: home },
  });

  const selectedIds = result.selected.map((skill) => skill.id);
  assert.ok(
    selectedIds.includes("ega/react-frontend"),
    `smoke resolve did NOT select ega/react-frontend; selected = ${JSON.stringify(selectedIds)} ` +
      `(candidates = ${JSON.stringify(result.candidates.map((skill) => skill.id))}, ` +
      `projectFingerprint = ${JSON.stringify(result.projectFingerprint)})`,
  );
});