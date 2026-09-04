import assert from "node:assert/strict";
import { test } from "node:test";

import {
  L0_TARGET_MAX_TOKENS,
  L1_HARD_MAX_TOKENS,
  L1_TARGET_MAX_TOKENS,
  L1_TARGET_MIN_TOKENS,
  L2_LARGE_MAX_TOKENS,
  L2_NORMAL_MAX_TOKENS,
  SchemaValidationError,
  assertL1TokenBudget,
  buildL0Metadata,
  classifyL2SizeClass,
  parsePortableSkill,
  resolveL1Status,
  summarizePackageContent,
  tokenEstimator,
} from "../../packages/schema/dist/index.js";

const encoder = new TextEncoder();

function encode(text) {
  return encoder.encode(text);
}

function skillMd(name = "frontend-design") {
  return encode(
    `---\nname: ${name}\ndescription: "Build polished frontend interfaces."\n---\n\n# ${name}\n`,
  );
}

// SPEC-001 §5.1.7 content levels L0 / L1 / L2.

test("SPEC-001 §5.1.7: missing SKILL.core.md maps to MISSING", () => {
  assert.equal(resolveL1Status(undefined), "MISSING");
});

test("SPEC-001 §5.1.7: valid authored core maps to AUTHORED", () => {
  assert.equal(resolveL1Status(encode("# Core instructions.\n")), "AUTHORED");
  assert.equal(resolveL1Status(encode("")), "AUTHORED");
});

test("SPEC-001 §5.1.7: L1 boundary 4000 accepted, 4001 fails E_L1_TOO_LARGE", () => {
  assert.equal(L1_HARD_MAX_TOKENS, 4000);
  assert.doesNotThrow(() => assertL1TokenBudget(4000));
  assert.throws(
    () => assertL1TokenBudget(4001),
    (error) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "E_L1_TOO_LARGE");
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0);
      return true;
    },
  );
});

test("SPEC-001 §5.1.7: oversized L1 never mutates or invalidates L2", () => {
  const source = skillMd();
  const before = parsePortableSkill({
    directoryName: "frontend-design",
    skillMd: source,
  });
  assert.throws(() => assertL1TokenBudget(5000), (error) => {
    assert.ok(error instanceof SchemaValidationError);
    assert.equal(error.code, "E_L1_TOO_LARGE");
    return true;
  });
  const after = parsePortableSkill({
    directoryName: "frontend-design",
    skillMd: source,
  });
  assert.deepEqual(after, before);
});

test("SPEC-001 §5.1.7/§5.1.14: L2 size-class boundaries match frozen thresholds", () => {
  assert.equal(L2_NORMAL_MAX_TOKENS, 5000);
  assert.equal(L2_LARGE_MAX_TOKENS, 12000);
  assert.equal(classifyL2SizeClass(0), "NORMAL");
  assert.equal(classifyL2SizeClass(5000), "NORMAL");
  assert.equal(classifyL2SizeClass(5001), "LARGE");
  assert.equal(classifyL2SizeClass(12000), "LARGE");
  assert.equal(classifyL2SizeClass(12001), "OVERSIZED");
});

test("SPEC-001 §5.1.7: L0 carries metadata and token counts but no instruction body", () => {
  const l0 = buildL0Metadata({
    canonicalId: "ega/frontend-design",
    l1Status: "AUTHORED",
    l1Tokens: 1200,
    l2Tokens: 4500,
    sizeClass: "NORMAL",
    routing: {
      domains: ["web"],
      platforms: [],
      frameworks: ["react"],
      aliases: ["design"],
      triggers: ["Build API"],
      antiTriggers: [],
    },
    referenceCount: 2,
    hasScripts: true,
    hasAssets: false,
  });

  assert.deepEqual(Object.keys(l0).sort(), [
    "aliases",
    "antiTriggers",
    "canonicalId",
    "domains",
    "frameworks",
    "hasAssets",
    "hasScripts",
    "l1Status",
    "l1Tokens",
    "l2Tokens",
    "platforms",
    "referenceCount",
    "sizeClass",
    "triggers",
  ]);
  const serialized = JSON.stringify(l0);
  for (const forbidden of ["body", "content", "text", "instructions"]) {
    assert.ok(
      !Object.keys(l0).includes(forbidden),
      `L0 must not carry ${forbidden}`,
    );
  }
  assert.equal(l0.canonicalId, "ega/frontend-design");
  assert.equal(l0.l1Status, "AUTHORED");
  assert.equal(l0.l2Tokens, 4500);
  assert.ok(serialized.length > 0);
});

test("SPEC-001 §5.1.7: frozen L0/L1 token targets are exposed", () => {
  assert.equal(L0_TARGET_MAX_TOKENS, 250);
  assert.equal(L1_TARGET_MIN_TOKENS, 500);
  assert.equal(L1_TARGET_MAX_TOKENS, 2000);
});

// SPEC-001 §5.1.13 references, assets, scripts.

test("SPEC-001 §5.1.13: package content summary derives flags without execution", () => {
  assert.deepEqual(
    summarizePackageContent([
      "SKILL.md",
      "ega.yaml",
      "references/a.md",
      "references/sub/b.md",
      "assets/logo.png",
      "scripts/run.sh",
    ]),
    { referenceCount: 2, hasScripts: true, hasAssets: true },
  );
  assert.deepEqual(summarizePackageContent(["SKILL.md"]), {
    referenceCount: 0,
    hasScripts: false,
    hasAssets: false,
  });
  // Bare directory names alone are not content; separators normalize.
  assert.deepEqual(
    summarizePackageContent(["references", "assets", "scripts"]),
    { referenceCount: 0, hasScripts: false, hasAssets: false },
  );
  assert.deepEqual(summarizePackageContent(["scripts\\run.sh"]), {
    referenceCount: 0,
    hasScripts: true,
    hasAssets: false,
  });
});

test("SPEC-001 §5.1.19: real ega-o200k-v1 counts flow through the L1 budget", () => {
  const count = tokenEstimator.count("Hello");
  assert.equal(count, 1);
  assert.doesNotThrow(() => assertL1TokenBudget(count));
});
