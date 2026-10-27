// I1 semantic release verification. Candidate activation must additionally
// verify its physical artifacts, provenance and publication authority.
import { createEnvelope, verifyEnvelope } from "@ega-skills/hashing";
import { INVOCATION_PROFILE, InvocationPolicyError, validateInvocationPolicy, type InvocationPolicy } from "./invocation-policy.js";
import { DEFAULT_RELEASE_CONTRACTS, verifyHubRelease, type HubRelease, type HubReleasePayload, type ReleaseArtifacts } from "./release.js";

export type InvocationHubRelease = {
  readonly object_type: "ega.hub-release";
  readonly schema_version: 2;
  readonly digest: string;
  readonly payload: HubReleasePayload & {
    readonly invocation_policy_digest: string;
    readonly invocation_profile: typeof INVOCATION_PROFILE;
  };
};

/** Verify the complete semantic envelope; this alone cannot activate a release. */
export function verifyInvocationReleaseEnvelope(release: unknown, artifacts?: ReleaseArtifacts): asserts release is InvocationHubRelease {
  if (release === null || typeof release !== "object" || Array.isArray(release)) throw new InvocationPolicyError("release must be an object");
  const envelope = release as Record<string, unknown>;
  if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["digest", "object_type", "payload", "schema_version"]) ||
      envelope["object_type"] !== "ega.hub-release" || envelope["schema_version"] !== 2 || !verifyEnvelope(release).ok) {
    throw new InvocationPolicyError("invalid I1 release envelope");
  }
  const payload = envelope["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new InvocationPolicyError("invalid I1 release payload");
  const record = payload as Record<string, unknown>;
  if (record["invocation_profile"] !== INVOCATION_PROFILE || typeof record["invocation_policy_digest"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record["invocation_policy_digest"])) {
    throw new InvocationPolicyError("invalid release policy identity");
  }
  const contracts = record["contracts"];
  if (contracts === null || typeof contracts !== "object" || Array.isArray(contracts) ||
      JSON.stringify(Object.entries(contracts as Record<string, unknown>).sort()) !== JSON.stringify(Object.entries({ ...DEFAULT_RELEASE_CONTRACTS, router: 2, build_contract: "C2" }).sort())) {
    throw new InvocationPolicyError("invalid I1 release contracts");
  }
  // Reuse the frozen V1 payload and artifact checks, without accepting this
  // derived envelope as an actual release or changing the V1 verifier.
  const { invocation_profile: _profile, invocation_policy_digest: _digest, ...base } = record;
  const v1Payload = { ...base, contracts: DEFAULT_RELEASE_CONTRACTS };
  const v1 = createEnvelope({ object_type: "ega.hub-release", schema_version: 1, payload: v1Payload });
  try {
    verifyHubRelease(v1, artifacts);
  } catch (error) {
    throw new InvocationPolicyError(`invalid I1 release payload or artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Verify the policy against the semantic release, not just its own digest. */
export function verifyInvocationRelease(release: unknown, policy: unknown, artifacts?: ReleaseArtifacts): asserts release is InvocationHubRelease {
  const checkedPolicy = validateInvocationPolicy(policy);
  verifyInvocationReleaseEnvelope(release, artifacts);
  if (release.payload.invocation_policy_digest !== checkedPolicy.digest) throw new InvocationPolicyError("release policy identity mismatch");
  const sources = new Map(release.payload.adopted_sources.map((source) => [source.source_id, source]));
  for (const source of checkedPolicy.payload.sources) {
    if (sources.get(source.source_id)?.resolved_commit !== source.resolved_commit) throw new InvocationPolicyError(`source binding mismatch: ${source.source_id}`);
  }
  for (const binding of checkedPolicy.payload.bindings) {
    if (release.payload.skill_versions[binding.skill_id] !== binding.version_hash) throw new InvocationPolicyError(`skill binding mismatch: ${binding.skill_id}`);
  }
  // I1's initial TStack introduction requires the complete reviewed roster.
  if (release.payload.adopted_sources.some((source) => source.source_id === "t3dotgg-tstack")) {
    const expected = ["babysit-pr", "council", "file-pr", "full-send", "full-stop", "leaving-pr-comments", "modernize", "sol-loop", "takeover"].map((name) => `t3dotgg/${name}`);
    const source = checkedPolicy.payload.sources.find((item) => item.source_id === "t3dotgg-tstack");
    if (!source || JSON.stringify(source.governed_skill_ids) !== JSON.stringify(expected)) throw new InvocationPolicyError("TStack governance roster is incomplete");
  }
}

/** Reject forward governance changes until a separately reviewed migration is supported. */
export function verifyInvocationTransition(previous: { release: HubRelease | InvocationHubRelease; policy?: InvocationPolicy }, next: { release: HubRelease | InvocationHubRelease; policy?: InvocationPolicy }): void {
  if (previous.release.schema_version === 1) verifyHubRelease(previous.release);
  else verifyInvocationRelease(previous.release, previous.policy);
  if (next.release.schema_version === 1) verifyHubRelease(next.release);
  else verifyInvocationRelease(next.release, next.policy);
  if (previous.release.schema_version === 1) return;
  if (next.release.schema_version === 1 || !previous.policy || !next.policy) throw new InvocationPolicyError("forward removal of invocation policy requires a reviewed migration");
  const nextBindings = new Map(next.policy.payload.bindings.map((binding) => [binding.skill_id, binding]));
  const previousSources = new Map(previous.release.payload.adopted_sources.map((source) => [source.source_id, source]));
  const nextSources = new Map(next.release.payload.adopted_sources.map((source) => [source.source_id, source]));
  for (const old of previous.policy.payload.bindings) {
    if (next.release.payload.skill_versions[old.skill_id] === undefined) continue;
    const current = nextBindings.get(old.skill_id);
    if (!current || current.source_id !== old.source_id || current.version_hash !== old.version_hash || JSON.stringify(previousSources.get(old.source_id)) !== JSON.stringify(nextSources.get(old.source_id))) throw new InvocationPolicyError("governance change requires a reviewed migration");
  }
}

/** Construct a V2 semantic envelope from an already verified V1 projection. */
export function createInvocationRelease(base: HubRelease, policy: InvocationPolicy, artifacts?: ReleaseArtifacts): InvocationHubRelease {
  verifyHubRelease(base, artifacts);
  validateInvocationPolicy(policy);
  const payload = {
    ...base.payload,
    contracts: { ...DEFAULT_RELEASE_CONTRACTS, router: 2, build_contract: "C2" },
    invocation_policy_digest: policy.digest,
    invocation_profile: INVOCATION_PROFILE,
  };
  const release = createEnvelope({ object_type: "ega.hub-release", schema_version: 2, payload });
  verifyInvocationRelease(release, policy, artifacts);
  return release;
}
