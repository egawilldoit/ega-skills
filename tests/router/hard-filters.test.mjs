import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  applyAutomaticFilters,
  normalizeTaskTerms,
} from "../../packages/router/dist/index.js";

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

function run(candidates, overrides = {}) {
  return applyAutomaticFilters({ candidates, ...overrides });
}

function rejectShape(candidate, reason) {
  return {
    id: candidate.canonicalId,
    name: candidate.portableName,
    versionHash: candidate.versionHash,
    evidence: [],
    reasons: [reason],
  };
}

// SPEC-004 §5.1.15 fixed order: namespace, skills.deny, lock, platform, anti-trigger.

test("SPEC-004 §5.1.15: namespaces.deny rejects with NAMESPACE_DENIED", () => {
  const a = skill("blocked/a");
  const b = skill("ega/b");
  const result = run([a, b], { policy: { deniedNamespaces: ["blocked"] } });
  assert.deepEqual(result.passed.map((s) => s.canonicalId), ["ega/b"]);
  assert.deepEqual(result.rejected, [rejectShape(a, "NAMESPACE_DENIED")]);
});

test("SPEC-004 §5.1.15: non-empty namespaces.allow lacking the namespace rejects", () => {
  const a = skill("other/a");
  const b = skill("ega/b");
  const result = run([a, b], { policy: { allowedNamespaces: ["ega"] } });
  assert.deepEqual(result.rejected, [rejectShape(a, "NAMESPACE_DENIED")]);
  assert.deepEqual(result.passed.map((s) => s.canonicalId), ["ega/b"]);
});

test("SPEC-004 §5.1.15: skills.deny rejects with SKILL_DENIED", () => {
  const a = skill("ega/blocked");
  const b = skill("ega/fine");
  const result = run([a, b], { policy: { deniedSkills: ["ega/blocked"] } });
  assert.deepEqual(result.rejected, [rejectShape(a, "SKILL_DENIED")]);
  assert.deepEqual(result.passed.map((s) => s.canonicalId), ["ega/fine"]);
});

test("SPEC-004 §5.1.15: locked mode version mismatch rejects with VERSION_NOT_LOCKED", () => {
  const a = skill("ega/a");
  const locked = new Map([["ega/a", "sha256:stale"]]);
  const result = run([a], { policy: { lockedVersions: locked } });
  assert.deepEqual(result.rejected, [rejectShape(a, "VERSION_NOT_LOCKED")]);
  assert.deepEqual(result.passed, []);
});

test("SPEC-004 §5.1.15: locked mode exact match passes", () => {
  const a = skill("ega/a");
  const b = skill("ega/b");
  const locked = new Map([
    [a.canonicalId, a.versionHash],
    [b.canonicalId, b.versionHash],
  ]);
  const result = run([a, b], { policy: { lockedVersions: locked } });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.passed.map((s) => s.canonicalId), ["ega/a", "ega/b"]);
});

test("SPEC-004 §5.1.15: strong platform mismatch rejects with PLATFORM_MISMATCH", () => {
  const web = skill("ega/web", { platforms: ["web"] });
  const result = run([web], { projectPlatforms: ["mobile"] });
  assert.deepEqual(result.rejected, [rejectShape(web, "PLATFORM_MISMATCH")]);
  assert.deepEqual(result.passed, []);
});

test("SPEC-004 §5.1.15: missing project platforms never mismatch", () => {
  const web = skill("ega/web", { platforms: ["web"] });
  const result = run([web], { projectPlatforms: [] });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.passed, [web]);
  const absent = run([web]); // projectPlatforms defaults to empty
  assert.deepEqual(absent.rejected, []);
  assert.deepEqual(absent.passed, [web]);
});

test("SPEC-004 §5.1.15: empty skill platforms never mismatch", () => {
  const generic = skill("ega/generic", { platforms: [] });
  const result = run([generic], { projectPlatforms: ["mobile"] });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.passed, [generic]);
});

test("SPEC-004 §5.1.15: strong anti-trigger match rejects with ANTI_TRIGGER_MATCH", () => {
  const risky = skill("ega/risky", { antiTriggers: ["no-react"] });
  const terms = normalizeTaskTerms("please do it with no react here");
  const result = run([risky], { taskTerms: terms });
  assert.deepEqual(result.rejected, [rejectShape(risky, "ANTI_TRIGGER_MATCH")]);
  assert.deepEqual(result.passed, []);
});

test("SPEC-004 §5.1.15: empty task terms never match an anti-trigger", () => {
  const risky = skill("ega/risky", { antiTriggers: ["no-react"] });
  const empty = run([risky], { taskTerms: [] }); // taskTerms defaults to empty
  assert.deepEqual(empty.rejected, []);
  assert.deepEqual(empty.passed, [risky]);
  const absent = run([risky]);
  assert.deepEqual(absent.rejected, []);
  assert.deepEqual(absent.passed, [risky]);
});

test("SPEC-004 §5.1.15: neutral policy passes every candidate untouched", () => {
  const a = skill("ega/a", { platforms: ["web"] });
  const b = skill("other/b", { antiTriggers: ["no-react"] });
  const result = run([a, b]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.passed, [a, b]);
  assert.ok(result.passed[0] === a && result.passed[1] === b);
});

test("SPEC-004 §5.1.15: first match wins for a candidate tripping several conditions", () => {
  const deniedNs = skill("blocked/x", {
    platforms: ["web"],
    antiTriggers: ["no-react"],
  });
  const deniedSkill = skill("ega/blocked", {
    platforms: ["web"],
    antiTriggers: ["no-react"],
  });
  const lockedWrong = skill("ega/locked", { platforms: ["web"] });
  const mismatch = skill("ega/mismatch", { platforms: ["web"] });
  const locked = new Map([
    ["ega/locked", "sha256:stale"],
    ["ega/mismatch", mismatch.versionHash],
  ]);
  const terms = normalizeTaskTerms("do it with no react");
  const result = run([deniedNs, deniedSkill, lockedWrong, mismatch], {
    policy: { deniedNamespaces: ["blocked"], deniedSkills: ["ega/blocked"], lockedVersions: locked },
    projectPlatforms: ["mobile"],
    taskTerms: terms,
  });
  assert.deepEqual(result.rejected.map((s) => s.reasons), [
    ["NAMESPACE_DENIED"],
    ["SKILL_DENIED"],
    ["VERSION_NOT_LOCKED"],
    ["PLATFORM_MISMATCH"],
  ]);
  assert.deepEqual(result.passed, []);
});

test("SPEC-004 §5.1.15: passed preserves input order", () => {
  const c = skill("ega/c");
  const a = skill("ega/a", { antiTriggers: ["no-react"] });
  const e = skill("ega/e");
  const b = skill("ega/b", { platforms: ["web"] });
  const result = run([c, a, e, b], {
    projectPlatforms: ["mobile"],
    taskTerms: normalizeTaskTerms("build with no react"),
  });
  assert.deepEqual(result.passed.map((s) => s.canonicalId), ["ega/c", "ega/e"]);
  assert.deepEqual(result.rejected.map((s) => s.id), ["ega/a", "ega/b"]);
  assert.deepEqual(result.rejected.map((s) => s.reasons), [["ANTI_TRIGGER_MATCH"], ["PLATFORM_MISMATCH"]]);
});
