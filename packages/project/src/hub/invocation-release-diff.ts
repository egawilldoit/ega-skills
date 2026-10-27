// I1 release-diff v2. Both semantic envelopes must verify; an I1 candidate
// additionally requires its policy. A prior retained I1 envelope need not
// carry its policy in the new candidate, which only binds its prior identity.
import { createEnvelope, verifyEnvelope } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import { verifyInvocationRelease, verifyInvocationReleaseEnvelope, type InvocationHubRelease } from "./invocation-release.js";
import { DEFAULT_RELEASE_CONTRACTS, verifyHubRelease, type HubRelease } from "./release.js";
import { createReleaseDiff, type ReleaseDiffPayload } from "./release-diff.js";

export interface InvocationReleaseSide { readonly release: unknown; readonly policy?: unknown }
export type InvocationReleaseDiff = {
  readonly object_type: "ega.release-diff";
  readonly schema_version: 2;
  readonly digest: string;
  readonly payload: ReleaseDiffPayload & {
    readonly invocation_policy: {
      readonly previous: { readonly digest: string; readonly profile: string } | null;
      readonly candidate: { readonly digest: string; readonly profile: string } | null;
    };
  };
};

function checked(side: InvocationReleaseSide, prior: boolean): HubRelease | InvocationHubRelease {
  if (side.release !== null && typeof side.release === "object" && (side.release as { schema_version?: unknown }).schema_version === 2) {
    if (prior && side.policy === undefined) verifyInvocationReleaseEnvelope(side.release);
    else verifyInvocationRelease(side.release, side.policy);
    return side.release;
  }
  verifyHubRelease(side.release);
  return side.release;
}

function asV1(release: HubRelease | InvocationHubRelease): HubRelease {
  if (release.schema_version === 1) return release;
  const { invocation_policy_digest: _digest, invocation_profile: _profile, ...payload } = release.payload;
  const derived = createEnvelope({ object_type: "ega.hub-release", schema_version: 1, payload: { ...payload, contracts: DEFAULT_RELEASE_CONTRACTS } });
  verifyHubRelease(derived);
  return derived;
}

function identity(release: HubRelease | InvocationHubRelease): { digest: string; profile: string } | null {
  return release.schema_version === 1 ? null : { digest: release.payload.invocation_policy_digest, profile: release.payload.invocation_profile };
}

/** Compute from independently verified release envelopes, never from a supplied diff. */
export function createInvocationReleaseDiff(previous: InvocationReleaseSide, candidate: InvocationReleaseSide): InvocationReleaseDiff {
  const a = checked(previous, true);
  const b = checked(candidate, false);
  if (a.schema_version === 1 && b.schema_version === 1) throw new HubError("E_RELEASE_SCHEMA", "I1 diff requires at least one I1 release");
  const common = createReleaseDiff(asV1(a), asV1(b)).payload;
  const payload = {
    ...common,
    base_release_digest: a.digest,
    candidate_release_digest: b.digest,
    invocation_policy: { previous: identity(a), candidate: identity(b) },
    status: a.digest === b.digest && common.status === "UNCHANGED" ? "UNCHANGED" : "CHANGED",
  };
  return createEnvelope({ object_type: "ega.release-diff", schema_version: 2, payload }) as InvocationReleaseDiff;
}

/** Validate the entire diff by reproducing it from both verified releases. */
export function verifyInvocationReleaseDiff(value: unknown, previous: InvocationReleaseSide, candidate: InvocationReleaseSide): InvocationReleaseDiff {
  const expected = createInvocationReleaseDiff(previous, candidate);
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["digest", "object_type", "payload", "schema_version"]) ||
      !verifyEnvelope(value).ok || (value as { digest?: unknown }).digest !== expected.digest ||
      (value as { object_type?: unknown }).object_type !== "ega.release-diff" || (value as { schema_version?: unknown }).schema_version !== 2) {
    throw new HubError("E_RELEASE_SCHEMA", "release diff does not match verified releases");
  }
  return value as InvocationReleaseDiff;
}
