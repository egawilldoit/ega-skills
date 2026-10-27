import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import { createInvocationRelease, createInvocationReleaseDiff, DEFAULT_RELEASE_CONTRACTS, parseInvocationPolicy, validateInvocationPolicy, verifyHubRelease, verifyInvocationRelease, verifyInvocationReleaseDiff } from "../../packages/project/dist/index.js";

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

test("I1 release binds policy, source commit and exact skill versions while V1 readers reject it", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const payload = {
    hub_id: "test", skill_versions: Object.fromEntries(reviewed.payload.bindings.map((b) => [b.skill_id, b.version_hash])),
    alias_map_digest: digest, search_index_input_digest: digest, token_artifact_digest: digest,
    adopted_sources: [{ source_id: "t3dotgg-tstack", source_config_digest: digest, resolved_commit: reviewed.payload.sources[0].resolved_commit, selected_skill_tree_digest: digest, vendored_snapshot_digest: digest }],
    contracts: DEFAULT_RELEASE_CONTRACTS, build: { fresh_registry: true, import_failures: 0, expected_catalog_match: true },
  };
  const base = createEnvelope({ object_type: "ega.hub-release", schema_version: 1, payload });
  verifyHubRelease(base);
  const v2 = createInvocationRelease(base, reviewed);
  verifyInvocationRelease(v2, reviewed);
  assert.throws(() => verifyHubRelease(v2), { code: "E_RELEASE_SCHEMA" });
  for (const change of [
    (p) => { p.invocation_policy_digest = digest; },
    (p) => { p.adopted_sources[0].resolved_commit = "a".repeat(40); },
    (p) => { p.skill_versions["t3dotgg/council"] = digest; },
    (p) => { p.contracts.router = 1; },
    (p) => { p.unexpected = true; },
  ]) {
    const changed = structuredClone(v2.payload);
    change(changed);
    const resigned = createEnvelope({ object_type: "ega.hub-release", schema_version: 2, payload: changed });
    assert.throws(() => verifyInvocationRelease(resigned, reviewed));
  }
  assert.throws(() => verifyInvocationRelease(v2, undefined), { code: "E_INVOCATION_POLICY_INVALID" });
  const previous = { release: base };
  const candidate = { release: v2, policy: reviewed };
  const diff = createInvocationReleaseDiff(previous, candidate);
  assert.equal(diff.payload.status, "CHANGED");
  assert.equal(diff.payload.invocation_policy.previous, null);
  assert.equal(diff.payload.invocation_policy.candidate.digest, reviewed.digest);
  assert.equal(verifyInvocationReleaseDiff(diff, previous, candidate).digest, diff.digest);
  const substituted = structuredClone(diff.payload);
  substituted.invocation_policy.previous = substituted.invocation_policy.candidate;
  assert.throws(() => verifyInvocationReleaseDiff(createEnvelope({ object_type: "ega.release-diff", schema_version: 2, payload: substituted }), previous, candidate));
  assert.throws(() => verifyInvocationReleaseDiff(diff, candidate, previous));
  assert.equal(createInvocationReleaseDiff(candidate, candidate).payload.status, "UNCHANGED");
  assert.equal(createInvocationReleaseDiff(candidate, previous).payload.invocation_policy.candidate, null);
});
