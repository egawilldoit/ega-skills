# EGA Skills release execution state

Updated: 2026-09-08

- Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
- Protected recovery checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92` on `review/full-1.3-checkpoint-b0b413e`.
- Remediation branch: `repair/pr77-release-readiness`.
- Code-under-test SHA: `2874ee34bd6c5c8116757296ec89c7f776afac4b`.
- Documentation/evidence HEAD: the final evidence commit recorded in PR #78
  after this documentation update.
- This is the focused final hardening pass; B1–B11 were not reopened except
  where the requested regression tests exercised their boundaries.
- Contract A, B, and C remain authoritative frozen contracts. Contract D and
  Contract E remain freeze candidates pending dedicated exact-head review,
  CI, merge, and freeze records.
- Full real-upstream regression: 855 total, 851 passed, 0 failed, 4
  classified skips. Build, typecheck, specs, and Contracts A through E passed.
- Focused repair suite: 142 total, 142 passed, 0 failed, covering Hub
  adoption/recovery, HubRelease, Contract C, hosted runtime and OAuth/JWKS,
  remote context persistence/control plane, remote fingerprints, remote lock
  plan/apply, exact Git materialization, and production-builder-to-hosted
  integration.
- Contract totals: A 17/17, B 11/11, C 18/18, D 9/9, E 6/6.
- Hardening results: bounded JWKS freshness and rotation, post-commit context
  cleanup, production `buildHubRelease()` to hosted runtime loading, bounded
  request-scoped hosted authorization, and verified exact-SHA Git fallback all
  pass deterministic tests.
- Real upstream E2E passed with Cursor commit
  `71ed0d1076fec562c1b74ee353121a8d00f75382` and Matt commit
  `3cca18b368ae95cdbdebbff572ccafa662551015`.
- Exact upstream lifecycle commits: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
  B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
  C=`3cca18b368ae95cdbdebbff572ccafa662551015`; approved B plan digest:
  `sha256:41b214548f8d47d424e4bc29ceb04170eec6e1ffefd2fa06e55dc7cc44ab8081`.
- Final foundation and hashing CI run IDs are recorded in PR #78 after the
  final push.

Skip classification:

- Two Windows-only containment tests run on Windows CI.
- Codex acceptance smoke requires a fresh hosted-client environment.
- OpenCode acceptance smoke requires a fresh hosted-client environment.
- The real-network Matt/Cursor gate is skipped without `EGA_REAL_UPSTREAM=1`;
  it was separately executed and passed here.

Remaining external acceptance items are isolated staging deployment, real
OAuth/client registration, fresh Codex and OpenCode clients, physical
connection-limit evidence, hosted backup/restore/rollback, and hosted
ProjectContext publication/revocation. The Supabase migration was reviewed
locally and not applied remotely.

Decision boundary:

- 1.1 implementation readiness: READY.
- Contract D freeze-candidate readiness: NOT READY.
- 1.2 isolated staging readiness: NOT READY.
- Contract E freeze-candidate readiness: NOT READY.
- 1.3 isolated staging readiness: NOT READY.

No merge, release, staging deployment, production mutation, Contract F work,
or release 2.0 work was started.
