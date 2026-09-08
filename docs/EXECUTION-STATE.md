# EGA Skills release execution state

Updated: 2026-09-08

- Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
- Protected recovery checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92` on `review/full-1.3-checkpoint-b0b413e`.
- Remediation branch: `repair/pr77-release-readiness`.
- Code-under-test SHA: `610650d44f68023c85a803dc250f1d81696e6279`.
- The current evidence snapshot is documentation-only after that code commit;
  the exact branch head and its CI are supplied by the PR/CI record.
- Exact code-under-test CI passed at foundation `34215575847` and hashing
  traversal `34215575864`, on Ubuntu and Windows.
- Linear parent: EGA-635, `PR #77 release-readiness remediation`.
- Linear workstreams: EGA-637 through EGA-643 cover R1 through R8.
- Contract A, B, and C remain authoritative frozen contracts. Contract D and
  Contract E are explicitly freeze candidates pending dedicated exact-head
  review, CI, merge, and freeze records.
- Full regression on code-under-test `610650d44f68023c85a803dc250f1d81696e6279`:
  845 total, 840 passed, 0 failed, 5 classified skips. Build, typecheck,
  specs, and Contracts A through E passed. The focused repair-boundary suite
  passed 109/109 across Hub adoption/release, Contract C, hosted runtime,
  remote context, and fingerprint tests.
- Real upstream E2E passed with Cursor commit
  `71ed0d1076fec562c1b74ee353121a8d00f75382` and Matt commit
  `3cca18b368ae95cdbdebbff572ccafa662551015`.
- CI workflow runs frozen candidate commands for Contracts A through E on both
  Ubuntu and Windows. Exact code-under-test foundation CI `34215575847` and
  hashing traversal CI `34215575864` passed on both platforms.
- Exact upstream lifecycle commits: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
  B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
  C=`3cca18b368ae95cdbdebbff572ccafa662551015`; approved plan digest recorded
  in the latest run
  `sha256:819dab697c5169c9b6130f4654eb73d3583fb57ec3ca16949ea8b469e38bcc04`.
- No release tags, production deployment, Supabase remote migration, Contract
  F, or release 2.0 work was started.

Skip classification:

- Two Windows containment tests are platform-only and run on Windows CI.
- Codex and OpenCode smoke tests are hosted or fresh-client acceptance gates,
  enabled only with their respective environment variables.
- The real Matt/Cursor corpus and A-to-B-to-C lifecycle test is one
  real-network/upstream gate and passed with `EGA_REAL_UPSTREAM=1`; its
  current-run evidence is recorded in the dated upstream evidence file.

Supabase migration review: `20260907120000_restrict_public_rls_auto_enable.sql`
was reviewed locally and not applied remotely. It is conditionally idempotent,
revokes execution from `PUBLIC`, `anon`, and `authenticated`, makes no grant,
does not alter function ownership or SECURITY DEFINER behavior, and has no
rollback migration. Production application remains a separately authorized
staging operation.

Staging safety assessment: the live Supabase inventory exposed only
`Ega-House-Platform` (`ofpqkogwatceimtzvenh`), an existing active project with
no database branches. It was not proven to be isolated EGA staging and was not
mutated. No authorized isolated EGA staging URL, deployment adapter, OAuth
client, or fresh Codex/OpenCode environment is available in this session.
Hosted OAuth/MCP, fresh-client, backup/restore/rollback, and remote context
publication therefore remain explicitly blocked external acceptance rows.

Explicit non-goals: Contract F and release 2.0.
