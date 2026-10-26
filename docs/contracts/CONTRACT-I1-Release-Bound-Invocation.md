# Contract I1: release-bound invocation policy

**Status:** PROPOSED; not frozen. Intended to be normative for the
`ega-invocation-policy-v1` profile only after independent review and explicit
owner acceptance of the identified gate distinction. This contract does not authorize skill
adoption, release publication, deployment, or actions by an executing host.

## Authority and version boundary

The complete technical requirements in sections 1–6 of
[the issue 168 invocation-policy proposal](PROPOSED-INVOCATION-POLICY-168.md)
are incorporated by reference as the normative I1 profile. The incorporated
file is the owner-approved text with SHA-256
`0af7ec5792f91b75a29aeb03fa5c011d1938c942236f0fc031d8b3923e334e73`;
its introductory draft-status notices describe its original review state and
are not I1 requirements. In particular, the incorporated requirement to
accept amendments before implementation is satisfied only when I1 and its
corresponding specification references are reviewed and frozen. If the
incorporated bytes change, this binding is invalid until a separately reviewed
and owner-approved amendment records their new identity.

I1 is an explicitly versioned successor profile, not a reinterpretation of
SPEC-004 V1, SPEC-006 V1, C1, D, R1 v1/v2 or R2 retained releases. The existing
contracts continue to govern releases and requests that do not select I1. For
I1 releases, the incorporated profile defines the specific deltas to those
contracts and the release, candidate, local and hosted verification rules.
The frozen V1 pipeline remains authoritative except where those profile-specific
deltas expressly apply. Older readers must reject an unsupported I1 release.

The policy digest in the incorporated proposal identifies a proposed policy,
not an adoption or publication approval. Before adoption, exact source,
version and release identities must be independently certified and approved by
the owner. Execution restrictions must be enforced by the executing host; this
read-only contract cannot itself prevent delegation, merge, deployment or
other writes.

## Release-diff v2

When either verified release uses I1, use a JCS/SHA-256
`ega.release-diff` envelope at `schema_version: 2`. Its payload has exactly
all eight R1 v1 payload keys, with the same field rules and comparison
semantics, plus `invocation_policy`, an object with exactly `previous` and
`candidate`. Each value is either `null` for a verified pre-I1 release, or an
object with exactly `digest` and `profile`, copied from that verified I1
HubRelease's `invocation_policy_digest` and `invocation_profile`. A non-null
`digest` is lowercase `sha256:` and 64 hexadecimal digits; `profile` is the
I1 profile literal. No omitted fields or partial pairs are allowed. Compare
both sides against their verified release envelopes; do not trust a diff alone.
For V1-to-I1 the previous value is null, for I1-to-I1 both are objects, and
for I1-to-V1 rollback comparison the candidate value is null. `status` is
`CHANGED` whenever the release digest or any compared semantic value differs,
otherwise `UNCHANGED`. A v3 candidate binds this diff using the existing
`release_diff_digest` publication field. In addition to the approved proposal's
`files.invocation_policy`, its `files` object has required
`previous_hub_release` equal to `previous-hub-release.json`. That file contains
the complete prior HubRelease envelope. Verify its envelope and digest equal
`publication.previous_release_digest` and the diff base digest, and compare
the diff against both verified release envelopes before exposure, export,
readiness and activation. Reject missing, tampered or substituted previous
envelopes; the candidate remains independently verifiable offline. V1 diffs and retained candidates
remain unchanged. Malformed, unknown-field, downgraded, substituted, and
cross-release mismatch cases fail verification. Rollback serves the retained
release without generating a new candidate or requiring a diff.

## Proposed preapproval identity distinction

R1 cannot produce a governed release candidate while any required skill review
is unapproved: it requires READY preflight and approval-set sidecars before
writing the candidate. Its governed candidate envelope also binds those sidecars
and an instance-specific SQLite artifact digest. Consequently, the governed
candidate envelope identity cannot honestly be presented before the owner's
exact-version approval and canonical adoption under the existing sequence.

The proposed resolution for owner decision is: before approval, independently
verify a non-publishable, isolated projected HubRelease built from the pinned
staged inputs, including the exact nine version hashes, source configuration,
provenance, policy digest and full semantic release digest. The projection is
review evidence, not a governed R1 candidate, approval record, canonical
adoption, or exportable production artifact. Its construction must not write
to the canonical Hub or use fabricated approvals. The owner approval packet
would name the projected HubRelease digest and every input identity. Following
authorization, canonical adoption and the ordinary R1 approval/preflight flow
would create the governed candidate; independently verify its semantic
HubRelease digest and inputs equal the approved projection and certify its
newly determinable candidate envelope and physical artifact identity before
publication. Any semantic mismatch requires a fresh owner decision. Physical
artifact identity and candidate envelope identity are separately reviewed,
not represented as preapproved values.

The projection requires a new supported read-only construction path; the
existing `buildHub` cannot build from staging alone. It starts from a verified
immutable baseline HubRelease and matching verified baseline Hub inputs. It
validates the staged intake plan, exact source-config preimage, pinned commit,
selected roots, tree and snapshot digests, skill bytes, canonical version
hashes, policy envelope and release bindings. It derives an in-memory projected
source lock and catalog by applying the plan's exact add/update semantics to
the baseline, rejecting conflicts, removals, missing bytes and mismatches. It
then uses the same canonical release projection and hashing rules as the
post-approval HubRelease builder. It must not write an approval, change a
canonical Hub, expose a governed candidate, export or publish. Independent
repeat builds from the same verified inputs must agree on the projected
semantic digest; after approval, the canonical governed build must match that
digest or return to the owner. Tests must cover tampering, stale plans,
conflicting source or version, unintended removal, determinism and exact
post-adoption semantic parity. No projection is evidence until this path is
implemented and independently verified.

This distinction does not waive the owner's stated requirement to approve an
exact candidate release identity before adoption. The owner must explicitly
accept the proposed semantic-identity interpretation or choose a different
permissible gate before this part can be frozen or implemented. No simulated or
inferred approval is acceptable.
