import assert from "node:assert/strict";
import test from "node:test";
import { assignTiers, assessConfidence, composeAutomatic, isFrozenReasonCode, suppressRedundant } from "../../packages/router/dist/index.js";

const base = { canonicalId: "t3dotgg/council", portableName: "council", aliases: [], versionHash: "v", l1Status: "AUTHORED", l1Tokens: 10, l2Tokens: 20, platforms: [], frameworks: [], triggers: [], domains: [], description: "" };

test("verified workflow evidence can rank and select without a lexical hit", () => {
  const { ranked: [ranked] } = assignTiers({ candidates: [{ ...base, workflowIntent: "t3dotgg/council:review" }], task: "ask independent reviewers", projectFrameworks: [], projectPlatforms: [] });
  assert.equal(ranked.tier, "B");
  assert.deepEqual(ranked.evidence, [{ category: "WORKFLOW_INTENT", value: "t3dotgg/council:review" }]);
  assert.deepEqual(ranked.reasons, ["WORKFLOW_INTENT_MATCH"]);
  assert.equal(isFrozenReasonCode("WORKFLOW_INTENT_MATCH"), false);
  const row = { ...ranked, name: "council", versionHash: "v", recommendedContentLevel: "L1", l2SizeClass: "NORMAL" };
  const composed = composeAutomatic({ rows: [row], maxSkills: 3, maxTokens: 100, locked: true });
  assert.deepEqual(composed.selected[0].reasons, ["LOCKED_VERSION", "WORKFLOW_INTENT_MATCH"]);
  assert.equal(assessConfidence({ selected: composed.selected, candidates: [], automaticSelectedTokens: 10, workspaceAmbiguous: false }).confidence, "MEDIUM");
});

test("a governed match cannot suppress an ungoverned row and workflow coverage remains separate", () => {
  const workflow = { id: "a", name: "a", versionHash: "v", tier: "B", governed: true, evidence: [{ category: "TASK_TRIGGER", value: "x" }, { category: "WORKFLOW_INTENT", value: "a:r" }] };
  const old = { id: "b", name: "b", versionHash: "v", tier: "B", evidence: [{ category: "TASK_TRIGGER", value: "x" }] };
  const other = { id: "c", name: "c", versionHash: "v", tier: "B", governed: true, evidence: [{ category: "TASK_TRIGGER", value: "x" }, { category: "WORKFLOW_INTENT", value: "c:r" }] };
  assert.deepEqual(suppressRedundant({ rows: [workflow, old, other] }).kept.map((r) => r.id), ["a", "b", "c"]);
});
