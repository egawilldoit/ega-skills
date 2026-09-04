import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normalizeTaskTerms, resolveExplicitSkills } from "../../packages/router/dist/index.js";
import { RouterError } from "../../packages/router/dist/errors.js";

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
    l2SizeClass: "NORMAL",
    platforms: [],
    antiTriggers: [],
    ...overrides,
  };
}

function base(overrides = {}) {
  const eligible = new Map((overrides.eligible ?? []).map((row) => [row.canonicalId, row]));
  const known = overrides.knownSkills ?? [...eligible.values()].map((row) => ({
    canonicalId: row.canonicalId,
    aliases: row.aliases,
  }));
  return {
    references: [],
    knownSkills: known,
    eligible,
    maxTokens: 5000,
    ...overrides,
    eligible,
    knownSkills: known,
  };
}

function isRouterError(code) {
  return (error) => error instanceof RouterError && error.code === code;
}

// SPEC-004 §5.1.3 resolution order.

test("SPEC-004 §5.1.3: canonical ID beats alias beats bare name", () => {
  const a = skill("ega/alpha", { aliases: ["tool"] });
  const b = skill("ega/tool");
  const input = base({ eligible: [a, b] });
  assert.deepEqual(
    resolveExplicitSkills({ ...input, references: ["ega/tool"] }).explicit.map((s) => s.id),
    ["ega/tool"],
  );
  assert.deepEqual(
    resolveExplicitSkills({ ...input, references: ["tool"] }).explicit.map((s) => s.id),
    ["ega/alpha"],
  );
});

test("SPEC-004 §5.1.2: resolved references dedupe preserving first occurrence", () => {
  const a = skill("ega/a", { aliases: ["a-alias"] });
  const b = skill("ega/b");
  const result = resolveExplicitSkills(base({ eligible: [a, b], references: ["ega/b", "a-alias", "ega/a", "ega/b"] }));
  assert.deepEqual(result.explicit.map((s) => s.id), ["ega/b", "ega/a"]);
  assert.deepEqual(result.rejected, []);
  assert.ok(result.explicit.every((s) => s.tier === "E"));
});

test("SPEC-004 §5.1.2: hard limit and empty references are request-invalid", () => {
  const a = skill("ega/a");
  const input = base({ eligible: [a] });
  assert.throws(
    () => resolveExplicitSkills({ ...input, references: Array(11).fill("ega/a") }),
    isRouterError("E_RESOLVE_REQUEST_INVALID"),
  );
  assert.throws(
    () => resolveExplicitSkills({ ...input, references: ["   "] }),
    isRouterError("E_RESOLVE_REQUEST_INVALID"),
  );
  assert.deepEqual(
    resolveExplicitSkills({ ...input, references: Array(10).fill("ega/a") }).explicit.map((s) => s.id),
    ["ega/a"],
  );
});

test("SPEC-004 §5.1.4: unknown references abort the call", () => {
  const a = skill("ega/a", { aliases: ["known-alias"] });
  const input = base({ eligible: [a] });
  assert.throws(() => resolveExplicitSkills({ ...input, references: ["ega/missing"] }), isRouterError("E_SKILL_NOT_FOUND"));
  assert.throws(() => resolveExplicitSkills({ ...input, references: ["no-such-alias"] }), isRouterError("E_SKILL_NOT_FOUND"));
  assert.throws(() => resolveExplicitSkills({ ...input, references: ["no-such-name"] }), isRouterError("E_SKILL_NOT_FOUND"));
});

test("SPEC-004 §5.1.4: ambiguous visible bare name aborts the call", () => {
  const a = skill("ns-a/dup");
  const b = skill("ns-b/dup");
  const input = base({ eligible: [a, b] });
  assert.throws(() => resolveExplicitSkills({ ...input, references: ["dup"] }), isRouterError("E_SKILL_REFERENCE_AMBIGUOUS"));
});

test("SPEC-004 §5.1.4: bare-name uniqueness is scoped to eligible skills", () => {
  const eligibleOne = skill("ns-a/shared");
  const known = [
    { canonicalId: "ns-a/shared", aliases: [] },
    { canonicalId: "ns-b/shared", aliases: [] },
  ];
  const eligible = new Map([[eligibleOne.canonicalId, eligibleOne]]);
  const result = resolveExplicitSkills({ references: ["shared"], knownSkills: known, eligible, maxTokens: 5000 });
  assert.deepEqual(result.explicit.map((s) => s.id), ["ns-a/shared"]);
});

// SPEC-004 §5.1.4 validity (bypass ranking, never validity).

test("SPEC-004 §5.1.4: locked-out exact ID rejects without aborting", () => {
  const a = skill("ega/a");
  const locked = new Map();
  const result = resolveExplicitSkills(
    base({ eligible: [a], references: ["ega/a"], policy: { lockedVersions: locked } }),
  );
  assert.deepEqual(result.explicit, []);
  assert.deepEqual(result.rejected, [
    { id: "ega/a", name: "a", versionHash: a.versionHash, evidence: [], reasons: ["VERSION_NOT_LOCKED"] },
  ]);
});

test("SPEC-004 §5.1.4: locked match carries LOCKED_VERSION with user order", () => {
  const a = skill("ega/a");
  const b = skill("ega/b");
  const locked = new Map([
    [a.canonicalId, a.versionHash],
    [b.canonicalId, b.versionHash],
  ]);
  const result = resolveExplicitSkills(
    base({ eligible: [a, b], references: ["ega/b", "ega/a"], policy: { lockedVersions: locked } }),
  );
  assert.deepEqual(result.explicit.map((s) => s.id), ["ega/b", "ega/a"]);
  assert.ok(result.explicit.every((s) => s.tier === "E"));
  assert.deepEqual(result.explicit[0].reasons, ["EXPLICIT_USER", "LOCKED_VERSION"]);
});

test("SPEC-004 §5.1.4: policy denials reject with version when known", () => {
  const a = skill("ega/a");
  const b = skill("other/b");
  const denied = base({
    eligible: [a, b],
    references: ["ega/a", "other/b"],
    policy: { deniedNamespaces: ["other"], deniedSkills: ["ega/a"] },
  });
  const result = resolveExplicitSkills(denied);
  assert.deepEqual(result.explicit, []);
  assert.deepEqual(result.rejected, [
    { id: "ega/a", name: "a", versionHash: a.versionHash, evidence: [], reasons: ["SKILL_DENIED"] },
    { id: "other/b", name: "b", versionHash: b.versionHash, evidence: [], reasons: ["NAMESPACE_DENIED"] },
  ]);
  const allowed = resolveExplicitSkills(
    base({ eligible: [a, b], references: ["ega/a"], policy: { allowedNamespaces: ["ega"] } }),
  );
  assert.deepEqual(allowed.explicit.map((s) => s.id), ["ega/a"]);
  const blocked = resolveExplicitSkills(
    base({ eligible: [a], references: ["ega/a"], policy: { allowedNamespaces: ["other"] } }),
  );
  assert.deepEqual(blocked.rejected.map((s) => s.reasons), [["NAMESPACE_DENIED"]]);
});

test("SPEC-004 §5.1.4: unlocked known-but-ineligible skill is VERSION_MISSING", () => {
  const known = [{ canonicalId: "ega/ghost", aliases: [] }];
  const result = resolveExplicitSkills({ references: ["ega/ghost"], knownSkills: known, eligible: new Map(), maxTokens: 5000 });
  assert.deepEqual(result.rejected, [{ id: "ega/ghost", name: "ghost", evidence: [], reasons: ["VERSION_MISSING"] }]);
});

// SPEC-004 §5.1.4 warnings (never hidden filters).

test("SPEC-004 §5.1.4: platform mismatch warns without rejecting", () => {
  const web = skill("ega/web", { platforms: ["web"] });
  const result = resolveExplicitSkills(
    base({ eligible: [web], references: ["ega/web"], projectPlatforms: ["mobile"] }),
  );
  assert.equal(result.explicit.length, 1);
  assert.deepEqual(result.explicit[0].warnings, ["EXPLICIT_PLATFORM_MISMATCH"]);
  assert.deepEqual(result.explicit[0].reasons, ["EXPLICIT_USER"]);
  const neutral = resolveExplicitSkills(base({ eligible: [web], references: ["ega/web"] }));
  assert.deepEqual(neutral.explicit[0].warnings, []);
});

test("SPEC-004 §5.1.4: anti-trigger and oversize warn without rejecting", () => {
  const risky = skill("ega/risky", { antiTriggers: ["no-react"], l2SizeClass: "OVERSIZED", l2Tokens: 13000 });
  const terms = normalizeTaskTerms("please do it with no react here");
  const result = resolveExplicitSkills(base({ eligible: [risky], references: ["ega/risky"], taskTerms: terms }));
  assert.equal(result.explicit.length, 1);
  assert.deepEqual(result.explicit[0].warnings, ["EXPLICIT_ANTI_TRIGGER_MATCH", "EXPLICIT_CONTENT_OVERSIZED"]);
  const calm = resolveExplicitSkills(
    base({ eligible: [risky], references: ["ega/risky"], taskTerms: normalizeTaskTerms("unrelated task") }),
  );
  assert.deepEqual(calm.explicit[0].warnings, ["EXPLICIT_CONTENT_OVERSIZED"]);
});

// SPEC-004 §5.1.5 separate budgets.

test("SPEC-004 §5.1.5: explicit accounting uses L1 when authored else L2", () => {
  const l1 = skill("ega/l1", { l1Status: "AUTHORED", l1Tokens: 600, l2Tokens: 1500 });
  const l2 = skill("ega/l2", { l2Tokens: 1200 });
  const result = resolveExplicitSkills(base({ eligible: [l1, l2], references: ["ega/l1", "ega/l2"] }));
  assert.equal(result.explicit[0].recommendedContentLevel, "L1");
  assert.equal(result.explicit[0].recommendedContentTokens, 600);
  assert.equal(result.explicit[1].recommendedContentLevel, "L2");
  assert.equal(result.explicit[1].recommendedContentTokens, 1200);
  assert.equal(result.explicitSelectedTokens, 1800);
  assert.equal(result.budgetStatus, "WITHIN_BUDGET");
});

test("SPEC-004 §5.1.5: over-budget explicits stay explicit with their own counter", () => {
  const big = skill("ega/big", { l2Tokens: 9000, l2SizeClass: "LARGE" });
  const small = skill("ega/small", { l2Tokens: 400 });
  const result = resolveExplicitSkills(
    base({ eligible: [big, small], references: ["ega/big", "ega/small"], maxTokens: 1000 }),
  );
  assert.deepEqual(result.explicit.map((s) => s.id), ["ega/big", "ega/small"]);
  assert.equal(result.explicitSelectedTokens, 9400);
  assert.equal(result.budgetStatus, "EXPLICIT_OVER_BUDGET");
});

test("SPEC-004 §5.1.5: explicit list is not capped by automatic maxSkills", () => {
  const rows = ["a", "b", "c", "d"].map((name) => skill(`ega/${name}`));
  const result = resolveExplicitSkills(
    base({ eligible: rows, references: rows.map((row) => row.canonicalId) }),
  );
  assert.equal(result.explicit.length, 4);
  assert.equal(result.explicitSelectedTokens, 400);
});
