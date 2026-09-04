// EGA-577 — SPEC-004 §5.1.6/§5.1.7/§5.1.20 automatic composition behavior.
import assert from "node:assert/strict";
import test from "node:test";

import { composeAutomatic } from "../../packages/router/dist/index.js";

function row(id, overrides = {}) {
  return {
    id,
    name: id.slice(id.indexOf("/") + 1),
    versionHash: `sha256:${id}`,
    tier: "A",
    evidence: [],
    reasons: ["TASK_TRIGGER_MATCH"],
    recommendedContentLevel: "L2",
    recommendedContentTokens: 1000,
    l2SizeClass: "NORMAL",
    ...overrides,
  };
}

function compose(rows, options = {}) {
  return composeAutomatic({
    rows,
    maxSkills: 1,
    maxTokens: 5000,
    ...options,
  });
}

function evidence(category, value) {
  return { category, value };
}

test("L1 row is selected with its authored level and tokens budgeted", () => {
  const result = compose([row("ns/skill", {
    recommendedContentLevel: "L1",
    recommendedContentTokens: 2000,
  })], { maxSkills: 1, maxTokens: 5000 });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "ns/skill");
  assert.equal(result.selected[0].recommendedContentLevel, "L1");
  assert.equal(result.selected[0].recommendedContentTokens, 2000);
  assert.equal(result.automaticSelectedTokens, 2000);
  assert.deepEqual(result.selected[0].warnings, []);
  assert.deepEqual(result.candidates, []);
});

test("L2 fallback row selects with L2 level and tokens", () => {
  const result = compose([row("ns/fallback", {
    recommendedContentLevel: "L2",
    recommendedContentTokens: 500,
  })], { maxSkills: 1, maxTokens: 5000 });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].recommendedContentLevel, "L2");
  assert.equal(result.selected[0].recommendedContentTokens, 500);
  assert.equal(result.automaticSelectedTokens, 500);
});

test("4900-token L2 fits the 5000 default budget", () => {
  const result = compose([row("ns/bigfit", {
    recommendedContentLevel: "L2",
    recommendedContentTokens: 4900,
  })], { maxSkills: 1, maxTokens: 5000 });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].recommendedContentTokens, 4900);
  assert.equal(result.automaticSelectedTokens, 4900);
  assert.deepEqual(result.candidates, []);
});

test("9000-token LARGE stays candidate with TOKEN_BUDGET under 5K", () => {
  const result = compose([row("ns/large", {
    recommendedContentTokens: 9000,
    l2SizeClass: "LARGE",
  })], { maxSkills: 1, maxTokens: 5000 });

  assert.deepEqual(result.selected, []);
  assert.equal(result.automaticSelectedTokens, 0);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].reasons, ["TASK_TRIGGER_MATCH", "TOKEN_BUDGET"]);
});

test("9000-token LARGE selects under a 10K budget", () => {
  const result = compose([row("ns/large", {
    recommendedContentTokens: 9000,
    l2SizeClass: "LARGE",
  })], { maxSkills: 1, maxTokens: 10000 });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].recommendedContentTokens, 9000);
  assert.equal(result.automaticSelectedTokens, 9000);
  assert.deepEqual(result.candidates, []);
});

test("5100-token LARGE with missing L1 selects under a custom 10K budget", () => {
  const result = compose([row("ns/large-missing-l1", {
    recommendedContentLevel: "L2",
    recommendedContentTokens: 5100,
    l2SizeClass: "LARGE",
  })], { maxSkills: 1, maxTokens: 10000 });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].recommendedContentLevel, "L2");
  assert.equal(result.selected[0].recommendedContentTokens, 5100);
  assert.equal(result.automaticSelectedTokens, 5100);
});

test("13K OVERSIZED never selects, even under a 20K budget (CONTENT_OVERSIZED)", () => {
  const result = compose([row("ns/oversized", {
    recommendedContentTokens: 13000,
    l2SizeClass: "OVERSIZED",
  })], { maxSkills: 1, maxTokens: 20000 });

  assert.deepEqual(result.selected, []);
  assert.equal(result.automaticSelectedTokens, 0);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    result.candidates[0].reasons,
    ["TASK_TRIGGER_MATCH", "CONTENT_OVERSIZED"],
  );
});

test("null recommended tokens never selects: candidate with CONTENT_MISSING", () => {
  const result = compose([row("ns/missing", {
    recommendedContentTokens: null,
  })], { maxSkills: 1, maxTokens: 5000 });

  assert.deepEqual(result.selected, []);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].reasons, ["TASK_TRIGGER_MATCH", "CONTENT_MISSING"]);
});

test("selected totals never exceed maxSkills or maxTokens", () => {
  // Two fitting rows under a 5000 budget with maxSkills 2.
  const fit = compose(
    [
      row("ns/alpha", { recommendedContentTokens: 3000 }),
      row("ns/beta", { recommendedContentTokens: 2000 }),
    ],
    { maxSkills: 2, maxTokens: 5000 },
  );
  assert.equal(fit.selected.length, 2);
  assert.equal(fit.automaticSelectedTokens, 5000);
  assert.equal(fit.automaticSelectedTokens, fit.selected.reduce((sum, s) => sum + s.recommendedContentTokens, 0));

  // A row exceeding the remaining budget must not push the total over.
  const capped = compose(
    [
      row("ns/alpha", { recommendedContentTokens: 3000 }),
      row("ns/beta", { recommendedContentTokens: 2500 }),
      row("ns/gamma", { recommendedContentTokens: 800 }),
    ],
    { maxSkills: 2, maxTokens: 5000 },
  );
  assert.equal(capped.selected.length, 2);
  assert.deepEqual(capped.selected.map((s) => s.id), ["ns/alpha", "ns/gamma"]);
  assert.equal(capped.automaticSelectedTokens, 3800);
  assert.ok(capped.automaticSelectedTokens <= 5000);
  assert.deepEqual(capped.candidates[0].reasons, ["TASK_TRIGGER_MATCH", "TOKEN_BUDGET"]);

  // Many fitting rows under maxSkills 3 are capped at 3.
  const many = compose(
    [
      row("ns/one", { recommendedContentTokens: 100, evidence: [evidence("TASK_TRIGGER", "one")] }),
      row("ns/two", { recommendedContentTokens: 200, evidence: [evidence("TASK_TRIGGER", "two")] }),
      row("ns/three", { recommendedContentTokens: 300, evidence: [evidence("TASK_TRIGGER", "three")] }),
      row("ns/four", { recommendedContentTokens: 400, evidence: [evidence("TASK_TRIGGER", "four")] }),
      row("ns/five", { recommendedContentTokens: 500, evidence: [evidence("TASK_TRIGGER", "five")] }),
    ],
    { maxSkills: 3, maxTokens: 100000 },
  );
  assert.equal(many.selected.length, 3);
  assert.equal(many.automaticSelectedTokens, 600);
  assert.ok(many.automaticSelectedTokens <= 100000);
  assert.deepEqual(many.candidates.map((c) => c.id), ["ns/four", "ns/five"]);
});

test("third selection requires a unique TASK_TRIGGER/DOMAIN value (else candidate)", () => {
  const sameValue = compose(
    [
      row("ns/a", { evidence: [evidence("TASK_TRIGGER", "debug")] }),
      row("ns/b", { evidence: [evidence("TASK_TRIGGER", "debug")] }),
      row("ns/c", { evidence: [evidence("TASK_TRIGGER", "debug")] }),
    ],
    { maxSkills: 3, maxTokens: 100000 },
  );
  assert.deepEqual(sameValue.selected.map((s) => s.id), ["ns/a", "ns/b"]);
  assert.equal(sameValue.selected.length, 2);
  assert.deepEqual(sameValue.candidates.map((c) => c.id), ["ns/c"]);
  // No fabricated negative reason for the composition-limit case.
  assert.deepEqual(sameValue.candidates[0].reasons, ["TASK_TRIGGER_MATCH"]);

  const sharedDomain = compose(
    [
      row("ns/a", { evidence: [evidence("TASK_TRIGGER", "debug")] }),
      row("ns/b", { evidence: [evidence("DOMAIN", "web")] }),
      row("ns/c", {
        evidence: [evidence("TASK_TRIGGER", "debug"), evidence("DOMAIN", "web")],
      }),
    ],
    { maxSkills: 3, maxTokens: 100000 },
  );
  assert.deepEqual(sharedDomain.selected.map((s) => s.id), ["ns/a", "ns/b"]);
  assert.deepEqual(sharedDomain.candidates.map((c) => c.id), ["ns/c"]);
});

test("third selection is taken when it adds a unique strong value", () => {
  const result = compose(
    [
      row("ns/a", { evidence: [evidence("TASK_TRIGGER", "debug")] }),
      row("ns/b", { evidence: [evidence("DOMAIN", "web")] }),
      row("ns/c", {
        evidence: [evidence("TASK_TRIGGER", "debug"), evidence("DOMAIN", "web")],
      }),
      row("ns/d", { evidence: [evidence("TASK_TRIGGER", "data")] }),
    ],
    { maxSkills: 3, maxTokens: 100000 },
  );
  assert.deepEqual(result.selected.map((s) => s.id), ["ns/a", "ns/b", "ns/d"]);
  assert.deepEqual(result.candidates.map((c) => c.id), ["ns/c"]);
  assert.equal(result.automaticSelectedTokens, 3000);
});

test("Tier C is never selected and passes through untouched", () => {
  const result = compose(
    [
      row("ns/alpha", { tier: "A" }),
      row("ns/charlie", {
        tier: "C",
        reasons: ["LEXICAL_MATCH"],
        evidence: [evidence("LEXICAL", "some terms")],
      }),
      row("ns/beta", { tier: "B" }),
    ],
    { maxSkills: 3, maxTokens: 5000 },
  );
  assert.deepEqual(result.selected.map((s) => s.id), ["ns/alpha", "ns/beta"]);
  assert.equal(result.selected.length, 2);
  assert.equal(result.candidates.length, 1);
  const charlie = result.candidates[0];
  assert.equal(charlie.id, "ns/charlie");
  assert.equal(charlie.tier, "C");
  // Untouched: exactly the incoming reasons/evidence, no negatives appended.
  assert.deepEqual(charlie.reasons, ["LEXICAL_MATCH"]);
  assert.deepEqual(charlie.evidence, [evidence("LEXICAL", "some terms")]);
});

test("fitting rows beyond maxSkills stay candidates without fabricated negatives", () => {
  const result = compose(
    [
      row("ns/alpha", { recommendedContentTokens: 100 }),
      row("ns/beta", { recommendedContentTokens: 200 }),
    ],
    { maxSkills: 1, maxTokens: 5000 },
  );
  assert.deepEqual(result.selected.map((s) => s.id), ["ns/alpha"]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, "ns/beta");
  assert.deepEqual(result.candidates[0].reasons, ["TASK_TRIGGER_MATCH"]);
});

test("selected preserves router-rank order, evidence and incoming reasons", () => {
  const result = compose(
    [
      row("ns/first", {
        evidence: [evidence("TASK_TRIGGER", "debug"), evidence("FRAMEWORK", "react")],
        reasons: ["TASK_TRIGGER_MATCH", "FRAMEWORK_MATCH"],
      }),
      row("ns/second", {
        evidence: [evidence("DOMAIN", "web")],
        reasons: ["DOMAIN_MATCH"],
      }),
    ],
    { maxSkills: 2, maxTokens: 5000 },
  );
  assert.deepEqual(result.selected.map((s) => s.id), ["ns/first", "ns/second"]);
  assert.deepEqual(result.selected[0].evidence, [
    evidence("TASK_TRIGGER", "debug"),
    evidence("FRAMEWORK", "react"),
  ]);
  assert.deepEqual(result.selected[0].reasons, ["TASK_TRIGGER_MATCH", "FRAMEWORK_MATCH"]);
  assert.deepEqual(result.selected[1].reasons, ["DOMAIN_MATCH"]);
  assert.deepEqual(result.selected.map((s) => s.warnings), [[], []]);
});