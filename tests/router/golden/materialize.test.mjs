import assert from "node:assert/strict";
import test from "node:test";

import { SKILL_FIXTURES } from "./catalog-data.mjs";
import {
  EGA_O200K_V1_ESTIMATOR_ID,
  assertTokenEstimatorId,
} from "../../../packages/schema/dist/index.js";
import {
  countContentTokens,
  materializeSkill,
} from "./skill-materialize.mjs";

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
    assert.equal(first.egaYaml, "schema_version: 1\n");
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