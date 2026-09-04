// Golden matrix harness test (TEST-001, EGA-580).
//
// Runs ALL base-34 scenarios (scenarios-01..04 concatenated) through
// runGoldenScenario against the LIVE production resolver, printing a
// per-scenario PASS/FAIL matrix with failure codes and expected-vs-actual
// one-liners. Informational only: asserts NOTHING — the test always passes
// unless the harness itself crashes (a thrown error escaping the runner).

import { test } from "node:test";

import { runGoldenScenario } from "./runner.mjs";
import { SCENARIOS_01 } from "./scenarios-01.mjs";
import { SCENARIOS_02 } from "./scenarios-02.mjs";
import { SCENARIOS_03 } from "./scenarios-03.mjs";
import { SCENARIOS_04 } from "./scenarios-04.mjs";

const ALL_SCENARIOS = [
  ...SCENARIOS_01,
  ...SCENARIOS_02,
  ...SCENARIOS_03,
  ...SCENARIOS_04,
];

test("TEST-001 golden matrix: all 34 scenarios (informational, asserts nothing)", async () => {
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
});