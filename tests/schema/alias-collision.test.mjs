import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SchemaValidationError,
  assertAliasClaimsAvailable,
} from "../../packages/schema/dist/index.js";

function owners(entries) {
  return new Map(entries);
}

function expectAliasConflict(fn, { alias, owner, claimant } = {}) {
  try {
    fn();
    assert.fail("expected E_ALIAS_CONFLICT");
  } catch (error) {
    assert.ok(error instanceof SchemaValidationError);
    assert.equal(error.code, "E_ALIAS_CONFLICT");
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
    if (alias !== undefined) assert.ok(error.message.includes(alias), error.message);
    if (owner !== undefined) assert.ok(error.message.includes(owner), error.message);
    if (claimant !== undefined)
      assert.ok(error.message.includes(claimant), error.message);
  }
}

test("SPEC-001 §5.1.11: same alias plus same skill is accepted (idempotent)", () => {
  const existing = owners([["design", "ega/frontend-design"]]);
  assert.deepEqual(
    assertAliasClaimsAvailable(["design"], "ega/frontend-design", existing),
    ["design"],
  );
  // Re-import with case/whitespace variants is still the same claim.
  assert.deepEqual(
    assertAliasClaimsAvailable(
      ["Design", "  DESIGN  "],
      "ega/frontend-design",
      existing,
    ),
    ["design"],
  );
});

test("SPEC-001 §5.1.11: same alias plus different skill returns E_ALIAS_CONFLICT", () => {
  const existing = owners([["design", "ega/frontend-design"]]);
  expectAliasConflict(
    () => assertAliasClaimsAvailable(["design"], "other/other-skill", existing),
    {
      alias: "design",
      owner: "ega/frontend-design",
      claimant: "other/other-skill",
    },
  );
});

test("SPEC-001 §5.1.11: alias canonicalization occurs before collision comparison", () => {
  const existing = owners([
    ["web", "ega/a"],
    ["my.alias", "ega/a"],
  ]);
  // "Web" normalizes to "web" and must collide rather than coexist.
  expectAliasConflict(() => assertAliasClaimsAvailable(["Web"], "ega/b", existing), {
    alias: "web",
  });
  // Surrounding ASCII whitespace + uppercase normalizes before comparison.
  expectAliasConflict(
    () => assertAliasClaimsAvailable(["  MY.ALIAS  "], "ega/b", existing),
    { alias: "my.alias" },
  );
  // The normalized claim for the owning skill itself is accepted.
  assert.deepEqual(assertAliasClaimsAvailable(["WEB"], "ega/a", existing), [
    "web",
  ]);
});

test("SPEC-001 §5.1.11: invalid alias entries fail as E_EGA_METADATA_INVALID", () => {
  const existing = owners([]);
  for (const bad of ["c#", "+cpp", ".web", "web/path"]) {
    assert.throws(
      () => assertAliasClaimsAvailable([bad], "ega/a", existing),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.equal(error.code, "E_EGA_METADATA_INVALID");
        return true;
      },
      `expected E_EGA_METADATA_INVALID for ${JSON.stringify(bad)}`,
    );
  }
});

test("SPEC-001 §5.1.11: collision helper has no persistence side effects", () => {
  const claims = ["design", "extra"];
  const beforeClaims = [...claims];
  const existing = owners([["design", "ega/a"]]);
  const beforeEntries = [...existing.entries()];
  const sizeBefore = existing.size;

  assert.deepEqual(assertAliasClaimsAvailable(claims, "ega/a", existing), [
    "design",
    "extra",
  ]);

  assert.deepEqual(claims, beforeClaims);
  assert.deepEqual([...existing.entries()], beforeEntries);
  assert.equal(existing.size, sizeBefore);
});

test("SPEC-001 §5.1.11: conflict reporting is deterministic for a fixed claim set", () => {
  const existing = owners([
    ["a-alias", "ega/a"],
    ["b-alias", "ega/a"],
  ]);
  const first = (() => {
    try {
      assertAliasClaimsAvailable(["b-alias", "a-alias"], "ega/b", existing);
      assert.fail("expected E_ALIAS_CONFLICT");
    } catch (error) {
      return error.message;
    }
  })();
  const second = (() => {
    try {
      assertAliasClaimsAvailable(["a-alias", "b-alias"], "ega/b", existing);
      assert.fail("expected E_ALIAS_CONFLICT");
    } catch (error) {
      return error.message;
    }
  })();
  assert.equal(first, second);
});

test("SPEC-001 §5.1.11: empty claims are accepted", () => {
  assert.deepEqual(assertAliasClaimsAvailable([], "ega/a", owners([])), []);
});
