# EGA Skills CI/CD optimization: Batches 2–5

Status: IN PROGRESS. Batch 2 complete; Batch 3 in progress; Batches 4–5 pending.

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
| 2 — Concurrency | COMPLETE | Runtime instrumentation + validated dispatch controls; `4` applied to Windows only | 29 CI contract tests pass; hosted parity exact (1437 / 2233) | Windows test step −4.8%, full wall −4.8% | IMPLEMENTED (Windows); Linux default retained |
| 3 — Windows sharding | IN PROGRESS | Pending | Pending | Pending | Conditional |
| 4 — Linux sharding | PENDING | Pending | Pending | Pending | Conditional |
| 5 — Final optimization | PENDING | Pending | Pending | Pending | Conditional |

## 5. Batch 2 — Node test concurrency benchmark

**Decision: IMPLEMENTED for Windows (`--test-concurrency=4`), Node default retained on Linux.**
The measurement hook, runtime instrumentation and contract tests stay; the Linux default is unchanged.

### 5.1 What was built

- `scripts/release/run-tests-bounded.mjs` now resolves an effective concurrency from, in order,
  an explicit `--test-concurrency` argument, `EGA_TEST_CONCURRENCY`, or Node's documented default
  (`availableParallelism() - 1`). Values must be a bare integer in 1–32; a flag/env disagreement is
  an error, not a silent winner. The value is injected once and never duplicated into the forwarded argv.
- Every invocation logs one machine-readable line with Node version, platform, architecture,
  `availableParallelism()`, CPU count, total memory, isolation mode, the effective concurrency and
  its source, the scope and the file count. It contains no paths, tokens, or unrelated environment.
- `.github/workflows/ci.yml` gained two validated `workflow_dispatch` inputs,
  `linux_core_concurrency` and `windows_concurrency`. Both default to empty, so routine PR, push and
  release runs resolve exactly as before. The input is validated twice: a shell guard rejects
  anything that is not `^[1-9][0-9]?$`, and the runner rejects anything outside 1–32.
- The registry performance test, the web suite and its concurrency are untouched.
- `scripts/ci/test-ownership.json` gained the new CI contract test file, so discovery is now
  190 files (152 core, 38 web) instead of 189/151/38.

### 5.2 Method

Four `workflow_dispatch` full runs on the same SHA (`c487883`), dispatched as two simultaneous
pairs so each pair shared runner generation and time of day. Pair 1 and pair 2 differ only in the
requested concurrency. Every run is attempt 1, event `workflow_dispatch`, branch
`perf/ci-optimization-batches-2-5`, fully successful.

Runtime recorded by the runner itself (identical on every run):

```json
{"node":"v24.22.1","platform":"linux","arch":"x64","availableParallelism":4,"cpuCount":4,
 "totalMemMiB":15984,"testIsolation":"process (Node default)","scope":"core"}
{"node":"v24.22.1","platform":"win32","arch":"x64","availableParallelism":4,"cpuCount":4,
 "totalMemMiB":16379,"testIsolation":"process (Node default)","scope":"unscoped"}
```

Both runners resolve to 4 CPUs, so Node's implicit default is 3 and "3" is the current behaviour.

### 5.3 Results

Test-step wall, seconds. Paired comparisons only; no cross-pair claim.

| Run | Concurrency | Linux core test | Windows test | Linux foundation job | Windows foundation job | Full run wall | Job-minutes |
|---|---:|---:|---:|---:|---:|---:|---:|
| [41625815207](https://github.com/egawilldoit/ega-skills/actions/runs/41625815207) | 3 | 241 | 668 | 262 | 791 | 819 s | 25.933 |
| [41625826614](https://github.com/egawilldoit/ega-skills/actions/runs/41625826614) | 4 | 237 | 639 | 257 | 752 | 774 s | 27.233 |
| [41627835693](https://github.com/egawilldoit/ega-skills/actions/runs/41627835693) | 3 | 242 | 714 | 261 | 813 | 837 s | 29.317 |
| [41627843587](https://github.com/egawilldoit/ega-skills/actions/runs/41627843587) | 4 | 220 | 677 | 239 | 779 | 802 s | 28.917 |

| Workload | 3 (mean of 2) | 4 (mean of 2) | Delta | Pair 1 | Pair 2 |
|---|---:|---:|---:|---:|---:|
| Linux core test step | 241.5 s | 228.5 s | −13.0 s (−5.4%) | −4 s (−1.7%) | −22 s (−9.1%) |
| Windows test step | 691.0 s | 658.0 s | −33.0 s (−4.8%) | −29 s (−4.2%) | −37 s (−5.2%) |
| Full run wall | 828 s | 788 s | −40 s (−4.8%) | −45 s | −35 s |

Concurrency 4 was faster in every one of the four paired comparisons. On Windows the magnitude is
consistent (4.2% and 5.2%). On Linux it is not (1.7% then 9.1%), which is the reason for the split
decision below.

### 5.4 Coverage and reliability parity

| Invocation | Tests | Passed | Failed | Skipped | Identical across 3 and 4 |
|---|---:|---:|---:|---:|---|
| Linux foundation core (152 files) | 1,437 | 1,430 | 0 | 7 | yes, all four runs |
| Windows foundation full discovery (190 files) | 2,233 | 2,216 | 0 | 17 | yes, all four runs |

No timeout, retry, cancellation or flake occurred in any of the four runs. The per-test bound
(600 s) and the overall bound (1,500 s) were not changed. Peak RSS per test process is
**NOT MEASURED**: the workflow records total runner memory but no per-process high-water mark.

### 5.5 Decision and reasoning

- **Windows — IMPLEMENTED.** Node's implicit 3 resolves on a 4-CPU runner; 4 removes one more
  serialization point from the release-critical job and cut its test step by a repeatable ~5%
  (about 33 s) with exact test parity. The value is applied in the workflow and remains overridable
  through `windows_concurrency` for future controlled runs.
- **Linux — NOT ADOPTED, default retained.** 4 was faster in both pairs, but the effect is small and
  its magnitude is below the runner-to-runner variance seen for identical configurations elsewhere
  in this program (for example, 158 s versus 250 s for the same default configuration on two
  different runners). Adopting it would be an unproven change on the exact workload where the
  critical path is about to be restructured by Batch 4.
- The measurement hook is retained because it is off by default, validated twice, and is the only
  way to repeat this experiment later. It is documented as a benchmark-only control in
  [../operations/ci-optimization.md](../operations/ci-optimization.md).

### 5.6 Rejected alternative

Forcing 4 on Linux as well. Held back by the inconsistency above, not by a reliability regression:
there was none.

## 6. Batch 3 — Windows foundation sharding

_Pending Batch 2 evidence._

## 7. Batch 4 — Linux foundation sharding

_Pending Batch 3 evidence._

## 8. Batch 5 — Final targeted optimization and audit

_Pending Batches 2–4._

## 9. Final comparison

_Pending._
