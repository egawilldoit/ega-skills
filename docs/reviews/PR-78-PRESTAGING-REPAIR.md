# PR #78 final pre-staging hardening report

Updated: 2026-09-08

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
Protected checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92`.
Branch: `repair/pr77-release-readiness`.

Code-under-test SHA: `2874ee34bd6c5c8116757296ec89c7f776afac4b`.
Documentation/evidence HEAD: the final evidence commit on this branch; the exact
SHA is recorded separately in PR #78 after the documentation commit.

This is a focused final hardening pass. It does not reopen the completed B1–B11
repair areas, and it does not claim a hosted deployment, a release, or an
authoritative Contract D/E freeze.

## Findings fixed

| Finding | Result | Evidence |
| --- | --- | --- |
| JWKS freshness, rotation, and removed-key trust | FIXED | Successful JWKS documents expire after the bounded `jwksMaxAgeMs` (default 300000 ms); safe-integer validation, retry-after-failure, shared refresh, timeout/body bounds, unknown-kid handling, and no token logging are preserved. Deterministic tests cover removed K1, new K2, reused-kid material replacement, concurrent refresh coalescing, and invalid ages. |
| Post-commit context cleanup | FIXED | The durable replacement point is recorded before temporary/backup cleanup. Cleanup is best effort only after commit; pre-commit replacement/restoration failures still fail closed. Fault-injection tests cover temporary cleanup, backup cleanup, replacement failure, retained backup, in-memory state, and restart durability. |
| Production builder to hosted runtime | FIXED | A realistic temporary Hub fixture runs the real `buildHubRelease()`; its release and SQLite artifacts load into `HostedReleaseSnapshot`, reach READY, and pass search, resolve, inspect, and get_content. A tampered production-built artifact fails startup integrity. |
| Hosted authorization work | FIXED | Eligibility authorization uses request-scoped memoization and a worker bound of 8; deny-before-ranking/limits/budgets remains intact. The first delivery check is fresh, the final revocation/authorization boundary remains fail-closed, and abort stops new work. |
| Exact Git SHA compatibility | FIXED | Direct SHA fetch remains preferred. If a server rejects it, the configured source ref transports history only; the approved object must exist, is checked out detached, and `HEAD` is verified equal to the approved SHA. Unavailable, malformed, missing-fallback, ref-tip-substitution, and A→B→C fixtures fail closed. |

## PR #78 review-thread triage

Every unresolved thread observed before this pass is classified exactly once:

| Review subject | Classification | Reason |
| --- | --- | --- |
| Remote-lock local deny policy | FIXED BY CURRENT CODE | Candidate lock is validated against current local policy before atomic write. |
| Direct exact-SHA Git fetch portability | VALID — FIXED IN THIS PASS | Verified source-ref history fallback now preserves the approved commit identity. |
| Builder/runtime skill-source binding | VALID — FIXED IN THIS PASS | The real builder-to-hosted integration now exercises the production schema and artifact binding. |
| Canonical remote-lock comparisons | FIXED BY CURRENT CODE | Current code uses canonical domain comparison and digest-based change sets. |
| CLI directory/name mismatch assertion | VALID — FIXED IN THIS PASS | The test now asserts the canonical validator diagnostic. |
| Hosted hand-built production metadata fixture | VALID — FIXED IN THIS PASS | Retained targeted fixture is supplemented by the real production-builder path. |
| Hub adoption stale-PID wait | VALID — FIXED IN THIS PASS | Wait horizon is bounded to 10 seconds and child exit is detected before timeout. |
| Real-upstream plan digest assertion | FALSE POSITIVE / NOT APPLICABLE | The current lifecycle verifies the immutable plan envelope, approved B, and post-C apply; the prior comment targeted an older evidence snapshot. |
| Execution-state stale SHA/comments | VALID — FIXED IN THIS PASS | Evidence and code-under-test identities are refreshed here and in the PR body. |
| Hosted authorization scaling | VALID — FIXED IN THIS PASS | Bounded request-scoped eligibility work and safe memoization are now covered by tests. |
| Duplicate hosted fixture concern | VALID — FIXED IN THIS PASS | The production-built artifact path is now the primary schema-drift regression. |
| Child-process test quality | VALID — FIXED IN THIS PASS | Contender waits now fail early on child exit and allow the required bounded startup window. |
| Stale pre-staging repair report | VALID — FIXED IN THIS PASS | This report is refreshed for the final hardening pass. |
| Persistence cleanup after replacement | VALID — FIXED IN THIS PASS | Cleanup failures after durable commit no longer produce a logical save failure. |

## Verification

The enabled real-upstream full suite passed:

- Full tests: 855 total, 851 passed, 0 failed, 4 skipped.
- Focused repair suite: 142 total, 142 passed, 0 failed.
- Contract A: 17/17.
- Contract B: 11/11.
- Contract C: 18/18.
- Contract D: 9/9.
- Contract E: 6/6.
- Build, typecheck, frozen-spec checks, contract validators, and `git diff --check`: PASS.

Skip classifications for the default full-suite inventory are explicit:

1. Two Windows-only containment tests run on Windows CI.
2. Codex acceptance smoke requires a fresh hosted-client environment.
3. OpenCode acceptance smoke requires a fresh hosted-client environment.
4. The real-network Matt/Cursor gate is skipped without `EGA_REAL_UPSTREAM=1`; it was separately executed and passed here.

Real upstream result:

- Cursor: `71ed0d1076fec562c1b74ee353121a8d00f75382`.
- Matt: `3cca18b368ae95cdbdebbff572ccafa662551015`.
- Controlled lifecycle: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
  B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
  C=`3cca18b368ae95cdbdebbff572ccafa662551015`.
- Approved B plan digest from the latest real run:
  `sha256:41b214548f8d47d424e4bc29ceb04170eec6e1ffefd2fa06e55dc7cc44ab8081`.

CI run IDs and Ubuntu/Windows foundation and hashing results are recorded in
the PR description after the final push.

## Remaining external blockers

Isolated staging deployment, real OAuth/client registration, fresh Codex and
OpenCode hosted acceptance, physical connection-limit evidence, hosted
backup/restore/rollback, and hosted ProjectContext publication/revocation
remain external acceptance items. The Supabase migration remains locally
reviewed and unapplied.

## Decision boundary

1.1 implementation readiness: READY

Contract D freeze-candidate readiness: NOT READY

1.2 isolated staging readiness: NOT READY

Contract E freeze-candidate readiness: NOT READY

1.3 isolated staging readiness: NOT READY

Keep the following explicit until later exact-head review:

- NO MERGE
- NO RELEASE
- NO STAGING DEPLOYMENT
- NO PRODUCTION MUTATION
- CONTRACT D/E REMAIN FREEZE CANDIDATES

Contract F and release 2.0 were not started.
