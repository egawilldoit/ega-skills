import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import { parseInvocationPolicy, validateInvocationPolicy } from "../../packages/project/dist/index.js";

const contract = readFileSync(new URL("../../docs/contracts/PROPOSED-INVOCATION-POLICY-168.md", import.meta.url), "utf8");
const raw = contract.match(/```json\n([\s\S]*?)\n```/)[1];
const reviewed = JSON.parse(raw);
function resign(policy) {
  return createEnvelope({ object_type: policy.object_type, schema_version: policy.schema_version, payload: policy.payload });
}
function rejected(change) {
  const policy = structuredClone(reviewed);
  change(policy);
  assert.throws(() => validateInvocationPolicy(resign(policy)), { code: "E_INVOCATION_POLICY_INVALID" });
}

test("reviewed policy validates with its frozen digest", () => {
  assert.equal(parseInvocationPolicy(raw).digest, "sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6");
});

test("rejects duplicate keys, malformed JSON and tampered envelopes", () => {
  assert.throws(() => parseInvocationPolicy(raw.replace('"object_type":', '"object_type": "wrong", "object_type":')), { code: "E_INVOCATION_POLICY_INVALID" });
  assert.throws(() => parseInvocationPolicy('{"invalid":'), { code: "E_INVOCATION_POLICY_INVALID" });
  const tampered = structuredClone(reviewed);
  tampered.payload.bindings[0].version_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateInvocationPolicy(tampered), { code: "E_INVOCATION_POLICY_INVALID" });
});

test("rejects missing, stale, malformed and overlapping binding structure", () => {
  rejected((p) => { p.payload.bindings.pop(); });
  rejected((p) => { p.payload.bindings[0].source_id = "unknown"; });
  rejected((p) => { p.payload.bindings[0].version_hash = "sha256:stale"; });
  rejected((p) => { p.payload.bindings[0].unknown = true; });
  rejected((p) => { p.payload.bindings.reverse(); });
  rejected((p) => { p.payload.bindings[1].rules[0].alternatives = structuredClone(p.payload.bindings[0].rules[0].alternatives); });
  rejected((p) => { p.payload.bindings[0].rules[0].alternatives[0][0] = { literal: "UPPER" }; });
  rejected((p) => { p.payload.bindings[0].rules[0].alternatives[0].push({ pr_number: false }); });
});
