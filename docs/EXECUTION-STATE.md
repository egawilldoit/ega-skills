# EGA Skills release execution state

Updated: 2026-09-07

- Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
- Protected recovery checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92` on `review/full-1.3-checkpoint-b0b413e`.
- Remediation branch: `repair/pr77-release-readiness`.
- Current implementation candidate: `a8ec090f79894f56d2ddb85627fe49448386e774`.
- Linear parent: EGA-635, `PR #77 release-readiness remediation`.
- Linear workstreams: EGA-637 through EGA-643 cover R1 through R8.
- Contract A, B, and C remain authoritative frozen contracts. Contract D and
  Contract E are explicitly freeze candidates pending dedicated exact-head
  review, CI, merge, and freeze records.
- Full regression at `d9bf5a69ed5f702d12a7bd05e3a1add2e8c99db6`: 798 total,
  793 passed, 0 failed, 5 skipped. Build, typecheck, specs, and Contracts A
  through E passed. The focused final provenance regression at
  `a8ec090f79894f56d2ddb85627fe49448386e774` passed 17/17.
- Real upstream E2E passed with Cursor commit
  `93b00b89ef425a9c1bac0d0b317dfc49c930ac99` and Matt commit
  `3cca18b368ae95cdbdebbff572ccafa662551015`.
- CI workflow now runs frozen candidate commands for Contracts A through E on
  both Ubuntu and Windows. Exact-head GitHub runs are pending the remediation
  draft PR.
- No release tags, production deployment, Supabase remote migration, Contract
  F, or release 2.0 work was started.

Skip classification:

- Two Windows containment tests are platform-only and run on Windows CI.
- Codex and OpenCode smoke tests are hosted or fresh-client acceptance gates,
  enabled only with their respective environment variables.
- The real Matt/Cursor corpus test is real-network/upstream gated and passed
  separately with `EGA_REAL_UPSTREAM=1`.

Supabase migration review: `20260907120000_restrict_public_rls_auto_enable.sql`
was reviewed locally and not applied remotely. It is conditionally idempotent,
revokes execution from `PUBLIC`, `anon`, and `authenticated`, makes no grant,
does not alter function ownership or SECURITY DEFINER behavior, and has no
rollback migration. Production application remains a separately authorized
staging operation.

Explicit non-goals: Contract F and release 2.0.
