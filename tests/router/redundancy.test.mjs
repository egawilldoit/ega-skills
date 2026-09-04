import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { suppressRedundant } from "../../packages/router/dist/index.js";

function versionHash(id) {
  return `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

function row(id, tier, evidence = [], overrides = {}) {
  return {
    id,
    name: id.slice(id.indexOf("/") + 1),
    versionHash: versionHash(id),
    tier,
    evidence,
    ...overrides,
  };
}

function run(rows) {
  return suppressRedundant({ rows });
}

function ev(category, value) {
  return { category, value };
}

function rejects(rows) {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    versionHash: r.versionHash,
    evidence: [],
    reasons: ["REDUNDANT_HIGHER_RANKED"],
  }));
}

// SPEC-004 §5.1.16 redundancy suppression.

test("SPEC-004 §5.1.16: same-tier generic overlap suppresses B with REDUNDANT_HIGHER_RANKED", () => {
  const a = row("ega/generic", "A", [
    ev("FRAMEWORK", "react"),
    ev("PLATFORM", "web"),
    ev("TASK_TRIGGER", "build widget"),
    ev("DOMAIN", "frontend"),
  ]);
  const b = row("ega/overlap", "A", [
    ev("FRAMEWORK", "react"),
    ev("PLATFORM", "web"),
    ev("TASK_TRIGGER", "build widget"),
    ev("DOMAIN", "frontend"),
  ]);
  const result = run([a, b]);
  assert.deepEqual(result.kept, [a]);
  assert.deepEqual(result.suppressed, rejects([b]));
});

test("SPEC-004 §5.1.16 rule 3: systematic-debugging + react-frontend both kept on distinct evidence", () => {
  const debugging = row("ega/systematic-debugging", "B", [
    ev("TASK_TRIGGER", "debug flaky test"),
    ev("DOMAIN", "debugging"),
  ]);
  const react = row("ega/react-frontend", "A", [
    ev("FRAMEWORK", "react"),
    ev("TASK_TRIGGER", "build react component"),
    ev("DOMAIN", "frontend"),
  ]);
  const result = run([debugging, react]);
  assert.deepEqual(result.kept.map((r) => r.id), [
    "ega/systematic-debugging",
    "ega/react-frontend",
  ]);
  assert.deepEqual(result.suppressed, []);
});

test("SPEC-004 §5.1.16: unique TASK_TRIGGER or DOMAIN value saves B", () => {
  const base = [ev("FRAMEWORK", "react"), ev("TASK_TRIGGER", "build widget")];
  const a = row("ega/a", "A", base);
  const uniqueTrigger = row("ega/trigger", "A", [
    ...base,
    ev("TASK_TRIGGER", "refactor widget"),
  ]);
  assert.deepEqual(run([a, uniqueTrigger]).suppressed, []);
  const uniqueDomain = row("ega/domain", "A", [...base, ev("DOMAIN", "frontend")]);
  assert.deepEqual(run([a, uniqueDomain]).suppressed, []);
  assert.deepEqual(run([a, uniqueTrigger, uniqueDomain]).kept.map((r) => r.id), [
    "ega/a",
    "ega/trigger",
    "ega/domain",
  ]);
});

test("SPEC-004 §5.1.16: same-or-stronger tier required - C never suppresses B", () => {
  const c = row("ega/c", "C", [ev("TASK_TRIGGER", "build widget")]);
  const b = row("ega/b", "B", [ev("TASK_TRIGGER", "build widget")]);
  const result = run([c, b]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/c", "ega/b"]);
  assert.deepEqual(result.suppressed, []);
});

test("SPEC-004 §5.1.16: Tier C behind a covering A is suppressed (weaker tier, no unique evidence)", () => {
  const a = row("ega/a", "A", [ev("FRAMEWORK", "react")]);
  const c = row("ega/c", "C", [ev("FRAMEWORK", "react")]);
  const result = run([a, c]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/a"]);
  assert.deepEqual(result.suppressed, rejects([c]));
});

test("SPEC-004 §5.1.16: C behind A is kept when framework coverage differs", () => {
  const a = row("ega/a", "A", [ev("FRAMEWORK", "react")]);
  const c = row("ega/c", "C", [ev("FRAMEWORK", "vue")]);
  const result = run([a, c]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/a", "ega/c"]);
  assert.deepEqual(result.suppressed, []);
});

test("SPEC-004 §5.1.16: extra PLATFORM value in B is unique coverage, B is kept", () => {
  const a = row("ega/a", "A", [ev("PLATFORM", "web")]);
  const b = row("ega/b", "A", [ev("PLATFORM", "web"), ev("PLATFORM", "mobile")]);
  const result = run([a, b]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/a", "ega/b"]);
  assert.deepEqual(result.suppressed, []);
});

test("SPEC-004 §5.1.16: suppression is order-deterministic - the earlier row survives", () => {
  const a = row("ega/a", "A", [ev("FRAMEWORK", "react")]);
  const b = row("ega/b", "A", [ev("FRAMEWORK", "react")]);
  const forward = run([a, b]);
  const reversed = run([b, a]);
  assert.deepEqual(forward.kept.map((r) => r.id), ["ega/a"]);
  assert.deepEqual(forward.suppressed.map((r) => r.id), ["ega/b"]);
  assert.deepEqual(reversed.kept.map((r) => r.id), ["ega/b"]);
  assert.deepEqual(reversed.suppressed.map((r) => r.id), ["ega/a"]);
});

test("SPEC-004 §5.1.16: only kept rows suppress - B saved by unique DOMAIN then suppresses C", () => {
  const base = [
    ev("FRAMEWORK", "react"),
    ev("TASK_TRIGGER", "build widget"),
    ev("DOMAIN", "frontend"),
  ];
  const a = row("ega/a", "A", [
    ev("FRAMEWORK", "react"),
    ev("TASK_TRIGGER", "build widget"),
  ]);
  const b = row("ega/b", "A", base);
  const c = row("ega/c", "A", base);
  const result = run([a, b, c]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/a", "ega/b"]);
  assert.deepEqual(result.suppressed, rejects([c]));
});

test("SPEC-004 §5.1.16: pure recomputation - repeated calls are identical and input is unmutated", () => {
  const rows = [
    row("ega/a", "A", [ev("FRAMEWORK", "react"), ev("DOMAIN", "frontend")]),
    row("ega/b", "A", [ev("FRAMEWORK", "react")]),
  ];
  const first = run(rows);
  const second = run(rows);
  assert.deepEqual(second, first);
  assert.deepEqual(first.kept.map((r) => r.id), ["ega/a"]);
  assert.deepEqual(first.suppressed.map((r) => r.id), ["ega/b"]);
  assert.deepEqual(rows.map((r) => r.id), ["ega/a", "ega/b"]);
  assert.deepEqual(rows[0].evidence, [ev("FRAMEWORK", "react"), ev("DOMAIN", "frontend")]);
  assert.deepEqual(rows[1].evidence, [ev("FRAMEWORK", "react")]);
});

test("SPEC-004 §5.1.16: only unique TASK_TRIGGER/DOMAIN rescue B - NAME_DESCRIPTION and LEXICAL ignored", () => {
  const a = row("ega/a", "A", [ev("FRAMEWORK", "react"), ev("TASK_TRIGGER", "build widget")]);
  const b = row("ega/named", "A", [
    ev("FRAMEWORK", "react"),
    ev("TASK_TRIGGER", "build widget"),
    ev("NAME_DESCRIPTION", "ega/named"),
    ev("LEXICAL", "build widget"),
  ]);
  const result = run([a, b]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/a"]);
  assert.deepEqual(result.suppressed, rejects([b]));
});

test("SPEC-004 §5.1.16: evidence-free Tier C behind an earlier A is suppressed (vacuous coverage)", () => {
  const a = row("ega/a", "A", [ev("FRAMEWORK", "react")]);
  const c = row("ega/lexical", "C", []);
  const result = run([a, c]);
  assert.deepEqual(result.kept.map((r) => r.id), ["ega/a"]);
  assert.deepEqual(result.suppressed, rejects([c]));
});

test("SPEC-004 §5.1.16: no earlier A - lone candidate stays kept", () => {
  const a = row("ega/a", "B", [ev("TASK_TRIGGER", "build widget")]);
  const result = run([a]);
  assert.deepEqual(result.kept, [a]);
  assert.deepEqual(result.suppressed, []);
});