import assert from "node:assert/strict";
import test from "node:test";

import { SKILL_FIXTURES } from "./catalog-data.mjs";
import {
  EGA_O200K_V1_ESTIMATOR_ID,
  assertTokenEstimatorId,
  parseEgaMetadata,
} from "../../../packages/schema/dist/index.js";
import {
  countContentTokens,
  materializeSkill,
} from "./skill-materialize.mjs";

/** Sort UTF-16 like parseEgaMetadata's sortUtf16. */
function sortedUtf16(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Canonical identifier form: trim, lowercase, unique (parseEgaMetadata). */
function canonicalIdentifiers(values) {
  return sortedUtf16(new Set(values.map((v) => v.trim().toLowerCase())));
}

/** Canonical trigger form: LF-only, trim, unique (parseEgaMetadata). */
function canonicalTriggers(values) {
  return sortedUtf16(
    new Set(values.map((v) => v.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim())),
  );
}

test("TEST-001: all 20 fixtures materialize deterministically (byte-identical twice)", () => {
  assert.equal(SKILL_FIXTURES.length, 20);
  for (const entry of SKILL_FIXTURES) {
    const first = materializeSkill(entry);
    const second = materializeSkill(entry);
    assert.equal(
      first.skillMd,
      second.skillMd,
      `skillMd not byte-identical for ${entry.fixtureId}`,
    );
    assert.equal(
      first.coreMdOrNull,
      second.coreMdOrNull,
      `coreMdOrNull not byte-identical for ${entry.fixtureId}`,
    );
    assert.equal(
      first.egaYaml,
      second.egaYaml,
      `egaYaml not byte-identical for ${entry.fixtureId}`,
    );
    const name = entry.canonicalId.slice(entry.canonicalId.indexOf("/") + 1);
    assert.ok(
      first.skillMd.startsWith(`---\nname: ${name}\n`),
      `skillMd must declare portable name ${name} for ${entry.fixtureId}`,
    );
    for (const trigger of entry.triggers) {
      assert.ok(
        first.skillMd.includes(trigger),
        `skillMd must embed trigger ${JSON.stringify(trigger)} for ${entry.fixtureId}`,
      );
    }
    // ega.yaml must declare schema_version: 1 and carry the entry routing
    // sets in the exact parseEgaMetadata shape: the production parse of the
    // emitted bytes returns exactly the entry's canonical routing sets.
    assert.ok(
      first.egaYaml.startsWith("schema_version: 1\n"),
      `ega.yaml must declare schema_version: 1 for ${entry.fixtureId}`,
    );
    const routing = parseEgaMetadata(new TextEncoder().encode(first.egaYaml));
    assert.deepEqual(
      routing,
      {
        domains: canonicalIdentifiers(entry.domains),
        platforms: canonicalIdentifiers(entry.platforms),
        frameworks: canonicalIdentifiers(entry.frameworks),
        aliases: canonicalIdentifiers(entry.aliases),
        triggers: canonicalTriggers(entry.triggers),
        antiTriggers: canonicalTriggers(entry.antiTriggers),
      },
      `ega.yaml routing must match the fixture sets for ${entry.fixtureId}`,
    );
  }
});

test("TEST-001: SKILL.core.md presence matches L1 status and embeds the same triggers", () => {
  for (const entry of SKILL_FIXTURES) {
    const materialized = materializeSkill(entry);
    if (entry.l1.status === "AUTHORED") {
      assert.notEqual(
        materialized.coreMdOrNull,
        null,
        `${entry.fixtureId} is AUTHORED but has no SKILL.core.md`,
      );
      for (const trigger of entry.triggers) {
        assert.ok(
          materialized.coreMdOrNull.includes(trigger),
          `coreMd must embed trigger ${JSON.stringify(trigger)} for ${entry.fixtureId}`,
        );
      }
    } else {
      assert.equal(
        materialized.coreMdOrNull,
        null,
        `${entry.fixtureId} is ${entry.l1.status} but materialized a SKILL.core.md`,
      );
    }
  }
});

test("TEST-001: authored L1 fixtures stay under 1200 L1 tokens", () => {
  const authored = SKILL_FIXTURES.filter((entry) => entry.l1.status === "AUTHORED");
  assert.equal(authored.length, 17);
  for (const entry of authored) {
    const materialized = materializeSkill(entry);
    const coreTokens = countContentTokens(materialized.coreMdOrNull);
    assert.ok(
      coreTokens < 1200,
      `${entry.fixtureId}: SKILL.core.md is ${coreTokens} tokens (must stay under 1200)`,
    );
  }
});

test("TEST-001: boundary L2 fixtures hit their exact token targets", () => {
  const boundary = SKILL_FIXTURES.filter(
    (entry) => entry.l2.tokenTarget !== null,
  );
  assert.equal(boundary.length, 3);
  for (const entry of boundary) {
    const materialized = materializeSkill(entry);
    const actual = countContentTokens(materialized.skillMd);
    assert.equal(
      actual,
      entry.l2.tokenTarget,
      `${entry.fixtureId}: actual ${actual} tokens vs target ${entry.l2.tokenTarget}`,
    );
  }
});

test("TEST-001: countContentTokens uses the gated production estimator", () => {
  assert.equal(countContentTokens("hello world"), 2);
  assert.equal(typeof countContentTokens("alpha beta gamma"), "number");
  assert.doesNotThrow(() => assertTokenEstimatorId(EGA_O200K_V1_ESTIMATOR_ID));
  assert.throws(
    () => assertTokenEstimatorId("ega-o200k-v0"),
    (error) => error.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
  );
  assert.throws(
    () => assertTokenEstimatorId("other-estimator"),
    (error) => error.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
  );
});