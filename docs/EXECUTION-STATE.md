# EGA Skills release execution state

Updated: 2026-09-07

- Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
- Protected recovery checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92` on `review/full-1.3-checkpoint-b0b413e`.
- Remediation branch: `repair/pr77-release-readiness`.
- Local implementation candidate tested: `cf4d85b2d83e8c9fa0cfbf1fa7d1aa89fc7c5df3`.
- Final repair code HEAD: `cf4d85b2d83e8c9fa0cfbf1fa7d1aa89fc7c5df3`.
- Linear parent: EGA-635, `PR #77 release-readiness remediation`.
- Linear workstreams: EGA-637 through EGA-643 cover R1 through R8.
- Contract A, B, and C remain authoritative frozen contracts. Contract D and
  Contract E are explicitly freeze candidates pending dedicated exact-head
  review, CI, merge, and freeze records.
- Full regression at `cf4d85b2d83e8c9fa0cfbf1fa7d1aa89fc7c5df3`: 806 total,
  801 passed, 0 failed, 5 skipped. Build, typecheck, specs, and Contracts A
  through E passed. The focused final provenance regression at
  `a8ec090f79894f56d2ddb85627fe49448386e774` passed 17/17.
- Real upstream E2E passed with Cursor commit
  `93b00b89ef425a9c1bac0d0b317dfc49c930ac99` and Matt commit
  `3cca18b368ae95cdbdebbff572ccafa662551015`.
- CI workflow runs frozen candidate commands for Contracts A through E on both
  Ubuntu and Windows. Exact-head foundation run `34138751456` and focused
  hashing run `34138751458` both pass on both platforms.
- Exact upstream lifecycle commits: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
  B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
  C=`3cca18b368ae95cdbdebbff572ccafa662551015`; approved plan digest
  `sha256:1c983c9a3c982fed82d81e87a3fce34b319bb37655fd25d433c0b451c5bc0645`.
- No release tags, production deployment, Supabase remote migration, Contract
  F, or release 2.0 work was started.

Skip classification:

- Two Windows containment tests are platform-only and run on Windows CI.
- Codex and OpenCode smoke tests are hosted or fresh-client acceptance gates,
  enabled only with their respective environment variables.
- The real Matt/Cursor corpus and A-to-B-to-C lifecycle test is one
  real-network/upstream gate and passed with `EGA_REAL_UPSTREAM=1`.

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
