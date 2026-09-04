import assert from "node:assert/strict";
import test from "node:test";

import { assessConfidence, isFrozenReasonCode } from "../../packages/router/dist/index.js";

function row(id, tier, evidence, reasons = []) {
  return { id, tier, evidence, reasons };
}

function ev(category, value) {
  return { category, value };
}

const FRAMEWORK = [ev("FRAMEWORK", "react"), ev("TASK_TRIGGER", "build widget")];
const TASK_ONLY = [ev("TASK_TRIGGER", "build widget")];

// SPEC-004 §5.1.17 confidence.

test("SPEC-004 §5.1.17: top Tier A with two strong categories is HIGH", () => {
  const selected = [row("ega/a", "A", FRAMEWORK, ["FRAMEWORK_MATCH", "TASK_TRIGGER_MATCH"])];
  const result = assessConfidence({ selected, candidates: [], automaticSelectedTokens: 600, workspaceAmbiguous: false });
  assert.equal(result.confidence, "HIGH");
  assert.deepEqual(result.selected, selected);
  assert.equal(result.automaticSelectedTokens, 600);
});

test("SPEC-004 §5.1.17: equivalent Tier A competitor lowers to MEDIUM", () => {
  const a = row("ega/a", "A", FRAMEWORK, ["FRAMEWORK_MATCH"]);
  const b = row("ega/b", "A", FRAMEWORK, ["FRAMEWORK_MATCH"]);
  const result = assessConfidence({ selected: [a], candidates: [b], automaticSelectedTokens: 600, workspaceAmbiguous: false });
  assert.equal(result.confidence, "MEDIUM");
  assert.equal(result.selected.length, 1);
});

test("SPEC-004 §5.1.17: complementary Tier A pair stays HIGH", () => {
  const a = row("ega/a", "A", FRAMEWORK, ["FRAMEWORK_MATCH"]);
  const b = row("ega/b", "A", [ev("FRAMEWORK", "react"), ev("DOMAIN", "debugging")], ["FRAMEWORK_MATCH"]);
  const result = assessConfidence({ selected: [a, b], candidates: [], automaticSelectedTokens: 900, workspaceAmbiguous: false });
  assert.equal(result.confidence, "HIGH");
});

test("SPEC-004 §5.1.17: Tier A without task evidence normalizes to LOW", () => {
  // Unreachable via assignTiers (Tier A always carries task strength), but the
  // pure function must not leak it: LOW conditions take precedence and the
  // provisional selection is discarded without leaking.
  const a = row("ega/a", "A", [ev("FRAMEWORK", "react")], ["FRAMEWORK_MATCH"]);
  const result = assessConfidence({ selected: [a], candidates: [], automaticSelectedTokens: 300, workspaceAmbiguous: false });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.selected, []);
  assert.equal(result.automaticSelectedTokens, 0);
});

test("SPEC-004 §5.1.17: Tier B with task strength is MEDIUM", () => {
  const b = row("ega/b", "B", TASK_ONLY, ["TASK_TRIGGER_MATCH"]);
  const result = assessConfidence({ selected: [b], candidates: [], automaticSelectedTokens: 200, workspaceAmbiguous: false });
  assert.equal(result.confidence, "MEDIUM");
});

test("SPEC-004 §5.1.17: lexical-only Tier B normalizes to LOW without leaking", () => {
  const provisional = [row("ega/b", "B", [ev("LEXICAL", "widget")], ["LEXICAL_MATCH"])];
  const result = assessConfidence({ selected: provisional, candidates: [], automaticSelectedTokens: 200, workspaceAmbiguous: false });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.selected, []);
  assert.equal(result.automaticSelectedTokens, 0);
  assert.equal(result.candidates.length, 1);
});

test("SPEC-004 §5.1.17: empty play normalizes to LOW", () => {
  const result = assessConfidence({ selected: [], candidates: [], automaticSelectedTokens: 0, workspaceAmbiguous: false });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.candidates, []);
});

test("SPEC-004 §5.1.17: workspace ambiguity forces LOW with explanatory reasons", () => {
  const a = row("ega/a", "A", FRAMEWORK, ["FRAMEWORK_MATCH", "TASK_TRIGGER_MATCH"]);
  const b = row("ega/b", "A", FRAMEWORK, ["FRAMEWORK_MATCH"]);
  const c = row("ega/c", "B", TASK_ONLY, ["TASK_TRIGGER_MATCH"]);
  const d = row("ega/d", "B", TASK_ONLY, ["TASK_TRIGGER_MATCH"]);
  const result = assessConfidence({
    selected: [a],
    candidates: [b, c, d],
    automaticSelectedTokens: 600,
    workspaceAmbiguous: true,
  });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.selected, []);
  assert.equal(result.automaticSelectedTokens, 0);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every((row) => row.reasons.includes("WORKSPACE_AMBIGUOUS")));
});

test("SPEC-004 §5.1.17: LOW keeps at most three relevant candidates", () => {
  const rows = ["a", "b", "c", "d"].map((name) => row(`ega/${name}`, "C", [ev("LEXICAL", "x")], ["LEXICAL_MATCH"]));
  const result = assessConfidence({ selected: [], candidates: rows, automaticSelectedTokens: 0, workspaceAmbiguous: false });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.candidates.map((row) => row.id), ["ega/a", "ega/b", "ega/c"]);
});

// SPEC-004 §5.1.18 reason-code closure.

test("SPEC-004 §5.1.18: only frozen codes validate", () => {
  for (const code of ["EXPLICIT_USER", "TOKEN_EFFICIENT", "LOCKED_VERSION", "NAMESPACE_DENIED", "REDUNDANT_HIGHER_RANKED", "WORKSPACE_AMBIGUOUS", "EXPLICIT_PLATFORM_MISMATCH"]) {
    assert.equal(isFrozenReasonCode(code), true, code);
  }
  assert.equal(isFrozenReasonCode("MADE_UP_REASON"), false);
  assert.equal(isFrozenReasonCode(""), false);
});
