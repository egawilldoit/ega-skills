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

/** Verify the policy against the semantic release, not just its own digest. */
export function verifyInvocationRelease(release: unknown, policy: unknown, artifacts?: ReleaseArtifacts): asserts release is InvocationHubRelease {
  const checkedPolicy = validateInvocationPolicy(policy);
  if (release === null || typeof release !== "object" || Array.isArray(release)) throw new InvocationPolicyError("release must be an object");
  const envelope = release as Record<string, unknown>;
  if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["digest", "object_type", "payload", "schema_version"]) ||
      envelope["object_type"] !== "ega.hub-release" || envelope["schema_version"] !== 2 || !verifyEnvelope(release).ok) {
    throw new InvocationPolicyError("invalid I1 release envelope");
  }
  const payload = envelope["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new InvocationPolicyError("invalid I1 release payload");
  const record = payload as Record<string, unknown>;
  if (record["invocation_profile"] !== INVOCATION_PROFILE || record["invocation_policy_digest"] !== checkedPolicy.digest) {
    throw new InvocationPolicyError("release policy identity mismatch");
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
  verifyHubRelease(v1, artifacts);
  const sources = new Map(v1.payload.adopted_sources.map((source) => [source.source_id, source]));
  for (const source of checkedPolicy.payload.sources) {
    if (sources.get(source.source_id)?.resolved_commit !== source.resolved_commit) throw new InvocationPolicyError(`source binding mismatch: ${source.source_id}`);
  }
  for (const binding of checkedPolicy.payload.bindings) {
    if (v1.payload.skill_versions[binding.skill_id] !== binding.version_hash) throw new InvocationPolicyError(`skill binding mismatch: ${binding.skill_id}`);
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
