# Issue 168 pre-adoption certification

Status: **READY FOR EXACT-IDENTITY OWNER DECISION**. This document is evidence,
not an approval. It records the certification that precedes the version-specific
owner gate. No canonical adoption, catalog change, release, or deployment has
been performed.

## Frozen inputs

| Item | Identity |
| --- | --- |
| Source repository | `https://github.com/t3dotgg/tstack` |
| Requested ref | `main` |
| Resolved commit | `7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd` |
| License | MIT (`LICENSE` included as provenance) |
| Source ID / namespace | `t3dotgg-tstack` / `t3dotgg` |
| Selected tree digest | `sha256:7de0901c257758c455d618bd69aa6ce9b51f7ba5fd8b06c17b75e48a0c76b4d6` |
| Vendored snapshot digest | `sha256:baee615c166889a7a6743cbff0eb4cf24e9f37cbe621d1fd69723de4ce599360` |
| Source config digest | `sha256:261b662dbca699e762244f1840522a6e17be130bd80e27f9873b199f9656dbd9` |
| Adoption plan | `sha256:beead990accac2318a0aad15dc1058c2cb38947b008f209c621c3b51df9808cc` |
| 117-skill baseline release | `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297` |
| Invocation policy | `sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6` |
| Projected 126-skill semantic release | `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266` |

The pinned tree and snapshot were reacquired into a fresh clone at
`7de017b3…` and reproduced with the frozen extraction contract. The staged
source was compared file-by-file against that clone: all 15 selected and
provenance files matched by canonical blob hash and byte size.

## Exact nine SkillVersions

Each hash below was recomputed independently from the canonical manifest JSON
(RFC 8785 JCS + SHA-256), not read from the release envelope. Each manifest's
file records were then matched to the pinned upstream bytes.

| Skill | Version hash |
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

The 117 existing versions are byte-identical to the baseline release. The union
is exactly 126: 117 preserved, nine added, zero changed, zero removed.

## Independent release reproduction

A separate assembly script, committed at
`scripts/eval/issue-168-independent-release.mjs` (it does not import the release
builder or projection), reconstructed the I1 envelope preimage from:

- the 126 registry rows and their canonical manifests;
- the token-count table (`ega-o200k-v1`, L2);
- the alias and search-index projections derived directly from each manifest;
- the verified 117 source entry plus the computed `t3dotgg-tstack` source-config
  digest; and
- the frozen contracts with `router: 2`, `build_contract: "C2"`,
  `invocation_profile: "ega-invocation-policy-v1"`.

It independently produced
`sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`,
identical to the governed CLI projection. This is an independent implementation
for the semantic identity, not a re-run of the project builder.

## Routing evaluation (canonical 126 registry)

All runs used the verified 126 registry, the reviewable policy and the projected
semantic release. They are not synthetic scratch fixtures.

| Check | Result |
| --- | --- |
| Reviewed positive phrase alternatives | 27/27 selected the intended skill |
| Explicit TStack references | 9/9 resolved the exact version |
| Negative / ambiguous prompts | 11/11 selected no TStack skill |
| Existing 82-prompt automatic selections | 82/82 unchanged |
| Existing baseline wrong automatic selections | 22 before, the same 22 after |
| Discovery top-1 | 44/82 unchanged |
| Discovery top-3 | 71/82 → 72/82 (one improvement, no regression) |
| Catastrophic automatic selections | 0 |
| Full-send buffer / city-council false positives | eliminated |
| Suggestion-list changes | 19 total (10 previously reviewed + 9 newly enumerated) |

The 19 candidate-list changes are documented individually in
`docs/evidence/ISSUE-168-ROUTING-REVIEW.md`. None changes an automatic
selection. The two previously observed unrelated auto-selections are now
`LOW`/`INVOCATION_UNCONFIRMED` at most.

## Policy and runtime certification

The committed test suite covers, and the pre-adoption run exercised:

- policy envelope digest, source binding, exact version binding and roster
  completeness;
- missing, malformed, tampered and downgraded policy rejection at the router,
  local MCP, hosted MCP and CLI boundaries;
- release-policy transition and rollback to the retained V1 release;
- hosted MCP input/output/error parity with the local server and CLI, including
  `explicit_skills`;
- project deny, lock and AMEND-09 `USER_INVOCATION_ONLY` behavior;
- exact release-digest verification and the new `/readyz` identity;
- the production publication boundary: stale predecessors, concurrent changes,
  alias drift, reordered deployments, mismatched candidate identities,
  platform guard failures, failed-promotion restore receipts, interrupted
  promotion reconciliation and rollback receipts. Live Vercel platform
  enforcement could not be executed because no release credential was
  available; that limitation is stated below.

## Host authorization (scope statement)

The hosted MCP exposes exactly four read-only tools. It returns skill content as
data; no tool performs merges, deployments, subagent creation or shell
execution. `full-send`, `full-stop`, `council` and `sol-loop` therefore cannot
grant authority through the Hub itself.

Vercel API response-shape mapping is unit-tested against documented objects but
was not exercised against a live project in this cycle. The publisher refuses
unrecognised or unobservable platform state rather than assuming it. A release
credential is required before promotion. The Vercel project also hit its
free-plan daily deployment quota on 2026-10-27 (`api-deployments-free-per-day`,
over 100 deployments/day), so a preview deployment could not be created even
with a credential; that is an external quota blocker, not a code result.

This is **not** a test of any specific host's enforcement. Whether Codex,
OpenCode or another client lets a skill body trigger delegation, merge or deploy
is determined by that host's own authorization model. Skill text remains
untrusted advice. No claim is made that host-level enforcement was exercised in
this cycle.

## Known delivery limitation

`babysit-pr` includes `scripts/pr-wait` (upstream mode `100755`). The hosted MCP
`get_content` serves text files only and does not deliver an executable. The
supported fallback is to retrieve the script from the pinned upstream commit
`7de017b3…` and verify its SHA-256 against the adopted manifest blob before use.
The Hub does not claim to execute or install it.

## Required owner decision

The exact version-specific approval packet is
`docs/evidence/ISSUE-168-APPROVAL-PACKET.md`. Approval of Contract I1, of the
issue, or of an earlier release is not approval of these nine versions. Any
change to a version hash, source commit, policy digest or projected release
digest invalidates this certification.
