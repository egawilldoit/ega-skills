# EGA Skills CI/CD optimization results

Status: Batch 0 COMPLETE; Batch 1 VALIDATED locally and on hosted Linux/Windows at `2c1fb6c`; Batch 2 PENDING; Batches 3–5 CONDITIONAL / NOT STARTED. This document separates the historical baseline, local measurements, and successful individual hosted runs. The full optimization program is not complete.

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
| Baseline repository source | `e5a3ae7` | Historical audited revision |
| Validated Batch 1 source | `2c1fb6c` | Hosted runs in section 12 |

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
7. Batch 1 local measurements are in section 11 and successful hosted runs in section 12. Controlled hosted before/after attribution and later batches remain unmeasured.
8. Blacksmith eligibility, quota, and Windows image parity were not readable with the current token. No decision depends on them.

## 10. What this baseline does not claim

- The baseline sections describe pre-change CI; section 11 records local Batch 1 measurements and section 12 records hosted validation.
- It does not claim a new median, p90, or runner-minute reduction.
- It does not claim Windows runs at concurrency 1. The effective value is unverified.
- It does not claim the local OOM kill proves a retained-handle root cause.
- It does not claim the 503 was caused by test-config reuse.
- It does not claim a population-wide Windows share from the Windows-enabled sample.
- It does not claim Blacksmith equivalence or a paid-runner benefit.

## 11. Batch 1 local measurement: one default config per file

This is local Linux evidence only, not hosted CI evidence. It was measured in the isolated worktree at `1e6fee8` plus the four test-file edits, on host `openclaw` with Node `v24.18.0` and 2 visible CPUs. The hosted runners advertise 4 CPUs, so absolute local times are not hosted forecasts.

### 11.1 Method

Each file ran alone through the existing bounded runner, with GNU time around it and the spec reporter for exact test names:

```sh
/home/ubuntu/.local/bin/heavy --label <label> --timeout 1800 --memory-mib 3072 -- \
  /usr/bin/time -v node scripts/release/run-tests-bounded.mjs \
    --test-reporter=spec tests/web/<file>
```

Setup was `pnpm install --frozen-lockfile` and `pnpm build` under the same wrapper. The first skills baseline attempt used `--memory-mib 1400` and was OOM-killed at the cap (`oom_kill=1`, peak equal to the cap). That attempt is discarded; the successful baseline below used 3072 MiB. No test timeout was raised.

Exact setup and post-change checks:

```sh
/home/ubuntu/.local/bin/heavy --label project:ega-skills:b1-install --timeout 1200 --memory-mib 1536 -- pnpm install --frozen-lockfile
/home/ubuntu/.local/bin/heavy --label project:ega-skills:b1-build --timeout 900 --memory-mib 1536 -- pnpm build
node --test tests/ci/classify-changes.test.mjs tests/ci/test-ownership.test.mjs
node -e "import('./scripts/ci/ownership.mjs').then(m => { const d = m.discover(); m.validateOwnership(d, m.manifest); })"
git diff --check
```

The ownership tests passed 13/13 and discovery validated 189 files (151 core, 38 web, 189 unique), with all four edited files present in the web group.

The host pool initially had no admission headroom because `memory.high` minus `memory.current` was below the wrapper's own reserve. Reclaiming inactive page cache through the delegated `memory.reclaim` interface restored headroom; nothing in the repository or another job's processes was changed.

### 11.2 Wall time, RSS, and counts

`tests`, `suites`, `pass`, `fail`, `skip` are the Node reporter counts. Wall and RSS are GNU time around the bounded runner; RSS is the largest single descendant, not a sum across concurrent processes.

| File | Tests / suites (before = after) | Pass / fail / skip (before = after) | Wall before | Wall after | Change | Max RSS before | Max RSS after |
|---|---|---:|---:|---:|---:|---:|---:|
| `tests/web/skills.test.mjs` | 61 / 11 | 61 / 0 / 0 | 389.64 s | 146.26 s | −62.5% | 2,410 MiB | 1,155 MiB |
| `tests/web/catalog.test.mjs` | 68 / 14 | 68 / 0 / 0 | 107.95 s | 15.26 s | −85.9% | 1,364 MiB | 689 MiB |
| `tests/web/releases.test.mjs` | 44 / 8 | 44 / 0 / 0 | 13.62 s | 7.69 s | −43.5% | 422 MiB | 390 MiB |
| `tests/web/category-browse.test.mjs` | 11 / 4 | 11 / 0 / 0 | 10.74 s | 4.89 s | −54.5% | 329 MiB | 247 MiB |
| **Total** | **184 / 37** | **184 / 0 / 0** | **521.95 s** | **174.10 s** | **−66.6%** | 2,410 MiB peak | 1,155 MiB peak |

The spec-reporter name set was byte-identical before and after for every file (83, 96, 60 and 19 name/suite lines respectively). Static assertion call sites are unchanged at 156, 207, 212 and 64 (639 total across the four files). No test, assertion, timeout, or expected value was removed or changed.

### 11.3 Config reuse and handle evidence

Before the change, there were 126 statically counted default call sites (`committedConfig()` and default `fullCatalog()`); each execution built a fresh config, and several sites run inside 114-skill loops. After the change those sites share four file-scoped constants, one per file.

A local-only probe (removed before handoff) opened one config, called `getRegistry` 20 times, then closed and reopened:

```json
{"before":0,"afterTwenty":1,"afterClose":0,"afterReopen":1}
```

That confirms the registry still reuses one handle per config identity, `closeRegistry()` really closes it, and the same frozen default config reopens exactly one handle afterwards. Explicit overrides still construct fresh configs because any own enumerable key short-circuits the shared constant.

### 11.4 Cleanup and artifact integrity

A temporary copy of `releases.test.mjs` (untracked, removed before handoff) added one intentional failure after `copyArtifact()`. The run exited 1 with 44 pass and the one injected failure; the suite exited in 8.08 s, so no handle kept the process alive, the injected temp directory was removed, and the committed artifact digest was unchanged.

The committed artifact corpus is 872 files. Its sorted-file SHA-256 was identical before any baseline run, after the baselines, after the four post-change runs, and after the failure injection:

```text
08e086198728b8eeb2dd4dfa8284c0b08ec109f16f4702c724d773a34b3fc13a
```

### 11.5 Limitations

- This is one local 2-CPU host in sequential order. The after runs followed the baselines, so warm OS/file cache may favor the after column. The reuse mechanism, the handle count, and the unchanged coverage are stronger evidence than the wall delta alone; hosted validation is recorded separately in section 12.
- GNU time RSS does not see resources of processes outside its waited-for tree; it is a per-process peak, not an aggregate.
- The local 1400 MiB OOM was an artifact of the test-run cap, not a defect in the patched tests.
- Hosted validation is now available in section 12. Historical before/after comparisons remain descriptive because the baseline is not a controlled same-runner experiment.

## 12. Hosted Batch 1 validation — 2026-11-02

**Verdict: Batch 1 passes hosted Linux and Windows validation. The full implementation program is not complete.**

Validated source: `2c1fb6cc3e004b007d064740cdcd839fd802879b`.
Workflow blob: `ffb5071889ab047fecf3156886b56a86b8806154` (`.github/workflows/ci.yml`).
Both runs used attempt 1, branch `perf/ci-speed-reliability`, Node v24.22.1, and the existing workflow. No workflow, application, artifact, gate, ruleset, or runner-provider changes were needed for Batch 1.

| Run | Event | Created → ci-gate complete | Summed executed job time | Conclusion |
|---|---|---:|---:|---|
| [41503801407](https://github.com/egawilldoit/ega-skills/actions/runs/41503801407) | pull_request | 4m49s | 9.867 job-min | success |
| [41503824320](https://github.com/egawilldoit/ega-skills/actions/runs/41503824320) | workflow_dispatch, full Linux + Windows | 14m52s | 30.433 job-min | success |

PR run timestamps: created/started `18:46:57Z`, gate complete `18:51:46Z`, workflow updated `18:51:47Z`.
Manual full timestamps: created/started `18:47:06Z`, gate complete `19:01:58Z`, workflow updated `19:01:59Z`.
No rerun or cancellation occurred in these runs. API run start equals creation; first job start was 3s/4s later. These are startup observations, not a measured runner-queue decomposition. Job time below includes each job's setup and teardown, calculated from GitHub job start/completion timestamps. It is physical elapsed runner time, not a billing invoice or monthly forecast. The two distinct runs consumed 40.300 summed job-minutes in total; no job execution is counted twice.

### 12.1 Job and step timings

| Run | Job | Job wall | Test step wall | Frozen install |
|---|---|---:|---:|---:|
| pr | classify | 0m11s | — | — |
| pr | docs | 0m10s | — | — |
| pr | foundation (ubuntu-latest) | 4m24s | 4m05s | 0m04s |
| pr | contract-f rls (ubuntu-latest) | 0m57s | — | 0m04s |
| pr | web console (ubuntu-latest) | 2m59s | 2m21s | 0m05s |
| pr | web isolation (real PostgreSQL 16) | 1m03s | — | 0m05s |
| pr | ci-gate | 0m08s | — | — |
| full | classify | 0m08s | — | — |
| full | docs | 0m07s | — | — |
| full | contract-f rls (ubuntu-latest) | 0m53s | — | 0m04s |
| full | foundation (windows-2022) | 14m27s | 12m29s | 1m13s |
| full | web console (windows-2022) | 6m19s | 4m23s | 1m16s |
| full | foundation (ubuntu-latest) | 4m25s | 4m07s | 0m04s |
| full | web isolation (real PostgreSQL 16) | 1m07s | — | 0m04s |
| full | web console (ubuntu-latest) | 2m53s | 2m19s | 0m05s |
| full | ci-gate | 0m07s | — | — |

The PR critical path is Linux foundation, followed by gate startup/execution. The manual full critical path is Windows foundation: its Test step lasted 12m29s, while Windows web integration finished earlier. Dedicated web and PostgreSQL jobs remain concurrent. Windows install took 73s in foundation and 76s in web, compared with 4–5s for Linux; installation is a remaining setup cost, not the dominant full-run cost.

### 12.2 Executed coverage readback

From the completed manual run logs (main Node test invocation summaries; overlapping scopes must not be added as unique coverage):

| Invocation | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Linux foundation core | 1,433 | 1,426 | 0 | 7 |
| Windows foundation full discovery | 2,225 | 2,208 | 0 | 17 |
| Linux web integration | 792 | 783 | 0 | 9 |
| Windows web integration | 792 | 783 | 0 | 9 |

Windows full discovery deliberately includes web coverage; Linux core plus web also totals 2,225 tests. Platform-specific skips differ by one: this report records the actual counts and does not call skipped tests passes. No test-skipping code changed in Batch 1. The local four-file check passed all 184 tests with identical names and assertion call sites; hosted scope summaries establish execution of the larger workloads, not an independent per-file name-set comparison.

Additional checks succeeded: React behavior, frozen specs, artifact verification/staging, catalog freshness, typechecks, registry cold-import performance, token vectors, pinned source fixture checks, real PostgreSQL isolation/telemetry/retention and RLS. RLS summaries were 15, 27, 4 and 5 passing tests; isolation summaries were 38, 52, 1 and 1 passing tests. Both ci-gate jobs succeeded. No release protection context was renamed or weakened.

### 12.3 Interpretation and limits

| Measurement | Historical or local before | Observed after | Descriptive reduction |
|---|---:|---:|---:|
| Linux creation → gate | historical median ~360s | individual PR run 289s | ~19.7% |
| Full Linux/Windows creation → gate | historical median ~1056s | individual full run 892s | ~15.5% |
| Linux web integration step | historical sample 316s | individual runs 139–141s | ~55.4–56.0% |
| Four targeted files, local sequential sum | 521.95s (~522s) | 174.10s (~174s) | ~66.6% |
| Local peak process RSS | 2,410 MiB | 1,155 MiB | ~52.1% |

The percentages compare the stated observations; they are not estimates of a controlled causal effect. The hosted rows compare historical medians/samples with individual runs. The local rows use the same 2-CPU VM, with sequential-order warm-cache limitations. Job-minutes are 9.867 for the PR and 30.433 for full Linux/Windows; no matched pre-change job-minute reduction is claimed.

- Hosted Linux web step was 141s in the PR run and 139s in the manual run. The historical sample was about 316s, but workflow/environment differences and the small sample prevent attributing the entire difference to Batch 1.
- Full Windows foundation Test is still the dominant release-mode cost. Historical 967s versus this 749s is descriptive, not a controlled speedup estimate.
- Historical Linux median about 6m and Windows-enabled median about 17.6m are version-mixed baselines, not paired controls for these successful runs.
- No stable new p90, per-file process timings, aggregate RSS, CPU visibility, effective concurrency, or cache-hit attribution can be established from these two runs. Batch 2 must instrument those values.
- The earlier 503 authorization-test failure remains a separate, unresolved root-cause investigation. These successful runs do not prove it cannot recur.
- Vercel MCP and web-console previews were ready; auth was intentionally ignored. Preview status is not production acceptance. Nothing was merged or deployed by this work.

## 13. Program status and next batch

| Batch | Status | Evidence / remaining condition |
|---|---|---|
| 0: corrected audit and plan | COMPLETE | Full 43-technique assessment and baseline documentation committed in `1e6fee8` |
| 1: four-file default config reuse | VALIDATED | Implementation `2c1fb6c`; local parity/cleanup plus both successful hosted runs above |
| 2: concurrency 3 vs 4 | PENDING | Must measure Linux core and Windows full with runtime resource logs; retain default unless repeatable benefit |
| 3: Windows sharding | CONDITIONAL / NOT STARTED | Requires Batch 2 evidence, complete partition accounting and strict gate proofs |
| 4: Linux sharding | CONDITIONAL / NOT STARTED | Only if still critical and justified by measurements |
| 5: further small improvements | CONDITIONAL / NOT STARTED | Evidence-backed scope only; conservative classifier retained |

PR [#197](https://github.com/egawilldoit/ega-skills/pull/197) is open, with no review decision recorded at report time. Batch 1 is ready for independent review; the overall program must not be reported complete. Rollback for Batch 1 is to revert its four test-file changes. No application data or artifact rollback is involved.

The documentation correction was committed as `533dc54`. Its PR CI passed, but its separate manual full run failed in Linux web startup (Section 14). Batch 1 performance evidence above remains historical evidence for `2c1fb6c`; the subsequent test-harness change requires fresh PR CI and full Linux/Windows validation before merge. No merge is authorized by this follow-up.

## 14. Readiness child startup investigation (2026-11-03)

### 14.1 Failed revalidation and evidence

Manual full run [41531727578](https://github.com/egawilldoit/ega-skills/actions/runs/41531727578), head `533dc5468da276505ec6a3b8ae95cf9ac8b7e123`, failed in [Linux web job 125573438700](https://github.com/egawilldoit/ega-skills/actions/runs/41531727578/job/125573438700). The complete 1,391-line job log was read. `/readyz rejects an artifact path that exists but is a file` exhausted its 20-second poll on port 34220. Web summary: 792 tests, 782 passed, 1 failed, 9 skipped. Both foundation jobs, Windows web, real PostgreSQL isolation and Contract F RLS succeeded; `ci-gate` failed because Linux web failed. Separate PR run 41531681294 succeeded on that SHA; it does not substitute for the failed full run.

**Historical failure mechanism remains unresolved.** The original harness discarded child stderr and did not observe early child failure during polling. Consequently, the log cannot distinguish address-in-use, a bootstrap exception, early termination or resource contention. No competing fixed use of 34220 was found in the web tests, but this does not exclude transient OS port ownership. The invalid-file readiness precondition returns 503 before artifact verification; source inspection did not demonstrate a production defect. The earlier authorization-test 403 → 503 failure is separate and remains unresolved.

Before modification, the original focused suite passed 18/18 locally, and the exact existing concurrent web command passed 792 tests (783 passed, 0 failed, 9 skipped). The previously failing case passed in 663 ms in that full run. Neither local run reproduced the hosted failure.

### 14.2 Test-only correction and regressions

Only `tests/web/console-server.test.mjs` changes behavior. Child stdout is drained; a bounded 8-KiB stderr tail is retained. Diagnostics expose only allowlisted error classes/codes and the fixed listening line; arbitrary exception text, paths, URLs, headers and environment values are redacted. Child `error`, `exit` and `close` events are tracked. An early failure interrupts readiness polling immediately, and the error reports exit code, signal, transport error classification and redacted stderr after reaping the child.

The existing 20-second startup deadline and 100-ms polling interval are preserved. An abortable deadline now also covers fetch and response-body reads. Cleanup waits for `close`, including stdio closure, and reports a cleanup deadline failure instead of silently resolving. Existing Windows temporary-tree cleanup is retained. Ports and production behavior are unchanged because a deterministic collision or production defect was not established.

Four real-child regression cases cover early exit with stdout backpressure and bounded/redacted stderr, nonexistent executable/spawn failure, a stalled response body with abort and reaping, and an intentionally occupied ephemeral port producing `EADDRINUSE`. The last case verifies diagnostics; it does **not** establish the cause of the historical failure. The stalled-body test uses a shorter test-only deadline; real server probes retain 20 seconds.

All original readiness assertions remain: invalid file 503, missing directory 503, committed verified artifact 200, no configured artifact 503, retained manifest alone 503. The four Batch 1 optimized files remain byte-identical to `2c1fb6c`. No production, schema, dependency, workflow, ownership inventory, RLS or security expectation changes are made.

### 14.3 Local verification and current hosted status

Local Node v24.18.0, 2-CPU VM; each measured command ran through `heavy` and `/usr/bin/time -v`. The focused command uses the bounded runner with `--test-reporter=spec tests/web/console-server.test.mjs`; the full command is `node scripts/release/run-tests-bounded.mjs --ci-scope=web`.

| Measurement | Tests | Passed | Failed | Skipped | Command wall | Maximum process RSS |
|---|---:|---:|---:|---:|---:|---:|
| Original focused | 18 | 18 | 0 | 0 | 6.26 s | 171,528 KiB |
| Original full web | 792 | 783 | 0 | 9 | 311.26 s | 1,191,124 KiB |
| Patched focused | 22 | 22 | 0 | 0 | 6.78 s | 172,004 KiB |
| Patched full web | 796 | 787 | 0 | 9 | 325.81 s | 1,169,984 KiB |

The patched full scope passed, including all four unchanged Batch 1 files; the original failing readiness case also passed. CI classifier/gate and ownership tests passed 13/13; ownership discovery remains 189 unique files. All 18 original console-server test names and 58 original assertion lines are retained. The first candidate focused run exposed an initialization-order mistake in the new helper; it was corrected before the successful focused run above. These local measurements include four additional regression tests after the patch, are sequential observations with cache/runner variability, and are not a Batch 1 performance comparison. GNU time reports the largest descendant process RSS, not aggregate concurrent memory.

New-head PR CI and separate manual full Linux/Windows CI are pending. PR #197 must not be labeled ready until both pass on the same new head. Even a successful validation will not prove the historical flake's root cause; if it recurs, the new bounded lifecycle diagnostics should distinguish the failure mechanism without weakening the readiness contract.

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
