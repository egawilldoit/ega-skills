# EGA Skills CI/CD optimization results

Status: Batch 0 baseline record. No post-change speedup has been measured. This document records the corrected baseline, the measurement method, the available evidence, and the gaps that later batches must close. It must not be cited as evidence that any proposed optimization has landed.

Related: [performance-audit.md](performance-audit.md), [optimization-plan.md](optimization-plan.md).

## 1. Scope and data sources

| Item | Value | Availability |
|---|---|---|
| Repository | `egawilldoit/ega-skills` (public) | GitHub |
| Revision audited | `e5a3ae793784ff90d9c9f707e1499f4d132650b3` | `origin/main` |
| Workflow | `.github/workflows/ci.yml`, workflow id `349779559` | Blob `ffb5071889ab047fecf3156886b56a86b8806154` at the audited commit |
| Recent sample | 24 `CI` runs, 2026-11-01T14:24Z to 22:17Z | `/tmp/opencode/ci-runs.json` (not committed) |
| Monthly sample | 282 run records, 2026-10-04T10:52:51Z to 2026-11-01T22:11:34Z | `/tmp/opencode/ci-30d.json` (not committed); API reported 283 runs |
| Rulesets | Read live 2026-11-02 | `gh api repos/egawilldoit/ega-skills/rulesets` |
| Repository source | `e5a3ae7` | Current worktree |

Raw API responses are not committed. Only the derived summaries below are recorded.

## 2. Measurement methodology

### 2.1 Attempt-aware timestamps

A run has three distinct times:

- `created_at`: when the run was requested.
- `run_started_at`: when the latest attempt actually started.
- `updated_at`: when the latest attempt finished.

"Original creation to green" uses `created_at` and the final required job's `completed_at`. "Latest-attempt latency" uses `run_started_at` and the same completion. They answer different questions: the first includes queueing, cancellation, and rerun delay; the second is the cost of the successful attempt.

Example: run `41353519798` was created at 21:44:09Z, its successful attempt started at 22:07:12Z, and `ci-gate` completed at 22:11:02Z. That is 26m53s original creation to green and 3m50s latest-attempt latency. Reporting either number alone would be misleading.

A job has `created_at`, `started_at`, and `completed_at`:

- Runner queue = `created_at → started_at`.
- Execution = `started_at → completed_at`.
- For `ci-gate`, the delay before `started_at` is mostly dependency wait, not runner queue.

### 2.2 Job-minutes

Job-minutes are the sum of executed job `started_at → completed_at` durations, not wall time. A rerun repeats some job names: sum actual executions and deduplicate by execution id across attempts so a carried job is not counted twice. The 30-day figure below is built from latest attempts only, so it is a lower bound and omits earlier failed attempts.

Physical job time is not billable cost. The public repository uses GitHub-hosted standard runners without paid concurrency for this workload; the figures are for critical-path and capacity reasoning.

### 2.3 Cohorts

Keep these separate:

- Docs mode.
- Web mode.
- Full mode on a pull request to `main`.
- Push to `main`.
- Release-target pull request (`release/2.0`), including the Windows matrix.
- Push to `release/2.0`.
- Manual full run.
- Reruns and cancelled attempts.

Never mix failed, cancelled, or aborted work into a successful-validation median. Report wasted work separately.

### 2.4 Parity and resources

For every later batch record:

- Discovered test-file count and executed test count.
- The exact file set claimed by each shard, with zero duplicates and zero omissions.
- Node version, `os.availableParallelism()`, CPU count, total memory, `--test-isolation` mode, and effective `--test-concurrency`.
- Peak RSS and retained readers or handles where observable.
- Per-file process elapsed time; the reporter's aggregate test duration is not a file-process time.

## 3. Baseline: recent 24-run sample

### 3.1 Successful-run wall latency

| Population | n | Latest-attempt start to `ci-gate` | Original creation to `ci-gate` | Source |
|---|---:|---:|---:|---|
| Linux successful runs | 15 | median 6.00 min; p90 about 6.33 min | median 6.083 min; p90 10.33 min | 24-run sample; two reruns drive the creation tail |
| Windows-enabled successful runs | 4 | median 17.6 min; p90 19.2 min | median 17.6 min; p90 19.2 min | Four observations; mixed workflow versions |

Job-minutes across the same 19 successful runs: mean 17.278, median 12.383, total 328.283. Job-minutes are not wall latency and must not be substituted for it.

The Windows-enabled sample is too small and version-mixed to be a stable production p90. The Linux sample is small as well. These are descriptive baselines.

### 3.2 Cancelled work

Five of 24 runs were cancelled. They consumed 21.2 job-minutes. All were ordinary pull-request runs superseded by the concurrency group; no release-target run was cancelled.

### 3.3 Job-level baselines

| Job | n | Median | p90 |
|---|---:|---:|---:|
| `web console (ubuntu-latest)` | 19 | 5.7 min | 5.9 min |
| `foundation (ubuntu-latest)` | 19 | 4.3 min | 4.5 min |
| `web isolation (real PostgreSQL 16)` | 19 | 1.0 min | 1.1 min |
| `contract-f rls (ubuntu-latest)` | 19 | 1.0 min | 1.0 min |
| `docs` | 19 | 0.1 min | 0.1 min |
| `classify` | 19 | 0.1 min | 0.1 min |
| `ci-gate` | 19 | 0.1 min | 0.1 min |
| `foundation (windows-2022)` | 4 | 17.2 min | 18.9 min |
| `web console (windows-2022)` | 4 | 10.1 min | 11.8 min |

Runner queue was median about 2 s and max about 3 s. Run creation to run start was 0 s in 22 of 24 runs, 4.5 min in one, and 23.1 min on a rerun. The latter delays include rerun waiting and are not measurements of runner queue. This is why creation-to-green and latest-attempt latency must be reported separately.

### 3.4 Work inside the two long steps

Linux web step in run `41355875171`: 316 s, 464 s of attributed test time.

| File | Test time |
|---|---:|
| `tests/web/skills.test.mjs` | 247.4 s |
| `tests/web/catalog.test.mjs` | 94.1 s |
| `tests/web/api-routes.test.mjs` | 52.5 s |
| 35 remaining files | 70.4 s |

Linux core step in the same run: 246 s, 624 s of attributed test time.

| File | Test time |
|---|---:|
| `tests/router/golden/determinism.test.mjs` | 101.9 s |
| `tests/router/golden/runner.test.mjs` | 90.0 s |
| `tests/mcp/provenance-disclosure.test.mjs` | 45.2 s |
| `tests/project/intake-adoption-apply.test.mjs` | 24.5 s |
| `tests/router/golden/setup.test.mjs` | 22.0 s |
| `tests/cli/lock.test.mjs` | 19.5 s |
| `tests/catalog/catalog-generator.test.mjs` | 16.0 s |
| 144 remaining files | about 305 s |

Attribution covered 38/38 web files and 146/151 core files, and 607 of 624 reported test-seconds. Values come from one run's reporter output; another run can shift them.

### 3.5 Windows step detail

Run `41326881601` (PR head `787f1f4`), 9 jobs, wall 18.53 min, 38.88 job-minutes:

| Job | Step | Duration |
|---|---|---:|
| `foundation (windows-2022)` | Test (unscoped `pnpm test:ci`, 189 files) | 16.13 min (967 s) |
| `foundation (windows-2022)` | Install from frozen lockfile | 1.17 min |
| `web console (windows-2022)` | Web API and integration tests | 6.80 min |
| `web console (windows-2022)` | Install from frozen lockfile | 1.00 min |

The same run's reporter aggregate for the Windows suite was about 2,145 s of test duration. That is an aggregate across concurrent test processes, not the step wall and not a file-process elapsed time.

The Windows test step is the release-path binding step in this run, but one observation and mixed workflow versions limit the conclusion.

## 4. Baseline: 30-day volume

| Signal | Value |
|---|---:|
| Runs reported by the API | 283 |
| Records fetched | 282 |
| Window | 2026-10-04T10:52:51Z to 2026-11-01T22:11:34Z |
| Success / cancelled / failure | 210 / 8 / 64 |
| Jobs in fetched latest attempts | 1,549 |
| Latest-attempt job-minutes | 6,383.7167 |
| Windows-enabled runs | 244 of 282 |

The 6,383.7167 figure is a lower bound. It uses the latest attempt for each run, so earlier failed attempts are missing. It is not a monthly forecast and not a billable cost.

Windows jobs were about 68–71% of job-minutes inside the four Windows-enabled recent runs. That sample is biased toward Windows-enabled runs; it is not a share of all CI work.

## 5. Baseline: parity inventory

| Inventory | Count | Evidence |
|---|---:|---|
| Default Node-discovered test files | 189 | `scripts/ci/test-ownership.json` |
| Core files | 151 | Same |
| Web files | 38 | Same |
| `.rls.mjs` files outside ordinary discovery | 8 | `scripts/ci/ownership.mjs:4`; `ci.yml:313-345,392-413` |
| Windows unscoped suite | 189 files | `ci.yml:123`; run `41326881601` |
| Linux core scope | 151 files | `--ci-scope=core` |
| Linux web scope | 38 files | `--ci-scope=web` |
| Registry cold-import performance | 1 file, `--test-concurrency=1` | `package.json`; `ci.yml:116-117` |

The eight `.rls.mjs` suites are: `tests/web/cross-workspace-isolation.rls.mjs`, `tests/rls/contract-f.rls.mjs`, `tests/rls/catalog-bootstrap.rls.mjs`, `tests/rls/hosted-live-membership.rls.mjs`, `tests/rls/hosted-skill-scoped-live-membership.rls.mjs`, `tests/rls/telemetry-authz.rls.mjs`, `tests/rls/telemetry-scheduler.rls.mjs`, and `tests/rls/telemetry-gateway.rls.mjs`. These run in the `web-isolation` and `rls` jobs and are not part of `--ci-scope=web`.

A failed web attempt (`41353519798` attempt 1) reported 792 tests, 130 suites, 782 pass, 1 fail, 9 skipped, and `duration_ms` 1,092,534 (about 18.2 min). That is a failed attempt and is excluded from performance medians; it is recorded here so future parity comparisons do not mistake it for a successful baseline.

## 6. Resources observed and not observed

| Item | Status |
|---|---|
| Runner labels | `ubuntu-latest`, `windows-2022`; runner names are GitHub Actions runners |
| Published standard-runner specification | 4 CPU / 16 GiB for public-repository Ubuntu and Windows standard runners |
| Runtime CPU count | Not logged |
| Runtime total memory | Not logged |
| Node version | Workflow requests Node 24; one job log references Node `v24.22.1` |
| pnpm | Corepack resolves `pnpm-10.0.0.tgz` in the sampled log |
| Default test concurrency | Node 24 documents `availableParallelism() - 1` with process isolation; not logged in CI |
| Expected default on a 4-CPU runner | About 3, not 1 |
| Registry performance concurrency | Explicitly 1 (`pnpm test:perf:registry`) |
| Actions cache | None configured |

No workflow step records `os.availableParallelism()`, `os.cpus()`, `os.totalmem()`, or the effective `--test-concurrency`. Batch 2 must add that instrumentation before making any concurrency claim.

## 7. Reliability investigation: expected 403, observed 503

| Field | Value |
|---|---|
| Run | `41353519798`, attempt 1 |
| Job | `124989342509`, `web console (ubuntu-latest)` |
| Job window | 2026-11-01T21:47:10Z to 22:06:43Z |
| Failing test | `tests/web/ega-719-artifact-release-authorization.test.mjs:209` |
| Expectation | HTTP 403, `E_WEB_CONTROL_PLANE_FORBIDDEN` |
| Observed | HTTP 503, `E_WEB_READ_UNAVAILABLE` |
| Message | "Control-plane data is unavailable: The control-plane read endpoint could not be reached" |
| Source | `apps/web/server/supabase-read.ts:1146` (session variant at `:1098`) |
| Local mock | HTTPS server on `127.0.0.1:34974` (`tests/web/ega-719-artifact-release-authorization.test.mjs:23-66`) |
| Proximate cause | The local HTTPS mock was unreachable from the BFF during the assertion |
| Deep cause | Unconfirmed; separate investigation |
| Attempt 2 | Successful; original creation to green 26m53s, latest attempt to green 3m50s |

This is not evidence for or against the four-file config pattern. The failing file is not one of the four Batch 1 files. Do not waive the authorization assertion.

Log retrieval used the job-log API for the old attempt, not `gh run view`, which can return the latest attempt:

```sh
gh api repos/egawilldoit/ega-skills/actions/jobs/124989342509/logs \
  --allow-escape-sequences |
  sed -e 's/\x1b\[[0-9;]*m//g'
```

The attempt archive also works: `gh api repos/egawilldoit/ega-skills/actions/runs/41353519798/attempts/1/logs`.

## 8. Live gate and ruleset read-back (2026-11-02)

| Ruleset | ID | Target | Required checks |
|---|---:|---|---|
| `release-2.0-protection` | 23893800 | `refs/heads/release/2.0` | `foundation (ubuntu-latest)`, `foundation (windows-2022)`, `contract-f rls (ubuntu-latest)`; strict policy |
| `main-protection` | 22345614 | `refs/heads/main` | None |

`ci-gate` is a workflow job (`ci.yml:420-435`) and a Vercel deployment check (`externalCheckName` `ci-gate`, `scripts/release/verify-live.mjs:411-444`). It is not one of the ruleset required contexts. Preserve both layers.

## 9. Data gaps

1. No runtime CPU, memory, Node parallelism, isolation mode, or effective concurrency is recorded by the workflow.
2. No committed per-file process timing exists. The audit's per-file table comes from one successful run's reporter output.
3. The recent sample is small and version-mixed; the four Windows-enabled runs are not a stable p90.
4. The 30-day total is a lower bound from latest attempts and omits earlier failed attempts.
5. Cancelled and failed attempts are reported separately, but their exact job-level records are incomplete for older runs.
6. The 503 investigation has a proximate cause (unreachable local HTTPS mock) but no confirmed deep cause.
7. No post-change measurement exists for Batch 1 or later. All expected effects remain unmeasured.
8. Blacksmith eligibility, quota, and Windows image parity were not readable with the current token. No decision depends on them.

## 10. What this baseline does not claim

- It does not claim that any optimization has been implemented.
- It does not claim a new median, p90, or runner-minute reduction.
- It does not claim Windows runs at concurrency 1. The effective value is unverified.
- It does not claim the local OOM kill proves a retained-handle root cause.
- It does not claim the 503 was caused by test-config reuse.
- It does not claim a population-wide Windows share from the Windows-enabled sample.
- It does not claim Blacksmith equivalence or a paid-runner benefit.

## 11. Next measurement

Batch 1 will record, for each of the four test files:

- Discovered file count, test count, and assertion set before and after.
- Per-file process wall time.
- Config construction count and reader open/close count where observable.
- Peak RSS.
- Committed-artifact digest before and after.
- Hosted Linux and Windows run IDs with attempt-aware timestamps and job-minutes.

Batch 2 will record runtime CPU, memory, `os.availableParallelism()`, isolation mode, effective concurrency, per-file process time, wall time, RSS, flakes, and runner-minutes for 3 versus 4. No value is adopted without repeatable evidence.

## Source references

- `.github/workflows/ci.yml`
- `scripts/ci/classify-changes.mjs`, `scripts/ci/check-gate.mjs`, `scripts/ci/ownership.mjs`, `scripts/ci/test-ownership.json`
- `scripts/release/run-tests-bounded.mjs`
- `apps/web/server/env.ts`, `apps/web/server/registry.ts`, `apps/web/server/release-identity.ts`
- `packages/mcp/src/hosted.ts`
- `tests/web/skills.test.mjs`, `tests/web/catalog.test.mjs`, `tests/web/releases.test.mjs`, `tests/web/category-browse.test.mjs`
- `tests/web/ega-719-artifact-release-authorization.test.mjs`, `apps/web/server/supabase-read.ts`
- `docs/operations/ci-optimization.md`
- Runs: `41355875171`, `41353519798` (failed job `124989342509`), `41326881601`, `41320045429`, `41318250172`, `41317115302`, `41329224949`, `41353348511`.
