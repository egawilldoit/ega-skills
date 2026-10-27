# Issue 168 exact-identity approval packet

**STATUS: AWAITING RELEASE-OWNER DECISION — NO APPROVAL IS RECORDED.**

This packet asks for one decision: approve the adoption and production release of
exactly the nine TStack SkillVersions identified below, at the exact source,
policy and semantic-release identities listed. It is not a request to approve the
issue in general, Contract I1, or any earlier release.

## What approval authorizes

If approved, and only if every identity below still matches:

1. canonical adoption of the `t3dotgg-tstack` source at
   `7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd` into the canonical Hub;
2. construction of the immutable I1 R1 candidate whose semantic HubRelease
   digest is `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`;
3. publication of the resulting 126-skill release through the reviewed
   production boundary; and
4. a catalog-only follow-up change after the adopted release exists.

It does **not** authorize a different version, a different source commit, a
policy change, removal of any existing skill, or a force-promote.

## Exact nine SkillVersions

| Skill ID | Version hash |
| --- | --- |
| `t3dotgg/babysit-pr` | `sha256:e04074fafff80b5b89d8713d46278f74e310e71d936af7bffffa7b8ed3862370` |
| `t3dotgg/council` | `sha256:3886b94694c14043eb69ae549026fb58c03b2df5f2f02078fb130fffa092424e` |
| `t3dotgg/file-pr` | `sha256:f122b9983ba8d71d5904eecdfaec2087b340f5931006cd63892bf1913e3d576c` |
| `t3dotgg/full-send` | `sha256:c665966575ce8896ce9cfe87f9a9962e60b5ae5c3e15f5915d026d97de1796ef` |
| `t3dotgg/full-stop` | `sha256:c1be4648ab8b5bc2e4659174aa6f109d5af27718e901e5e8ef5e1821be59edc5` |
| `t3dotgg/leaving-pr-comments` | `sha256:cb6bf03e50106ae957670029043649fd87c9a29c529104f2bb03cf0212cb4dbf` |
| `t3dotgg/modernize` | `sha256:43f822037b0b0e624274e3dc1127fbb4a269ca920a8ac5e8409f151827ea7958` |
| `t3dotgg/sol-loop` | `sha256:ae8fb31ef38a9e30bdca3381c91017aed680f1e319fe9fb2ae2f1fe23cf30d5b` |
| `t3dotgg/takeover` | `sha256:39a467c35ec9dfc3937f53e2d4f1c2d23b6a6ff0c3aafc397fef9d9e307cae40` |

## Bound identities

| Identity | Value |
| --- | --- |
| Source repository / ref | `https://github.com/t3dotgg/tstack` @ `main` |
| Pinned commit | `7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd` |
| License | MIT, `LICENSE` adopted as provenance |
| Selected source tree | `sha256:7de0901c257758c455d618bd69aa6ce9b51f7ba5fd8b06c17b75e48a0c76b4d6` |
| Vendored snapshot | `sha256:baee615c166889a7a6743cbff0eb4cf24e9f37cbe621d1fd69723de4ce599360` |
| Source config | `sha256:261b662dbca699e762244f1840522a6e17be130bd80e27f9873b199f9656dbd9` |
| Adoption plan | `sha256:beead990accac2318a0aad15dc1058c2cb38947b008f209c621c3b51df9808cc` |
| Invocation policy | `sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6` |
| 117-skill baseline | `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297` |
| Projected 126-skill release | `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266` |
| Expected catalog total | 126 (117 preserved + 9 added, 0 changed or removed) |

## Evidence

- `docs/evidence/ISSUE-168-CERTIFICATION.md` — independent source, version and
  release reproduction.
- `docs/evidence/ISSUE-168-ROUTING-REVIEW.md` — full routing evaluation and all
  19 candidate-list changes.
- PR #172 — implementation, publication boundary and the exact reviewed head.
- The nine version hashes were recomputed from canonical manifests, and every
  manifest file record was matched to the pinned upstream bytes.

Routing summary: 27/27 reviewed positive phrases, 9/9 explicit references,
11/11 negative prompts, 82/82 automatic selections unchanged, the same 22
pre-existing baseline failures, top-3 improved by one, zero catastrophic
automatic selections. The two prior false positives (`full send buffer`,
`city council data model`) no longer auto-select a TStack skill.

## Approval record to be completed by the release owner

The owner decision must name this packet, the release digest, the policy digest
and the nine version hashes. The approval is only valid if it is recorded by the
actual release owner, not by the implementing agent.

```
I approve the adoption and production release of the nine TStack SkillVersions
listed in docs/evidence/ISSUE-168-APPROVAL-PACKET.md, at source commit
7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd, under invocation policy
sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6,
producing semantic HubRelease
sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266,
with the existing 117 versions preserved.

Approver (release owner):
Approval record (issue/comment URL or id):
Approved at (UTC):
Publisher subject and Vercel user id:
```

The machine-readable approval envelope is generated only after that record
exists. Its `approved_by` and `publisher.owner_subject` must name the same
release owner; its `publisher.vercel_user_id`, `team_id` and `project_id` must
match the executor verified by
`scripts/hosted/publish-production.mjs`. No approval can be inferred from
Contract I1, from issue #168, or from any earlier cycle.

## Invalidating changes

Any of the following requires a new packet and a new owner decision:

- a different source commit, selected root, tree/snapshot digest or license;
- a different version hash for any of the nine;
- a different baseline release or any change to an existing skill version;
- a different policy digest or governance roster;
- a different projected release digest;
- a change to the publication-boundary implementation that affects these
  bindings; or
- a change in the approved publisher identity.
