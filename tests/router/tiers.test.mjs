import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { assignTiers } from "../../packages/router/dist/index.js";

function versionHash(id) {
  return `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

function skill(id, overrides = {}) {
  return {
    canonicalId: id,
    portableName: id.slice(id.indexOf("/") + 1),
    aliases: [],
    versionHash: versionHash(id),
    l1Status: "MISSING",
    l1Tokens: null,
    l2Tokens: 100,
    platforms: [],
    frameworks: [],
    triggers: [],
    domains: [],
    description: "",
    ...overrides,
  };
}

function run(candidates, options = {}) {
  return assignTiers({
    candidates,
    task: "do something",
    projectFrameworks: [],
    projectPlatforms: [],
    ...options,
  });
}

function tiersOf(result) {
  return Object.fromEntries(result.ranked.map((row) => [row.id, row.tier]));
}

// SPEC-004 §5.1.10 tier assignment.

test("SPEC-004 §5.1.10: A needs project strength plus task strength", () => {
  const a = skill("ega/a", { frameworks: ["react"], triggers: ["build widget"] });
  const b = skill("ega/b", { triggers: ["build widget"] });
  const c = skill("ega/c", { frameworks: ["react"] });
  const result = run([a, b, c], {
    task: "please build widget now",
    projectFrameworks: ["react"],
  });
  assert.deepEqual(tiersOf(result), { "ega/a": "A", "ega/b": "B", "ega/c": "C" });
  assert.deepEqual(result.ranked.map((row) => row.id), ["ega/a", "ega/b", "ega/c"]);
});

test("SPEC-004 §5.1.10: lexical-only candidates are Tier C with evidence", () => {
  const a = skill("ega/lex", { description: "unrelated" });
  const result = run([a], { task: "frobnicator zzz", ftsOrder: ["ega/lex"] });
  assert.deepEqual(tiersOf(result), { "ega/lex": "C" });
  const row = result.ranked[0];
  assert.deepEqual(row.evidence, [{ category: "LEXICAL", value: "frobnicator zzz" }]);
  assert.deepEqual(row.reasons, ["LEXICAL_MATCH"]);
});

test("SPEC-004 §5.1.10: evidence-free candidates classify C without reasons", () => {
  const a = skill("ega/quiet");
  const result = run([a], { task: "totally unrelated words" });
  assert.deepEqual(tiersOf(result), { "ega/quiet": "C" });
  assert.deepEqual(result.ranked[0].evidence, []);
  assert.deepEqual(result.ranked[0].reasons, []);
});

test("SPEC-004 §5.1.13: evidence categories attach with frozen emission order", () => {
  const a = skill("ega/gadget", {
    frameworks: ["react"],
    platforms: ["web"],
    triggers: ["build widget"],
    domains: ["frontend"],
    aliases: ["widget"],
  });
  const result = run([a], {
    task: "build widget for frontend web with react, call it widget",
    projectFrameworks: ["react"],
    projectPlatforms: ["web"],
    prefer: ["ega/gadget"],
    ftsOrder: ["ega/gadget"],
  });
  const row = result.ranked[0];
  assert.equal(row.tier, "A");
  assert.deepEqual(row.evidence.map((record) => record.category), [
    "FRAMEWORK",
    "PLATFORM",
    "TASK_TRIGGER",
    "DOMAIN",
    "NAME_DESCRIPTION",
    "PROJECT_PREFERENCE",
    "LEXICAL",
  ]);
  assert.deepEqual(row.reasons, [
    "PROJECT_PREFERENCE",
    "FRAMEWORK_MATCH",
    "PLATFORM_MATCH",
    "TASK_TRIGGER_MATCH",
    "DOMAIN_MATCH",
    "DESCRIPTION_MATCH",
    "LEXICAL_MATCH",
  ]);
});

// SPEC-004 §5.1.14 tie-break.

test("SPEC-004 §5.1.14: prefer orders before evidence count", () => {
  const plain = skill("ega/plain", { triggers: ["run job", "extra work"] });
  const preferred = skill("ega/preferred", { triggers: ["run job"] });
  const result = run([plain, preferred], {
    task: "run job with extra work",
    prefer: ["ega/preferred"],
  });
  assert.deepEqual(result.ranked.map((row) => row.id), ["ega/preferred", "ega/plain"]);
  const winner = result.ranked[0];
  assert.ok(winner.reasons.includes("PROJECT_PREFERENCE"));
});

test("SPEC-004 §5.1.14: prefer never creates relevance by itself", () => {
  const a = skill("ega/solo");
  const result = run([a], { task: "unrelated", prefer: ["ega/solo"] });
  assert.deepEqual(tiersOf(result), { "ega/solo": "C" });
  assert.deepEqual(result.ranked[0].evidence, []);
});

test("SPEC-004 §5.1.14: relative FTS rank precedes token efficiency", () => {
  const heavy = skill("ega/heavy", { triggers: ["run job"], l2Tokens: 900 });
  const light = skill("ega/light", { triggers: ["run job"], l2Tokens: 100 });
  const result = run([heavy, light], {
    task: "run job",
    ftsOrder: ["ega/heavy", "ega/light"],
  });
  assert.deepEqual(result.ranked.map((row) => row.id), ["ega/heavy", "ega/light"]);
  assert.ok(!result.ranked[0].reasons.includes("TOKEN_EFFICIENT"));
});

test("SPEC-004 §5.1.14: TOKEN_EFFICIENT only when tokens decide a tie", () => {
  const heavy = skill("ega/heavy", { triggers: ["run job"], l2Tokens: 900 });
  const light = skill("ega/light", { triggers: ["run job"], l2Tokens: 100 });
  const decided = run([heavy, light], { task: "run job" });
  assert.deepEqual(decided.ranked.map((row) => row.id), ["ega/light", "ega/heavy"]);
  assert.ok(decided.ranked[0].reasons.includes("TOKEN_EFFICIENT"));
  assert.ok(!decided.ranked[1].reasons.includes("TOKEN_EFFICIENT"));
  const equalA = skill("ega/equal-a", { triggers: ["run job"], l2Tokens: 100 });
  const equalB = skill("ega/equal-b", { triggers: ["run job"], l2Tokens: 100 });
  const tied = run([equalB, equalA], { task: "run job" });
  assert.deepEqual(tied.ranked.map((row) => row.id), ["ega/equal-a", "ega/equal-b"]);
  assert.ok(!tied.ranked[0].reasons.includes("TOKEN_EFFICIENT"));
});

test("SPEC-004 §5.1.14: exact ties resolve by canonical ID then version", () => {
  const b = skill("ega/alpha-two", { triggers: ["run job"] });
  const a = skill("ega/alpha-one", { triggers: ["run job"] });
  const twice = run([b, a], { task: "run job" });
  assert.deepEqual(twice.ranked.map((row) => row.id), ["ega/alpha-one", "ega/alpha-two"]);
  assert.deepEqual(run([b, a], { task: "run job" }), run([b, a], { task: "run job" }));
});

test("SPEC-004 §5.1.14: L1 tokens drive efficiency when authored", () => {
  const l1 = skill("ega/l1", { l1Status: "AUTHORED", l1Tokens: 50, l2Tokens: 2000, triggers: ["run job"] });
  const l2 = skill("ega/l2", { l2Tokens: 400, triggers: ["run job"] });
  const result = run([l2, l1], { task: "run job" });
  assert.deepEqual(result.ranked.map((row) => row.id), ["ega/l1", "ega/l2"]);
  assert.equal(result.ranked[0].recommendedContentTokens, 50);
  assert.equal(result.ranked[1].recommendedContentTokens, 400);
});

test("SPEC-004 §5.1.10: domain phrase matching is identifier-aware", () => {
  const rn = skill("ega/rn", { domains: ["react-native"] });
  const yes = run([rn], { task: "help with my react native app" });
  assert.deepEqual(tiersOf(yes), { "ega/rn": "B" });
  const no = run([rn], { task: "help with my react app" });
  assert.deepEqual(tiersOf(no), { "ega/rn": "C" });
});

test("SPEC-004 §5.1.10: output carries no numeric scores or BM25", () => {
  const a = skill("ega/quiz", { frameworks: ["react"], triggers: ["build it"] });
  const result = run([a], {
    task: "build it with react",
    projectFrameworks: ["react"],
    ftsOrder: ["ega/quiz"],
  });
  const json = JSON.parse(JSON.stringify(result));
  const row = json.ranked[0];
  assert.deepEqual(Object.keys(row).sort(), ["evidence", "ftsRank", "id", "reasons", "recommendedContentTokens", "tier"]);
  assert.ok(!("bm25" in row) && !("score" in row));
  assert.equal(row.ftsRank, 0);
});
