# EGA Skills CI/CD optimization: Batches 2–5

Status: IN PROGRESS. Batches 2–4 complete; Batch 5 in progress.

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
| 3 — Windows sharding | COMPLETE | Two explicit shards + `foundation (windows-2022)` aggregator + digest-verified coverage | 39 CI contract tests; hosted failure injection (shard failure → aggregator → gate) | Full wall −35.9%, runner-minutes −1.6% | IMPLEMENTED |
| 4 — Linux sharding | COMPLETE | checks job + two core shards + `foundation (ubuntu-latest)` aggregator | 40 CI contract tests; hosted failure injection (shard → aggregator → gate) | PR execution latency −28%, PR job-minutes +1.6 | IMPLEMENTED |
| 5 — Final optimization | IN PROGRESS | Pending | Pending | Pending | Conditional |

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

**Decision: IMPLEMENTED.** Two explicit Windows shards behind a real
`foundation (windows-2022)` aggregator cut the full-run critical path by 283 s (35.9%)
with no test-coverage change and no increase in runner-minutes.

### 6.1 Feasibility analysis

| Question | Answer | Evidence |
|---|---|---|
| Windows test discovery | 190 files at the Batch 2 head (189 recorded baseline + the new bounded-runner contract test) | `scripts/ci/test-ownership.json`, `[test:bounded] runtime … discoveredFiles:190` |
| Expected test and skip counts | 2,233 tests / 2,216 pass / 0 fail / 17 skipped before Batch 3's own test additions | Batch 2 runs, all four |
| Per-file durations | **NOT MEASURED** for Windows. Hosted logs do not label per-file wall time, and the archived log for the sampled baseline run was truncated. | Log inspection |
| Projected shard balance | 1.16 by heavy-file proxy | Linux per-file attribution in the audit applied to the two shards (below) |
| Branch-protection contexts | `foundation (ubuntu-latest)`, `foundation (windows-2022)`, `contract-f rls (ubuntu-latest)` on release/2.0 | Live ruleset read-back, unchanged by this work |
| `ci-gate` semantics | `needs` is not transitive, so every shard must be a direct dependency | `scripts/ci/classify-changes.mjs` |
| Windows isolation | Each shard is an independent job with its own checkout, install and build; no shared artifacts, no shared filesystem | Workflow structure |
| Expected critical-path gain | about 290 s | Measured single-job Windows wall 752–779 s split in two |
| Expected added runner-minutes | about +3 per full run (one extra install/build) | Modelled, then measured in §6.4 |

Projection used the only per-file attribution available — the Linux core run from the
audit — as a proxy for the Windows shape. It placed the two heaviest golden-router
files in different shards (`determinism` index 123 → shard 2, `runner` index 128 →
shard 1) and gave heavy-file sums of 147.5 s and 171.6 s, a ratio of 1.16. That
projection was optimistic; the measured ratio is 1.37 (§6.4). It is labelled modelled
and is not used as a result.

### 6.2 Implementation

- `scripts/ci/sharding.mjs` (new): the single partition rule — sorted file *i* goes to
  shard `(i % n) + 1` — plus `assertPartitionComplete` (duplicates and omissions fail)
  and `describeShard` (counts and SHA-256 digests of the selection and the full
  inventory).
- `scripts/release/run-tests-bounded.mjs`: accepts `--shard=i/n`, builds the inventory
  from `discover()` (unscoped) or the ownership group (scoped), asserts the whole
  partition is complete before running, passes an explicit file list to `node --test`,
  logs a `shard {…}` line and publishes the selection to `GITHUB_OUTPUT`. Combining
  `--shard` with explicit file arguments is refused rather than guessed. Sharding is
  additive: without `--shard` the runner behaves exactly as before, including default
  Node discovery.
- `.github/workflows/ci.yml`: Windows leaves the `foundation` matrix, which is now
  Ubuntu-only and keeps the required name `foundation (ubuntu-latest)`. Two explicit
  jobs, `foundation-windows-shard-1` and `-2`, share one anchored step list (same
  steps as before, `fail-fast: false` semantics preserved by using independent jobs),
  run `pnpm test:ci -- --shard=i/2` at the Batch 2 Windows concurrency, and publish
  their selection. `foundation-windows` is the aggregator and carries the exact
  required name `foundation (windows-2022)`.
- `scripts/ci/verify-shards.mjs` (new): the aggregator re-derives both partitions from
  the checked-in inventory and compares counts and digests with what each shard
  published. It fails on a missing, failed, cancelled, skipped, duplicated or drifted
  shard.
- `scripts/ci/classify-changes.mjs` / `check-gate.mjs`: the gate now requires the three
  Windows jobs as direct `needs` entries. `windowsSelected()` derives the expectation,
  and `ci-gate` derives the same predicate independently from the event context, so a
  disagreement between the two fails the gate instead of silently skipping Windows.
  Mode-aware validation: when Windows is selected all three jobs must be `success`;
  otherwise all three must be an explicit `skipped`. A green job outside a Windows
  selection is also rejected.

Why not Node's native `--test-shard`: it works with both discovery and an explicit
file list, and the rule above matches its observed index-parity distribution. It
cannot report which files it selected, though, so CI could not prove that the union
of the shards equals discovery. The runner therefore computes the same partition,
proves completeness inside every shard, and lets the aggregator re-derive it from the
repository. Coverage proof was worth more than the shorter invocation.

### 6.3 Release safety and negative tests

| Contract | Mechanism | Proof |
|---|---|---|
| Exact required names | `foundation (ubuntu-latest)` (Linux job), `foundation (windows-2022)` (aggregator), `contract-f rls (ubuntu-latest)` (unchanged) | `ci.yml`; required-context rehearsal below |
| Both real shards must pass | `ci-gate` lists both shards *and* the aggregator directly; the aggregator re-derives both selections | `tests/release/ci-release-path.test.mjs`, `tests/ci/classify-changes.test.mjs` |
| Missing shard | `needs` key absent → gate fails closed | unit test |
| Duplicate shard | both jobs report the same `shard_index` → aggregator fails | unit test |
| Cancelled or skipped shard while selected | result !== `success` → aggregator fails; gate also rejects `skipped` | unit test + hosted run below |
| Failed Windows setup/check | job fails before the Test step, aggregator sees `failure`, no outputs match | unit test (`did not succeed` precedes output comparison) |
| Invalid classifier mode | `gate()` rejects unknown modes before any other check | existing + new unit tests |
| Incorrect coverage or file count | selection digest, full digest, both counts and the scope are compared | unit test |
| Normal docs/web runs | Windows jobs skipped, gate expects `skipped` | hosted PR run `41631468804` green |

Hosted failure injection (temporary commit `ffb00bc`, reverted immediately after):

- Run [41632958074](https://github.com/egawilldoit/ega-skills/actions/runs/41632958074) —
  a Windows-only failing test injected into shard 1.
- `foundation-windows shard (1/2)`: **failure**, 1,247 tests, 1,237 passed, 1 failed
  (the injected assertion), 9 skipped, suite exited 1.
- `foundation-windows shard (2/2)`: **success**. Every Linux job: **success**.
- `foundation (windows-2022)` aggregator: **failure** with
  `verify-shards: foundation-windows-shard-1 did not succeed { result: 'failure' }`.
- `ci-gate`: **failure**, `ci-gate: required job missing or not successful
  { mode: 'full', windows: true, … }`.

The injection commit was removed with `git reset --hard` and a force-with-lease push;
the run above remains the evidence. Note that inserting one file at sorted index 4
shifted every later index and therefore reshuffled the partition — expected for
index-parity sharding and the reason the aggregator re-derives rather than trusts
counts.

### 6.4 Measured result

Single full run on `05bb054` (attempt 1), compared with the two Batch 2 windows runs at
the same concurrency on `c487883`. Different SHAs; the only source difference is Batch
3's own added tests.

| Measurement | Single Windows job (mean of 2) | Two shards | Change |
|---|---:|---:|---:|
| Windows test-step wall (critical shard) | 658 s | 358 s | −300 s |
| Windows foundation wall (critical path) | 765.5 s | 475 s | −290.5 s (−38%) |
| Full run wall | 788 s | 505 s | −283 s (−35.9%) |
| Summed job-minutes | 28.075 | 27.633 | −0.44 (−1.6%) |
| Runner jobs on the Windows leg | 1 | 3 (2 shards + 7 s aggregator) | +2 |

The duplicated Windows install/build (about 113 s per job) is almost exactly paid back
by the shorter shards: total test time across both shards was 620 s against 658 s in a
single job, because each shard has half the process-level memory and CPU pressure.
Runner-minutes therefore did not increase.

Per-shard detail:

| Job | Wall | Test step | Files | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|---:|---:|---:|
| `foundation-windows shard (1/2)` | 373 s | 262 s | 95 | 1,020 | 1,012 | 0 | 8 |
| `foundation-windows shard (2/2)` | 475 s | 358 s | 95 | 1,226 | 1,217 | 0 | 9 |
| **Union** | — | 620 s of work | **190** | **2,246** | **2,229** | **0** | **17** |
| `foundation (windows-2022)` (aggregator) | 7 s | — | — | — | — | — | — |

Shard union evidence: the runner logged `shard {"index":1,"count":2,"files":95,"fullFiles":190,…}`
and the same for shard 2, and both published digests over the identical 190-file
inventory (`fullDigest` `c9da481f2a7b…`). The aggregator recomputed both partitions
from the checkout and matched them, and reported
`union=190/190`.

Coverage parity: 2,246 tests is exactly the Batch 2 total of 2,233 plus the 13 tests
added by Batch 3's own contract tests (Linux core moved 1,437 → 1,450 on the same
head). No test was skipped, merged or retried. The deliberate Windows web overlap is
preserved: both Windows jobs still run the web files (19 in each shard).

### 6.5 Balance, risks and rollback

- Measured balance ratio 358 s / 262 s = **1.37**, above the 1.25 target used in the
  original plan. The heavier shard carries the x10 determinism file and the
  provenance fixture. The cost of the imbalance is bounded: shard 1 finishes 96 s
  early while the run waits on shard 2. A weighted scheduler was **not** added,
  because it needs a maintained per-file weight table and the brief reserves that for
  the case where native partitioning is not enough. It is re-examined in Batch 5.
- Index-parity membership is order-sensitive: adding or removing one test file
  reshuffles every later assignment. Balance must be re-measured after inventory
  changes; the completeness and digest checks make a wrong reshuffle loud, not silent.
- Rollback: revert the Batch 3 commit. The shard script and the aggregator are
  additive; `run-tests-bounded` still works without `--shard`, and restoring the
  Windows matrix entry restores the previous single job with the same required name.

## 7. Batch 4 — Linux foundation sharding

**Decision: IMPLEMENTED.** Two Linux core shards behind the real
`foundation (ubuntu-latest)` aggregator, plus a separate non-test checks job, cut the
ordinary pull-request execution latency by 79–83 s (−28%).

### 7.1 Critical-path reassessment after Batch 3

| Job on a normal PR | Wall after Batch 3 |
|---|---:|
| `foundation (ubuntu-latest)` | 264 s (test 246 s) |
| `web console (ubuntu-latest)` | 99–113 s |
| `web isolation (real PostgreSQL 16)` | 60–68 s |
| `contract-f rls (ubuntu-latest)` | 53–56 s |
| `docs` / `classify` / `ci-gate` | 6–11 s each |

Linux foundation was the critical path by more than 2×, and full-run wall was still
bound by the Windows shards (475–487 s). Sharding Linux therefore could not shorten a
full run; it targets ordinary PR CI, which is the stated goal of this batch. The batch
is justified on that basis, not on full-run wall.

### 7.2 Implementation

- `foundation-checks (ubuntu-latest)` (new): every non-test gate — artifact
  verification, web artifact staging check, catalog freshness, typecheck, registry
  cold-import performance, token vectors, frozen specs. About 16–18 s.
- `foundation-linux shard (1/2)` and `(2/2)` (new): checkout, Node, corepack, install,
  lockfile check, build, then `run-tests-bounded.mjs --ci-scope=core --shard=i/2`.
  Same anchored step list, same published shard metadata, same `fail-fast: false`
  semantics as independent jobs.
- `foundation (ubuntu-latest)` (rewritten): the aggregator carrying the exact required
  name. It runs `verify-shards.mjs` against `CI_SHARD_SCOPE=core`, then fails if the
  checks job did not succeed — the aggregator must not be green while a non-test gate
  failed, because the ruleset sees only this name.
- `scripts/ci/classify-changes.mjs`: `LINUX_FOUNDATION_JOBS` are now part of the fixed
  key set and are required to be `success` whenever the mode selects foundation, and
  an explicit `skipped` in docs mode. `ci-gate` lists all three directly.
- The 152-file core discovery is unchanged; `--shard` splits that same inventory.

### 7.3 Results

| Measurement | Before (2 runs) | After |
|---|---:|---:|
| PR execution latency (first job start → `ci-gate` complete) | 282 s and 286 s | **203 s** |
| PR wall as reported by GitHub (includes queueing) | 284–286 s | 325 s (122 s of runner queue while a manual full run was in flight) |
| Linux core test step | 246 s | 139 s / 165 s (critical shard) |
| Linux foundation wall | 264 s | 180 s (critical shard) |
| PR job-minutes | 8.5 | 10.1 |
| Full-run wall | 505 s | 522 s (still Windows-bound) |

Execution latency is the honest comparison: the post-change run was created during a
manual full run and waited 122 s for a runner, which a sweep of `run_started_at` does
not reveal, while `first job start → gate` isolates the workflow's own work.

- **Wall gain:** −79 to −83 s, −28%.
- **Runner cost:** +1.6 job-minutes per PR run (one extra install/build and one
  aggregator job). On this public repository the runners are free; the cost is
  concurrency capacity, not money.
- **Balance:** 139 s versus 165 s = **1.19**, inside the 1.25 planning target and
  stable across both runs (141/164 on the PR run).

### 7.4 Coverage and gate evidence

| Job | Files | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|---:|
| `foundation-linux shard (1/2)` | 76 | 634 | 630 | 0 | 4 |
| `foundation-linux shard (2/2)` | 76 | 817 | 814 | 0 | 3 |
| **Union** | **152** | **1,451** | **1,444** | **0** | **7** |

1,451 is the previous 1,450 plus the one gate-contract test Batch 4 added; the same
+1 appears on the Windows total (2,246 → 2,247). The aggregator logged
`Verify the checks job and both shards succeeded` (status 0) and the shards published
digests over the identical 152-file core inventory.

Hosted failure injection (temporary commit `e2ce2a7`, reverted immediately after):

- Run [41636516276](https://github.com/egawilldoit/ega-skills/actions/runs/41636516276) —
  an always-failing core test injected into shard 1.
- `foundation-linux shard (1/2)`: **failure**. `foundation-linux shard (2/2)`:
  **success**. `foundation-checks`: **success**.
- `foundation (ubuntu-latest)`: **failure** with
  `verify-shards: foundation-linux-shard-1 did not succeed { result: 'failure' }`.
- `ci-gate`: **failure**. `docs`, `contract-f rls` and `web isolation`: success.
- The Windows jobs were correctly `skipped` on that pull-request run.

The same run also reproduced the pre-existing `ega-719-artifact-release-authorization`
flake: one test hung to the 600 s per-test bound and timed out (`test timed out after
600000ms`), which is the documented unresolved reliability investigation, not a Batch 4
regression. The bounded runner reported the timeout instead of hiding it. That is
recorded in the remaining risks.

### 7.5 Risks and rollback

- The ruleset only watches `foundation (ubuntu-latest)`, so the aggregator must fail
  when `foundation-checks` fails. It does, both through `ci-gate` (direct dependency)
  and through the aggregator's own result check.
- Linux shard membership is index-parity over the sorted 152-file core inventory, so
  adding a test file reshuffles assignments. Re-measure balance after inventory changes;
  digests make a wrong reshuffle loud.
- Rollback: revert the Batch 4 commit. `sharding.mjs` and the aggregator are shared
  with Batch 3, so reverting Batch 3 alone would restore the Windows matrix while
  leaving the Linux split intact only if the two commits are separated carefully; the
  intended rollback unit is both sharding commits together.

## 8. Batch 5 — Final targeted optimization and audit

_Pending Batches 2–4._

## 9. Final comparison

_Pending._
