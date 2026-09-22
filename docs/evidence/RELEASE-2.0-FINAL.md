# EGA Skills 2.0 — Final release evidence

Status: IN PROGRESS. Every PASS below requires observable evidence recorded
next to it. `BLOCKED` and `SKIPPED` are not passes.

## Environment at baseline

- Repository: `egawilldoit/ega-skills`
- Canonical branch: `release/2.0`
- Baseline SHA: `2259364616b1255b00285fe6f2e280e9495896de`
- Integration branch: `fix/2.0-release-integration`
- Execution date: 2026-09-22 UTC
- Node: v24.18.0
- pnpm: 10.0.0
- OS: Ubuntu 22.04 (aarch64), 2 cores
- Format: source commit → vendored snapshot digest → tree digest → skill
  version hash → intake plan digest → approval revision → approval-set
  digest → release digest → deployment artifact → MCP response

## Baseline facts inherited from the prior wave (not re-verified here)

- 1,029 tests / 1,024 pass / 0 fail / 5 skip at integration head
  `121c9a7c789ef4ea4885d76827796d2f5d95288e` (see
  `docs/evidence/INTAKE-MERGE-READINESS.md`, a historical record).
- Publication E2E 2/2, OAuth offline harness 9/9, retained-serving 8/8,
  routing 30/30, real upstream lifecycle PASS, Contract F PASS, Windows
  foundation PASS, hashing traversal PASS.

## Existing remote CI at baseline

- Run `35544811605` ("2.0 multi-user implementation candidate") on baseline
  SHA `2259364616b1255b00285fe6f2e280e9495896de` — conclusion `cancelled`.
  - Job `106168728019` (`contract-f rls (ubuntu-latest)`) — success.
  - Job `106168728098` (`foundation (windows-2022)`) — success, Test step
    2026-09-20T23:31:27Z → 2026-09-20T23:37:59Z (~6.5 min).
  - Job `106168728100` (`foundation (ubuntu-latest)`) — cancelled at
    2026-09-21T05:30:05Z; Test step started 2026-09-20T23:30:04Z and never
    terminated. GitHub cleanup reported orphan processes.
- Workflow applicability gap: `hashing-traversal.yml` is restricted to
  `pull_request` path filters plus one obsolete push branch, so
  `release/2.0` cannot obtain post-merge hashing evidence.
- Local Windows-path, real-client, and real-upstream cases are the five
  opt-in skips in the Linux suite.

## Known blockers at start

- B1 (P1): Ubuntu `foundation` Test step does not terminate on
  `pnpm test` (GitHub run `35544811605`, job `106168728100`).
- B2 (P1): CI does not run on `release/2.0` push and has no
  `workflow_dispatch`; no finite job timeout.
- B3 (P1): package versions report `1.0.1` while the product release is
  `2.0`.
- B4: no unified `pnpm release:verify`.
- B5: modern (`2026-07-28`) MCP era, artifact-only serving, and
  cross-client identity have no committed end-to-end evidence against this
  baseline.
- B6: OAuth live staging, preview deployment, and rollback evidence have
  not been produced for the candidate.

## Gate ledger

Populated as gates execute. Each entry: gate, command/run, result, SHA.

| Gate | Evidence | Result |
|---|---|---|
| G01 clean checkout | worktrees created at baseline SHA; `git status --short` empty | PASS (see setup log) |
| G02 frozen lockfile | `pnpm install --frozen-lockfile` in all four worktrees, exit 0 | PASS |
| G03 build | pending integration run | — |
| G04 typecheck | pending integration run | — |
| G17 no process hang | pending Agent A root cause + regression | — |

## Production

Production deployment was NOT performed under this execution. Existing
production deployments from prior work are out of scope and were not
modified or promoted.
