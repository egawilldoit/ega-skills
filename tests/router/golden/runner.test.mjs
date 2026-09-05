// Golden matrix gate (TEST-001, EGA-580/EGA-581).
//
// Runs ALL 41 router scenarios (scenarios-01..05 concatenated, G040 excluded —
// the single IMPORT_INTEGRATION case is not a router scenario) through
// runGoldenScenario against the LIVE production resolver, printing a
// per-scenario PASS/FAIL matrix with failure codes and expected-vs-actual
// one-liners. MERGE-BLOCKING: asserts every scenario passes — the golden
// corpus is the oracle (never tune expectations to match code).

import assert from "node:assert/strict";
import { test } from "node:test";

import { runGoldenScenario } from "./runner.mjs";
import { SCENARIOS_01 } from "./scenarios-01.mjs";
import { SCENARIOS_02 } from "./scenarios-02.mjs";
import { SCENARIOS_03 } from "./scenarios-03.mjs";
import { SCENARIOS_04 } from "./scenarios-04.mjs";
import { SCENARIOS_05 } from "./scenarios-05.mjs";

const ALL_SCENARIOS = [
  ...SCENARIOS_01,
  ...SCENARIOS_02,
  ...SCENARIOS_03,
  ...SCENARIOS_04,
  // G040 is IMPORT_INTEGRATION (not a router case); the matrix runs the
  // router subset of the precision batch only.
  ...SCENARIOS_05.filter((scenario) => scenario.kind === "ROUTER"),
];

test("TEST-001 golden matrix: all 41 router scenarios pass (merge-blocking)", async () => {
  const rows = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of ALL_SCENARIOS) {
    let outcome;
    try {
      outcome = await runGoldenScenario(scenario);
    } catch (error) {
      // Harness crash: rethrow with scenario context so the test fails loudly.
      throw new Error(
        `GOLDEN MATRIX HARNESS CRASH on ${scenario.id}: ${error?.stack ?? error}`,
      );
    }
    if (outcome.pass) {
      passed += 1;
      rows.push(`[GOLDEN MATRIX] ${scenario.id} PASS`);
    } else {
      failed += 1;
      rows.push(`[GOLDEN MATRIX] ${scenario.id} FAIL`);
      for (const failure of outcome.failures) {
        rows.push(
          `[GOLDEN MATRIX]   ${failure.code} | ${failure.detail}`,
        );
      }
    }
  }

  rows.push("");
  rows.push(`[GOLDEN MATRIX] total=${ALL_SCENARIOS.length} pass=${passed} fail=${failed}`);
  console.log(rows.join("\n"));
  assert.equal(
    ALL_SCENARIOS.length,
    41,
    "router matrix must stay exactly 41 cases (G001–G042, G040 excluded)",
  );
  assert.equal(failed, 0, `${failed} golden scenario(s) failed — golden is oracle, fix code not expectations`);
});