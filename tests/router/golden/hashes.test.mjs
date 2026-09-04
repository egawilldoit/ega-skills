// Golden hash freeze tests (TEST-001, EGA-580).
// Verify that the frozen golden-hashes.json matches the live computed output —
// the file is authoring, this suite is the tripping wire.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildFrozenHashes } from "./build-hashes.mjs";

const GOLDEN_PATH = fileURLToPath(new URL("./golden-hashes.json", import.meta.url));

// Build once per test file run: 20 materializations + 20 isolated imports.
let computedPromise = null;
function computedOnce() {
  computedPromise ??= buildFrozenHashes();
  return computedPromise;
}

test("TEST-001: computed hashes match the frozen golden file (all 20 fixtures)", async () => {
  const computed = await computedOnce();
  const frozen = JSON.parse(await readFile(GOLDEN_PATH, "utf8"));
  assert.equal(Object.keys(computed).length, 20);
  assert.deepEqual(computed, frozen);
});

test("TEST-001: every versionHash is sha256 colon 64-hex", async () => {
  const computed = await computedOnce();
  for (const [fixtureId, row] of Object.entries(computed)) {
    assert.match(
      row.versionHash,
      /^sha256:[0-9a-f]{64}$/,
      `${fixtureId}: versionHash ${JSON.stringify(row.versionHash)} is not sha256:64-hex`,
    );
  }
});

test("TEST-001: boundary L2 token counts equal 4900, 9000, 13000", async () => {
  const computed = await computedOnce();
  const expectedByFixture = {
    "skill-compact-reference-v1": 4900,
    "skill-large-reference-v1": 9000,
    "skill-oversized-reference-v1": 13000,
  };
  for (const [fixtureId, expected] of Object.entries(expectedByFixture)) {
    assert.equal(
      computed[fixtureId].l2Tokens,
      expected,
      `${fixtureId}: expected ${expected} L2 tokens, got ${computed[fixtureId].l2Tokens}`,
    );
  }
});