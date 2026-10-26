import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { matchInvocationIntent } from "../../packages/router/dist/invocation-match.js";

const contract = readFileSync(new URL("../../docs/contracts/PROPOSED-INVOCATION-POLICY-168.md", import.meta.url), "utf8");
const json = contract.match(/```json\n([\s\S]*?)\n```/);
assert.ok(json, "reviewed policy must be present in contract");
const policy = JSON.parse(json[1]);

test("every reviewed phrase matches only its own skill", () => {
  let count = 0;
  for (const binding of policy.payload.bindings) {
    for (const rule of binding.rules) for (const alternative of rule.alternatives) {
      const task = alternative.map((atom) => atom.literal ?? "#42").join(" ");
      assert.equal(matchInvocationIntent(task, binding.rules), rule.id, task);
      for (const other of policy.payload.bindings.filter((entry) => entry.skill_id !== binding.skill_id)) {
        assert.equal(matchInvocationIntent(task, other.rules), null, `${task}: ${other.skill_id}`);
      }
      count++;
    }
  }
  assert.equal(count, 27);
});

test("incidental, negated, quoted and extra-clause tasks abstain", () => {
  const tasks = ["Investigate why the network full send buffer is saturated", "Design a data model for a city council", "Schedule a city council meeting", "Modernize a city's infrastructure", "Plan a business takeover", "Explain the sol loop", "Do not babysit this pr", '"run council review on this pr"', "run council review on this pr but do not use subagents"];
  for (const task of tasks) for (const binding of policy.payload.bindings) assert.equal(matchInvocationIntent(task, binding.rules), null, `${task}: ${binding.skill_id}`);
});

test("normalization and PR token boundaries follow I1 exactly", () => {
  const rules = policy.payload.bindings.find((binding) => binding.skill_id === "t3dotgg/council").rules;
  assert.equal(matchInvocationIntent(" \tRUN council review on PR #42!\n", rules), "council-intent");
  for (const task of ["run council review on pr #", "run council review on pr #1234567890", "run council review on pr #42!!", "run council review on pr #42\u00a0"]) assert.equal(matchInvocationIntent(task, rules), null, task);
});
