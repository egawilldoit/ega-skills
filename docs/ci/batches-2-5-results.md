# EGA Skills CI/CD optimization: Batches 2–5

Status: IN PROGRESS. Batch 2 running; Batches 3–5 pending.

Related: [performance-audit.md](performance-audit.md), [optimization-plan.md](optimization-plan.md),
[optimization-results.md](optimization-results.md), [../operations/ci-optimization.md](../operations/ci-optimization.md).

This document records Batches 2–5 of the CI performance program. Batch 1 shipped in
PR [#197](https://github.com/egawilldoit/ega-skills/pull/197) and merged as
`64f217b221ef1b1f6de0839d8dca9448c25d2fb0`. Every claim below is either measured in a
named run, derived from named runs, or explicitly labelled modelled/unmeasured.

## 1. Safety invariants

These hold for every batch and are not negotiable:

1. No test is removed, skipped, weakened, retried, or given a longer timeout.
2. No production, runtime, schema, or artifact behavior changes.
3. The release-required check names stay byte-identical:
   `foundation (ubuntu-latest)`, `foundation (windows-2022)`, `contract-f rls (ubuntu-latest)`.
4. `ci-gate` stays unconditional (`if: always()`), fail-closed, and a direct dependency
   consumer of every mandatory job.
5. Real PostgreSQL isolation, Contract F RLS, trusted-artifact verification, frozen specs,
   catalog freshness, token vectors, and registry performance stay independently executed.
6. Windows keeps its full unscoped 189-file suite, including the deliberate web overlap.
7. `pnpm test:perf:registry` stays at its explicit `--test-concurrency=1`.
8. Web suite concurrency stays at the current effective value in Batch 2.
9. No paid runners, no provider migration, no branch-protection change, no deployment.

## 2. Measurement definitions

| Term | Definition |
|---|---|
| Run wall | `run_started_at` → the successful `ci-gate` `completed_at`. Excludes pre-start queueing and rerun delay. |
| Job wall | GitHub `started_at` → `completed_at` for one job execution. Includes setup and teardown. |
| Test-step wall | The job's `Test` (or `Web API and integration tests`) step duration. |
| Job-minutes | Sum of executed job walls. A rerun repeats job names; sum actual executions only. |
| Critical path | The chain of jobs that determines run wall. |
| Runner-minutes | Job-minutes; physical elapsed runner time, not a billing invoice. GitHub-hosted standard runners are free for this public repository. |

Cohorts are never mixed: PR-to-`main`, push-to-`main`, manual full (Linux + Windows),
release-target, docs mode, and web mode are reported separately. Historical numbers and
controlled comparisons are labelled as such.

## 3. Baseline

### 3.1 Historical reference (pre-Batch 1)

From [optimization-results.md](optimization-results.md) §3 and the brief. These are
version-mixed samples, not paired controls.

| Metric | Historical |
|---|---:|
| Linux PR CI (latest-attempt median) | 6.00 min |
| Full Linux/Windows CI (latest-attempt median) | 17.6 min |
| Windows foundation job | 17.2 min median |
| Windows foundation test step | 967 s |
| Linux web integration step | 316 s |

### 3.2 After Batch 1 (post-merge `main`)

Measured on `64f217b`, attempt 1, Node v24.22.1, unchanged workflow.

| Run | Event | Wall | Job-minutes | Source |
|---|---|---:|---:|---|
| [41623549529](https://github.com/egawilldoit/ega-skills/actions/runs/41623549529) | push to `main` | 4m54s (294 s) | 9.667 | post-merge verification |
| [41620427092](https://github.com/egawilldoit/ega-skills/actions/runs/41620427092) | manual full (Linux + Windows) at `9152229` | 15m16s (916 s) | 30.267 | last pre-merge full run on the merged tree |

Job detail:

| Job | PR/push wall | Test step | Full wall | Test step |
|---|---:|---:|---:|---:|
| `foundation (ubuntu-latest)` | 270 s | 250 s | 223 s | 205 s |
| `web console (ubuntu-latest)` | 168 s | 135 s | 179 s | 145 s |
| `foundation (windows-2022)` | skipped | — | 889 s | 755 s |
| `web console (windows-2022)` | skipped | — | 379 s | 266 s |
| `web isolation (real PostgreSQL 16)` | 59 s | — | 64 s | — |
| `contract-f rls (ubuntu-latest)` | 59 s | — | 58 s | — |

The PR critical path after Batch 1 is `classify` → `foundation (ubuntu-latest)` → `ci-gate`.
The full-run critical path is `foundation (windows-2022)`.

## 4. Batch tracking

| Batch | Status | Implementation | Tests | Performance | Decision |
|---|---|---|---|---|---|
| 2 — Concurrency | IN PROGRESS | Pending | Pending | Pending | Pending |
| 3 — Windows sharding | PENDING | Pending | Pending | Pending | Conditional |
| 4 — Linux sharding | PENDING | Pending | Pending | Pending | Conditional |
| 5 — Final optimization | PENDING | Pending | Pending | Pending | Conditional |

## 5. Batch 2 — Node test concurrency benchmark

_Recorded as the batch completes._

## 6. Batch 3 — Windows foundation sharding

_Pending Batch 2 evidence._

## 7. Batch 4 — Linux foundation sharding

_Pending Batch 3 evidence._

## 8. Batch 5 — Final targeted optimization and audit

_Pending Batches 2–4._

## 9. Final comparison

_Pending._
