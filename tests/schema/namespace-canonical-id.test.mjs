import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SchemaValidationError,
  buildCanonicalSkillId,
  isNamespace,
  parseCanonicalSkillId,
  resolveSkillReference,
  validateNamespace,
} from "../../packages/schema/dist/index.js";

function expectSchemaError(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, code);
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0);
      return true;
    },
    `expected ${code}`,
  );
}

// SPEC-001 §5.1.4 namespace syntax: ^[a-z0-9][a-z0-9._-]{0,63}$

test("SPEC-001 §5.1.4: my.company namespace is accepted (dot punctuation)", () => {
  assert.equal(isNamespace("my.company"), true);
  assert.equal(validateNamespace("my.company"), "my.company");
});

test("SPEC-001 §5.1.4: personal_v1 namespace is accepted (underscore punctuation)", () => {
  assert.equal(isNamespace("personal_v1"), true);
  assert.equal(validateNamespace("personal_v1"), "personal_v1");
});

test("SPEC-001 §5.1.4: canonical ID my.company/frontend-design is accepted", () => {
  const id = buildCanonicalSkillId("my.company", "frontend-design");
  assert.equal(id, "my.company/frontend-design");
  assert.deepEqual(parseCanonicalSkillId(id), {
    namespace: "my.company",
    name: "frontend-design",
  });
});

test("SPEC-001 §5.1.4: ega/my_skill is rejected by portable-name validation", () => {
  expectSchemaError(
    () => buildCanonicalSkillId("ega", "my_skill"),
    "E_SKILL_NAME_INVALID",
  );
});

test("SPEC-001 §5.1.4: invalid namespaces return E_NAMESPACE_INVALID", () => {
  for (const bad of [
    "",
    "EGA",
    "My.Company",
    "-leading",
    ".leading",
    "_leading",
    "has space",
    "has/slash",
    "UPPER",
    "x".repeat(65),
  ]) {
    assert.equal(isNamespace(bad), false, `isNamespace(${JSON.stringify(bad)})`);
    expectSchemaError(() => validateNamespace(bad), "E_NAMESPACE_INVALID");
  }
});

test("SPEC-001 §5.1.4: namespace boundaries 1 and 64 chars are accepted", () => {
  assert.equal(isNamespace("a"), true);
  assert.equal(isNamespace("x".repeat(64)), true);
  assert.equal(validateNamespace("a"), "a");
});

// SPEC-001 §5.1.12 resolution order:
// 1. exact canonical ID, 2. exact global alias, 3. bare portable name iff unique.

function catalog(...entries) {
  return entries.map(([canonicalId, aliases = []]) => ({
    canonicalId,
    aliases,
  }));
}

test("SPEC-001 §5.1.12: exact canonical ID resolves before alias/name", () => {
  const visible = catalog(
    ["ega/frontend-design", ["design"]],
    ["other/frontend-design", []],
  );
  // "design" is an alias of ega/frontend-design, but the canonical ID must win
  // when the ref itself is a canonical ID.
  assert.equal(
    resolveSkillReference("other/frontend-design", visible),
    "other/frontend-design",
  );
  assert.equal(
    resolveSkillReference("ega/frontend-design", visible),
    "ega/frontend-design",
  );
});

test("SPEC-001 §5.1.12: exact global alias resolves before bare name", () => {
  const visible = catalog(
    ["ega/frontend-design", ["design"]],
    ["other/design", []],
  );
  // "design" is both an alias (ega/...) and a bare portable name (other/design).
  // Alias wins per resolution order.
  assert.equal(resolveSkillReference("design", visible), "ega/frontend-design");
});

test("SPEC-001 §5.1.12: bare duplicate portable names return E_SKILL_REFERENCE_AMBIGUOUS", () => {
  const visible = catalog(
    ["zeta/frontend-design", []],
    ["alpha/frontend-design", []],
  );
  expectSchemaError(
    () => resolveSkillReference("frontend-design", visible),
    "E_SKILL_REFERENCE_AMBIGUOUS",
  );
});

test("SPEC-001 §5.1.12: ambiguous error reports deterministic visible-catalog order", () => {
  const forward = catalog(
    ["zeta/frontend-design", []],
    ["alpha/frontend-design", []],
  );
  const reversed = catalog(
    ["alpha/frontend-design", []],
    ["zeta/frontend-design", []],
  );
  for (const visible of [forward, reversed]) {
    try {
      resolveSkillReference("frontend-design", visible);
      assert.fail("expected E_SKILL_REFERENCE_AMBIGUOUS");
    } catch (error) {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "E_SKILL_REFERENCE_AMBIGUOUS");
      const alphaPos = error.message.indexOf("alpha/frontend-design");
      const zetaPos = error.message.indexOf("zeta/frontend-design");
      assert.ok(alphaPos >= 0 && zetaPos >= 0, error.message);
      assert.ok(
        alphaPos < zetaPos,
        `deterministic order, got: ${error.message}`,
      );
    }
  }
});

test("SPEC-001 §5.1.12: bare unique portable name resolves", () => {
  const visible = catalog(["ega/frontend-design", []], ["ega/other-skill", []]);
  assert.equal(
    resolveSkillReference("frontend-design", visible),
    "ega/frontend-design",
  );
});

test("SPEC-001 §5.1.12: bare missing name returns E_SKILL_NOT_FOUND", () => {
  const visible = catalog(["ega/frontend-design", []]);
  expectSchemaError(
    () => resolveSkillReference("no-such-skill", visible),
    "E_SKILL_NOT_FOUND",
  );
});

test("SPEC-001 §5.1.12: resolution is deterministic for a fixed visible catalog", () => {
  const visible = catalog(
    ["ega/b-skill", []],
    ["ega/a-skill", ["common"]],
    ["other/a-skill", []],
  );
  // Alias "common" always hits the same canonical ID regardless of catalog order.
  const shuffled = [...visible].reverse();
  assert.equal(resolveSkillReference("common", visible), "ega/a-skill");
  assert.equal(resolveSkillReference("common", shuffled), "ega/a-skill");
  assert.equal(
    resolveSkillReference("ega/b-skill", shuffled),
    "ega/b-skill",
  );
});
