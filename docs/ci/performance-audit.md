# EGA Skills CI/CD performance audit

Status: read-only audit, corrected on 2026-11-02 for the accepted review findings. No workflow, script, test, artifact, or branch-protection change was made for this audit. Every number is either measured in the named run or explicitly labelled as modelled, unmeasured, or not applicable.

Audit context:

- Repository: `egawilldoit/ega-skills` (public).
- Implementation worktree: `/home/ubuntu/.t3/worktrees/ega-skills/perf-ci-speed-reliability`, branch `perf/ci-speed-reliability`, HEAD `e5a3ae793784ff90d9c9f707e1499f4d132650b3`.
- Primary checkout used only as a read-only source: `/home/ubuntu/ega-skills` at `1977c4c` on `fix/release-source-operations`. It was not modified.
- `origin/main` at audit time: `e5a3ae793784ff90d9c9f707e1499f4d132650b3`. Workflow `.github/workflows/ci.yml`, workflow id `349779559`, blob `ffb5071889ab047fecf3156886b56a86b8806154` at that commit.
- Recent measurement window: 24 `CI` runs, 2026-11-01T14:24Z to 22:17Z.
- Monthly window: 282 retained run records, 2026-10-04T10:52:51Z to 2026-11-01T22:11:34Z. The API reported 283 runs; the analysis retained 282.
- Live rulesets were re-read on 2026-11-02 and are recorded in section 8.

## 0. Corrections applied in this revision

| Finding | Previous claim | Corrected position |
|---|---|---|
| Windows runner and concurrency | `windows-2022` had 2 vCPU and Node ran the suite at concurrency 1 | A standard GitHub-hosted public-repository `windows-2022` runner is 4 CPU / 16 GiB. Node 24's documented default with process isolation is `availableParallelism() - 1`, so about 3 is expected, not 1. The workflow does not log CPU count or effective concurrency, so runtime values remain unverified. `pnpm test:perf:registry` is separately pinned to `--test-concurrency=1`. |
| Monthly volume | 84 runs and a rough 1,100–1,300 job-minutes | 283 runs reported by the API, 282 records fetched. The fetched latest-attempt jobs sum to 6,383.7167 job-minutes (1,549 jobs); this is a lower bound because earlier failed attempts are not in the latest-attempt job list. |
| Successful-run aggregation | "17.3 job-minutes/run" used as if a median | Across the 19 successful recent runs the **mean** is 17.278 job-minutes and the **median** is 12.383, total 328.283. |
| Cancelled work | Described as effectively zero | 5 of 24 runs were cancelled, consuming 21.2 job-minutes in the sampled data. |
| Windows share | Presented as a population share | Windows jobs are about 68–71% of job-minutes inside the four Windows-enabled runs. That sample is biased toward Windows-enabled runs and is not a share of all CI work. |
| OOM attribution | A retained SQLite handle was named as the proven cause of exit 137 | Exit 137 proves a kill, not the cause. The artifact loader closes its verifier database in `finally`; the registry keeps reader closers in `openHandles` until `closeRegistry()`. Reused verification CPU/IO and retained readers both need bounded instrumentation before attribution. |
| Rerun latency | One number used for creation-to-green | Run `41353519798` attempt 2 was created at 21:44:09Z, restarted at 22:07:12Z, and its `ci-gate` completed at 22:11:02Z: 26m53s from original creation but 3m50s from the latest attempt start. |
| 503 rerun failure | Suspected test-config reuse | Separate reliability investigation: expected 403, got 503 `E_WEB_READ_UNAVAILABLE` because the local HTTPS mock was unreachable. The deep cause is unconfirmed and is not attributed to the four-file config pattern. |
| Classifier broadening | Proposed `docs/**` and `tests/web/**` narrowing | Unsafe without proof. `docs/**` includes generated `docs/generated/SKILL-CATALOG.md`, whose freshness is checked by `pnpm catalog:check`; `tests/web/**` includes `cross-workspace-isolation.rls.mjs`, a real-PostgreSQL test outside ordinary Node ownership discovery. Do not widen the classifier. |
| Sharding gate design | An aggregator and `ci-gate` friendship were described loosely | `needs` is not transitive. Every mandatory shard/check job must be a direct `ci-gate` dependency. An unconditional aggregator would fail docs-only runs. Web mode still requires foundation. |
| `#41` promotion evidence | "Proven" from ancestry | `verify-release.yml` proves the deployed SHA is contained in `main`; it does not by itself prove the source commit's CI gate passed. The `ci-gate` Vercel deployment check and live verification are separate live-configuration evidence layers. |
| Runner substitution | Blacksmith comparison implied | Blacksmith is deferred. No migration, no unsupported equivalent-unit statistic, and no paid runner. |

## 1. Method

Data sources, in order of weight:

1. GitHub Actions runs and jobs API for the 24-run recent sample, plus a 30-day run list.
2. Per-file test durations parsed from the Node reporter output of the two longest steps in successful runs `41355875171` (Linux web) and `41326881601` (Windows foundation/web). Attribution covered 38/38 web files and 146/151 core files, covering 607 of 624 reported test-seconds.
3. Step timing from the same jobs API (`started_at` to `completed_at`).
4. A local microbenchmark of the `ServerConfig` verification path on the 2-vCPU VM. It is used only for the ratio between fresh and shared configs, never as CI elapsed time.
5. Repository source at `e5a3ae7`, the 24-run sample files, the 30-day summary, and live ruleset read-back.

Attempt-aware rules used here:

- A run has an original `created_at`, a latest-attempt `run_started_at`, and an `updated_at`. Queueing and reruns make the first and second different.
- A job has `created_at`, `started_at`, and `completed_at`. Runner queue is `created_at → started_at`; execution is `started_at → completed_at`.
- `ci-gate` starts only after its dependencies, so its start delay is dependency wait, not runner queue.
- Reruns repeat the same job names. Job-minutes must be summed from actual executions, deduplicated by execution id across attempts, and carried/unchanged jobs from an earlier attempt must not be counted twice. The 30-day figure here is a lower bound built from latest-attempt jobs only.
- Failed and cancelled attempts are excluded from successful-run medians and reported separately.

Caveats:

- Step durations are GitHub's own `completed_at - started_at`; runner provisioning is inside them.
- The recent sample is small and version-mixed. It is descriptive, not a stable p90.
- The 30-day list uses the latest attempt for each run. Earlier failed attempts are missing from its job-minutes, so 6,383.7167 is a floor.
- No workflow logs `os.availableParallelism()`, the resolved CPU count, or the effective `--test-concurrency`. Those values must be instrumented in Batch 2, not inferred from the runner label.
- No committed per-file duration telemetry exists.

## 2. Baseline

### 2.1 Wall clock, recent sample

| Population | n | Latest-attempt start to `ci-gate` median | p90 | Original creation to `ci-gate` median | p90 | Source and availability |
|---|---:|---:|---:|---:|---:|---|
| Successful Linux runs | 15 | 6.00 min | about 6.33 min | 6.083 min | 10.33 min | 24-run API sample; latest attempt; two reruns drive the creation-to-gate tail (10.33 min and 26.88 min). Small, version-mixed sample. |
| Successful Windows-enabled runs | 4 | 17.6 min | 19.2 min | 17.6 min | 19.2 min | Four observations only. Mixed workflow versions. Descriptive, not a production p90. |

Job-minutes across the same 19 successful runs: mean 17.278, median 12.383, total 328.283. That is a different measure from wall latency.

The earlier claim that all successful runs had a 6.1-minute median mixed Linux and Windows populations. The two populations are reported separately above.

### 2.2 Cancelled work

Five of 24 sampled runs were cancelled (all ordinary pull-request runs superseded by the concurrency group; no release-target run was cancelled). Their executed job time was 21.2 job-minutes. That is wasted work and is reported separately from successful-run medians.

### 2.3 Job durations in successful runs

| Job | n | Median | p90 | Source |
|---|---:|---:|---:|---|
| `web console (ubuntu-latest)` | 19 | 5.7 min | 5.9 min | 24-run sample |
| `foundation (ubuntu-latest)` | 19 | 4.3 min | 4.5 min | 24-run sample |
| `web isolation (real PostgreSQL 16)` | 19 | 1.0 min | 1.1 min | 24-run sample |
| `contract-f rls (ubuntu-latest)` | 19 | 1.0 min | 1.0 min | 24-run sample |
| `docs` | 19 | 0.1 min | 0.1 min | 24-run sample |
| `classify` | 19 | 0.1 min | 0.1 min | 24-run sample |
| `ci-gate` | 19 | 0.1 min | 0.1 min | 24-run sample |
| `foundation (windows-2022)` | 4 | 17.2 min | 18.9 min | Four Windows-enabled runs; mixed workflow versions |
| `web console (windows-2022)` | 4 | 10.1 min | 11.8 min | Four Windows-enabled runs; mixed workflow versions |

### 2.4 Step durations

Ubuntu push run `41355875171`, head `e5a3ae7`, 7 jobs, wall 6.13 min, 12.65 job-minutes:

| Job | Step | Duration |
|---|---|---:|
| web console | Web API and integration tests | 5.27 min |
| foundation | Test (`--ci-scope=core`) | 4.10 min |
| web isolation | Initialize containers | 0.37 min |
| web isolation | Cross-workspace isolation (real PostgreSQL 16) | 0.20 min |
| web console | Validate proposed source fixture trees (Python) | 0.20 min |
| web console | Install from frozen lockfile | 0.08 min |
| web console | Web component behaviour (Vitest) | 0.07 min |
| web isolation | Dedicated writer through isolated REST gateway | 0.12 min |
| all other steps | checkout, Node, corepack, build, typecheck, catalog, specs, perf, tokens | at most 0.05 min each |

Windows-enabled run `41326881601`, PR head `787f1f4`, 9 jobs, wall 18.53 min, 38.88 job-minutes:

| Job | Step | Duration |
|---|---|---:|
| foundation (windows-2022) | Test (unscoped `pnpm test:ci`, 189 discovered files) | 16.13 min |
| foundation (windows-2022) | Install from frozen lockfile | 1.17 min |
| web console (windows-2022) | Web API and integration tests | 6.80 min |
| web console (windows-2022) | Install from frozen lockfile | 1.00 min |
| foundation (ubuntu-latest) | Test (`--ci-scope=core`) | 4.07 min |
| web console (ubuntu-latest) | Web API and integration tests | 5.07 min |

The Windows test step (967 s) is the release-path binding step in this run. It is a single observation, and the Windows-enabled runs mix workflow versions.

### 2.5 Work inside the two long Linux steps

Parsed from one successful run's reporter output. Files run concurrently, so the sum of file times exceeds the step wall.

Web suite: 316 s step, 464 s of attributed test time, process concurrency expected about 3 from the Node default; not logged:

| File | Test time | Share |
|---|---:|---:|
| `tests/web/skills.test.mjs` | 247.4 s | 53% |
| `tests/web/catalog.test.mjs` | 94.1 s | 20% |
| `tests/web/api-routes.test.mjs` | 52.5 s | 11% |
| 35 remaining files | 70.4 s | 15% |

Core suite: 246 s step, 624 s of attributed test time, process concurrency expected about 3 from the Node default; not logged:

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

Four files carry about 42% of core test time. This is one run's attribution, not a stable distribution.

### 2.6 Queue, setup and cache

| Signal | Measured value | Source |
|---|---|---|
| Runner queue (`job.created_at → started_at`) | median about 2 s, max 3 s | 24-run sample |
| Run creation to run start | 0 s in 22 of 24 runs; 4.5 min in one; 23.1 min on a rerun | 24-run sample |
| Checkout | 0.02–0.05 min | Step data |
| `actions/setup-node` | about 0.02 min | Step data |
| `pnpm install --frozen-lockfile` (Linux) | 0.08 min | Run `41355875171` |
| `pnpm install --frozen-lockfile` (Windows) | 1.0–1.2 min | Windows-enabled runs |
| `pnpm build` (`tsc -b`, TypeScript 7) | about 0.02 min | Step data |
| pnpm store or node_modules cache | none configured | `ci.yml` |
| `actions/cache` | not used | Both workflows |

### 2.7 30-day volume

| Signal | Value | Availability |
|---|---:|---|
| Runs reported by the API | 283 | One analysis fetched 282 records |
| Fetched records | 282 | 2026-10-04T10:52:51Z to 2026-11-01T22:11:34Z |
| Success / cancelled / failure | 210 / 8 / 64 | Fetched records |
| Jobs in fetched latest attempts | 1,549 | Fetched records |
| Latest-attempt job-minutes | 6,383.7167 | Lower bound; earlier failed attempts are missing |
| Windows-enabled runs | 244 of 282 | The sample is dominated by Windows-enabled runs |
| Windows jobs' share inside the four recent Windows-enabled runs | about 68–71% | Biased Windows-enabled sample, not a population share |

The total includes successful, failed and cancelled latest attempts. It should not be read as billable runner cost or as a monthly forecast.

## 3. Critical path

Full mode on a pull request or push to `main`, from run `41355875171`:

```text
classify            6 s
├─ docs             5 s
├─ web            350 s   <- critical path
│   └─ test step  316 s
│       └─ skills.test.mjs 247 s
├─ foundation     267 s
│   └─ test step  246 s
├─ web-isolation   65 s
└─ rls             60 s
ci-gate             6 s
────────────────────────
wall              366 s  (6.13 min)
```

Windows-enabled release-path shape, from run `41326881601`:

```text
classify 7 s -> foundation (windows) 1090 s -> ci-gate 10 s
                web console (windows) 504 s
                foundation (ubuntu) 262 s
                rls 52 s / isolation 63 s
wall about 1112 s (18.53 min), bound by Windows foundation
```

Dependency shape is already concurrent: heavy jobs start within about 2 s of each other. The wall clock is not caused by ordering, queueing, setup, or caching. It is caused by two long test steps and the Windows leg.

## 4. Root causes

### R1. Web tests rebuild the verified release snapshot on every call

`getSkillDetail` and `getSkillContent` memoize the verified identity on the identity of the `ServerConfig` object:

- `parseServerConfig` returns `Object.freeze(...)` (`apps/web/server/env.ts:203-273`).
- `getReleaseIdentityBinding` caches on a `WeakMap` keyed by that object (`apps/web/server/release-identity.ts:448-474`).
- `getRegistry` caches a reader on `readersByConfig`, also keyed by the config object (`apps/web/server/registry.ts:547-585`).
- Every reader closer is retained in `openHandles` until `closeRegistry()` (`registry.ts:564`, `registry.ts:612-617`). A reader's own `close` removes it from that set (`registry.ts:341-347`).
- The artifact loader opens the verifier SQLite database read-only and closes it in `finally` (`packages/mcp/src/hosted.ts:193-221`). That verifier database is not the retained handle.

The four web test files construct a new config on nearly every call: `tests/web/skills.test.mjs` has about 40 `committedConfig()` call sites (helper at lines 118-120, loops at 402, 577, 1189), `catalog.test.mjs` about 34 (helper and `fullCatalog()` at 83-89, loops at 615, 632, 668, 701-702), `releases.test.mjs` about 17 (helper at 107-108), and `category-browse.test.mjs` about 7 (helper and `fullCatalog()` at 65-70). Each distinct config misses the memo and reloads and re-verifies the artifact.

Local measurement (2-vCPU VM, warm cache, 8 skills) is indicative only:

| Pattern | Time | Per call |
|---|---:|---:|
| Fresh `committedConfig()` per call | 7,145 ms | 893 ms |
| One shared config | 1,931 ms | 241 ms |

A 126-skill local loop with fresh configs was OOM-killed at a 700 MiB cap. Exit 137 proves a kill; it does not prove which resource caused it. The ratio and the retained-reader mechanism make the test-side repetition the leading hypothesis, not a proven root cause until Batch 1 instruments config and reader counts.

### R2. `skills.test.mjs` is an indivisible web file

Node runs one process per test file, and tests inside a file run sequentially. A web shard that contains `skills.test.mjs` still pays its 247 s. Sharding the web suite before R1 is fixed cannot shorten the critical path.

### R3. The core suite is work-bound

Two golden-router files (about 192 s combined) are intentional x10 determinism and scenario runs; `provenance-disclosure` builds real fixtures. The step is work-bound. More concurrency or splitting files across jobs are the only levers that shorten it without cutting coverage.

### R4. Windows concurrency is unverified, not known to be 1

A standard GitHub-hosted public-repository `windows-2022` runner is 4 CPU / 16 GiB. Node 24's documented default with process isolation is `availableParallelism() - 1`, so about 3 is expected. The workflow does not set `--test-concurrency`, and it does not log `os.availableParallelism()`, the resolved CPU count, or the effective concurrency. The 967 s test step is therefore consistent with a work-bound suite at an unknown concurrency; it is not evidence of serial execution.

`pnpm test:perf:registry` is explicitly `node --test --test-concurrency=1 tests/performance/registry-cold-import.perf.mjs` and is a separate step. Do not change that value in a general concurrency experiment.

### R5. Windows foundation deliberately duplicates the Windows web suite

`foundation (windows-2022)` runs unscoped `pnpm test:ci` (all 189 discovered files, `ci.yml:123`), and `web console (windows-2022)` runs the 38 web files again (`ci.yml:192`). `docs/operations/ci-optimization.md` documents this as deliberate release-time overlap. It costs several minutes of the release path; it is not a silent defect to remove.

### R6. The classifier is intentionally narrow, and broadening it is unsafe

`classify-changes.mjs:24-31` returns `full` for any added, deleted, renamed, or larger-than-300-file diff, and only `README.md` plus four display components are allowlisted. Of 31 recently merged PRs sampled for the original audit, 31 selected `full`.

Two obvious broadenings are unsafe:

- `docs/**` includes `docs/generated/SKILL-CATALOG.md`. `pnpm catalog:check` in the foundation job proves the generated catalog is fresh. A `docs`-only run would skip that check and could merge a stale generated catalog.
- `tests/web/**` includes `tests/web/cross-workspace-isolation.rls.mjs`. `.rls.mjs` is not covered by the ordinary Node test-ownership pattern (`scripts/ci/ownership.mjs:4`); that test runs only in the separate real-PostgreSQL `web-isolation` job. A `web`-only classification would skip it.

Do not widen the classifier without a proof that every affected gate still runs. The current narrow behavior is a deliberate safety tradeoff, not a bug to fix as part of a speed batch.

### R7. Setup and caching are not the Linux bottleneck

Every heavy Linux job installs in about 5 s and builds in about 1 s. A cache restore would cost more than it saves. The only setup item worth evaluating later is the 60–70 s Windows install, and only after the concurrency and sharding measurements.

## 5. Why sharding alone is not the first fix

Greedy LPT simulation using one run's measured per-file times, three lanes per job, and 16 s setup per job. This is a model, not a CI after-measurement:

| Configuration | Test wall | Job wall |
|---|---:|---:|
| web, 1 job (today) | 247 s | 263 s |
| web, 2 shards (today) | 247 s | 263 s |
| web, 3 shards (today) | 247 s | 263 s |
| web, 1 job after R1 fix | 80 s | 96 s |
| core, 1 job (today) | 209 s | 225 s |
| core, 2 shards | 105 s | 121 s |
| core, 3 shards | 102 s | 118 s |
| core, 4 shards | 102 s | 118 s |

Core sharding saturates at two shards because `determinism.test.mjs` is about 102 s and indivisible. Web sharding is worthless until R1 is fixed. These are modelled inputs from one run, not a promise.

## 6. Complete 43-technique assessment

Status labels: **ALREADY IMPLEMENTED**, **IMPROVE**, **MISSING**, **NOT APPLICABLE**, **UNSAFE**, **NEEDS EVIDENCE**.

"Runner impact" is the modelled or observed change in summed job-minutes. "Unmeasured" means there is no CI measurement; it is not a forecast.

### Smart execution (1–9)

| # | Technique | Status | Existing implementation and evidence | Applicability and expected effect | Runner impact | Risk / effort | Verification |
|---|---|---|---|---|---|---|---|
| 1 | Change detection | IMPROVE | `classify` job and `scripts/ci/classify-changes.mjs:24-31,52-66`; no `paths:` filter. 31/31 sampled merged PRs selected `full`. | Mechanism works; effectiveness is near zero on the sampled corpus. No safe broadening is proven: `docs/**` can hide generated-catalog freshness and `tests/web/**` can hide `.rls.mjs` real-PostgreSQL tests. Leave narrow until equivalence is proven. Unmeasured. | 0 today | Low risk if unchanged; high if widened | `tests/ci/classify-changes.test.mjs`; replay the 31-PR corpus |
| 2 | Dependency-aware filtering | MISSING | Only a two-way core/web split (`scripts/ci/test-ownership.json`); no package-to-test graph. `tests/mcp/hosted-invocation.test.mjs` imports `apps/web/server`. | Could skip unaffected packages, but tests cross package boundaries. Gain unmeasured; coverage risk high. | Unknown | High risk; high effort | A validated ownership graph plus mutation testing |
| 3 | Conditional jobs | ALREADY IMPLEMENTED | `needs: classify` plus `if:` at `ci.yml:40,62,130,270,351`. | Correct. Heavy jobs start within about 2 s of each other. | 0 | None | Job start timestamps (section 2.6) |
| 4 | Exact affected-package test filtering | MISSING | `--ci-scope=core` / `--ci-scope=web` (`scripts/release/run-tests-bounded.mjs:176-179`) is the only filter. | Same tradeoff as #2. Not justified before the config and concurrency batches. Unmeasured. | Unknown | High risk | Ownership proof plus mutation tests |
| 5 | Ignore truly irrelevant files | IMPROVE | `classify-changes.mjs:28` accepts only `README.md`; `:29` accepts four display components. `docs/**` selects `full`. | The allowlist is intentionally narrow. `docs/**` cannot be narrowed to docs-only while `docs/generated/SKILL-CATALOG.md` freshness is a foundation gate. No safe extension identified. Unmeasured. | 0 today | Low risk only if unchanged | Classifier units plus a docs-only PR with `catalog:check` proof |
| 6 | Skip platform jobs when unaffected | ALREADY IMPLEMENTED | Windows matrix only for `workflow_dispatch`, `release/2.0` PR, and `release/2.0` push (`ci.yml:69,137`). | Correct. Routine PRs and pushes never pay Windows. | 0 | None | Matrix values in run data |
| 7 | Independent early filtering for expensive shards | ALREADY IMPLEMENTED | Every job starts only after `classify` (`ci.yml:40,61,129,269,350`). | Correct. The prefix costs about 6 s total; inlining would cost about 2 s per job. Do not change. | 0 | None | Job start timestamps |
| 8 | Cancel outdated PR runs, protect release branches | ALREADY IMPLEMENTED | `ci.yml:11-13`; release-target PRs use `run_id` and are not cancelled. | Correct. 5 of 24 sampled runs were cancelled; no release run was cancelled. | Wasted work reported separately: 21.2 job-min | None | Concurrency behaviour in the run list |
| 9 | Release concurrency and duplicate builds | ALREADY IMPLEMENTED | `verify-release.yml:23-25` uses `cancel-in-progress: false`. A merge produces a PR run and a push run of the same content by design. | The push run is the deployment gate. Deduplicating by SHA would need validated-commit evidence and risks deploying an unverified SHA. Leave as is. | 0 | Medium risk if changed | Compare merge SHA with the push run |

### Parallelism (10–19)

| # | Technique | Status | Existing implementation and evidence | Applicability and expected effect | Runner impact | Risk / effort | Verification |
|---|---|---|---|---|---|---|---|
| 10 | Independent concurrent CI jobs | ALREADY IMPLEMENTED | Six independent jobs behind `classify` (`ci.yml:39-435`); wall is the maximum, not the sum. | Correct. | 0 | None | Section 2.4 |
| 11 | Dedicated heavy web-test job | ALREADY IMPLEMENTED | `web` is already a dedicated job (`ci.yml:128-266`); it mixes about 33 s of build/typecheck/Vitest with the long test step. | Splitting checks from tests would add setup and a dependency edge. Not justified before Batch 1 reduces the test step. Unmeasured. | +setup if split | Low effort | Step timings before and after |
| 12 | Server/integration-test sharding | MISSING | One `node --test` invocation per scope (`run-tests-bounded.mjs:175-191`). | Potentially useful for core and Windows after B1/B2, with full parity and strict gates. Effect unmeasured. | +one setup per shard | Medium effort; gate and required-name risk | Measured shard walls plus completeness proof |
| 13 | Duration-weighted sharding | MISSING | No weights; file lists are alphabetical from the ownership manifest. | Needed for balanced shards if native sharding proves unbalanced. Do not add a weight file until native partition identity is measured. Unmeasured. | 0 | Low–medium | Simulated and measured balance |
| 14 | Parallel independent package tests | MISSING | Core is one invocation of 151 files. | Same as #12; a package-level split adds risk without proven extra speed. Unmeasured. | Unknown | High effort | Package-level ownership proof |
| 15 | Remove unnecessary dependency ordering | ALREADY IMPLEMENTED | Only `classify` is a prefix; no job-to-job chain among heavy jobs. | Correct. | 0 | None | `needs:` graph |
| 16 | Overlap typecheck and build | NOT APPLICABLE | `pnpm build` and `pnpm typecheck` each take about 1 s with TypeScript 7 (`ci.yml:98-99,113-114`). | No measurable gain. | 0 | None | Step durations |
| 17 | Overlap independent setup steps | NOT APPLICABLE | Checkout about 2 s, Node about 1 s, corepack under 1 s, install about 5 s. | No measurable gain. | 0 | None | Step durations |
| 18 | Parallel platform/release packaging | NOT APPLICABLE | Packaging is Vercel's; CI builds no deployable archive. | — | 0 | None | `verify-release.yml` |
| 19 | CPU- and memory-aware concurrency | IMPROVE | No `--test-concurrency` in the workflow. Node 24 default is `availableParallelism() - 1`; a public 4-CPU runner should resolve to about 3. Runtime CPU and effective concurrency are not logged. `pnpm test:perf:registry` is explicitly 1 (`package.json`). | Measure 3 versus 4 only after Batch 1, on Linux core and Windows full, with web unchanged and registry performance pinned at 1. Effect unmeasured. | 0 direct | Low effort; medium flake risk | Batch 2 instrumented A/B on the same SHA |

### Caching (20–30)

| # | Technique | Status | Existing implementation and evidence | Applicability and expected effect | Runner impact | Risk / effort | Verification |
|---|---|---|---|---|---|---|---|
| 20 | Node/package-manager/toolchain caching | IMPROVE | No `actions/cache`, no `cache:` in `actions/setup-node` (`ci.yml:79-82,143-146,299-302,378-381`). | Linux install is about 5 s, so a restore costs more than it saves. A Windows pnpm-store cache is the only candidate, and only if Batch 2 leaves setup above about 30 s. Effect unmeasured. | Unknown; restore/save overhead must be measured | Medium effort | Cache hit rate and install step time |
| 21 | Version-specific cache keys | NOT APPLICABLE | No cache exists. | Required only if #20 is added: key on OS plus `pnpm-lock.yaml` hash. | 0 | None | — |
| 22 | Package-store caching | IMPROVE | Same as #20; `.pnpm-store/` is gitignored and nothing persists between jobs. | Windows only, and only after concurrency and shard measurements. Effect unmeasured. | Unknown; same experiment as #20 | Medium | Store size and restore time |
| 23 | Filtered-install cache reuse | NOT APPLICABLE | No filtered installs; the workspace install is whole-repo and about 5 s. | — | 0 | None | — |
| 24 | Lockfile verification caching | NOT APPLICABLE | `git diff --exit-code -- pnpm-lock.yaml` is 0.00 min (`ci.yml:95-96,154-155`). | — | 0 | None | — |
| 25 | Remote task-result caching | MISSING | None. | `tsc -b` is about 1 s and tests must run. No payoff. Do not add. | 0 | Low | — |
| 26 | Safe per-test result caching | UNSAFE | None, correctly. | Reusing results across commits can hide regressions in shared fixtures and generated catalogs. Do not add. | 0 | High risk | Mutation test would be required |
| 27 | Electron download caching | NOT APPLICABLE | No Electron dependency. | — | 0 | None | `package.json` |
| 28 | Playwright/browser caching | NOT APPLICABLE | Component tests use Vitest and jsdom (`vitest.components.config.mts`); no browsers. | — | 0 | None | Config |
| 29 | Conditional native/system-dependency installation | ALREADY IMPLEMENTED | `pip install` only in the full-mode web job (`ci.yml:233`); `apt-get install postgresql-16-cron` only in the real-PostgreSQL job (`ci.yml:330-337`). | Already conditioned. Pre-baking is unavailable on hosted runners; a cache benefit is unmeasured. | Unknown | Low | Step times |
| 30 | Cached-result verification | NOT APPLICABLE | No cached results. | Would be required if #25 or #26 were introduced. | 0 | None | — |

### Runner and checkout (31–35)

| # | Technique | Status | Existing implementation and evidence | Applicability and expected effect | Runner impact | Risk / effort | Verification |
|---|---|---|---|---|---|---|---|
| 31 | Blacksmith runner comparison | NEEDS EVIDENCE | No Blacksmith usage: every sampled job reports a GitHub Actions runner and the `ubuntu-latest` or `windows-2022` label. The org is `egawilldoit`, so eligibility is possible, but quota and installation are not readable with the current token. | Deferred. Standard public-repo GitHub-hosted runners are free here; Windows Server 2025 beta is not equivalent to `windows-2022`. No equivalent-unit statistic is claimed. | 0 | Medium risk; medium effort | A capped A/B only if an owner reopens the decision |
| 32 | Runner CPU/memory right-sizing | NEEDS EVIDENCE | Standard public-repo `ubuntu-latest` and `windows-2022` are documented as 4 CPU / 16 GiB. The jobs do not log runtime CPU count or memory. No larger runners are configured. | Sizing appears correct from the published specification, but runtime evidence is absent. No paid larger runner. | 0 | Low | Batch 2 must log `os.availableParallelism()`, total memory, and effective concurrency |
| 33 | Sparse checkout | NOT APPLICABLE | Repository is about 10.8 MB; checkout is 2–3 s (`ci.yml:76-77`). | The artifact is needed by tests. Sparse checkout would save under 1 s and risk missing fixtures. | 0 | None | Checkout step time |
| 34 | Minimal change-detector checkout | NOT APPLICABLE | `classify` uses `fetch-depth: 0` (`ci.yml:25-27`) and needs `merge-base`; costs about 2 s. | — | 0 | None | `classify` duration |
| 35 | Avoid unused toolchain installation | ALREADY IMPLEMENTED | Every job that installs Node uses it; `Enable Corepack` precedes pnpm use. | — | 0 | None | Job step list |

### Local developer feedback (36–39)

| # | Technique | Status | Existing implementation and evidence | Applicability and expected effect | Runner impact | Risk / effort | Verification |
|---|---|---|---|---|---|---|---|
| 36 | Changed-file local validation | MISSING | `scripts/ci/classify-changes.mjs` is CI-only; there is no developer entry point. | Does not change CI wall clock; could stop obviously doomed pushes. The VM `heavy --dedupe` wrapper is outside the repository. Effect unmeasured. | 0 to unknown | Low | Run against a synthetic diff |
| 37 | Targeted test commands | ALREADY IMPLEMENTED | `--ci-scope=core` and `--ci-scope=web` (`run-tests-bounded.mjs:176-179`, `package.json`). | Correct; used by CI and available locally. | 0 | None | — |
| 38 | Local successful-check reuse | MISSING | No success cache in the repository; `heavy --dedupe` only coalesces identical read-only checks. | Developer latency only. | 0 | Low | — |
| 39 | Incremental/cached TypeScript checking | NEEDS EVIDENCE | Fresh checkouts have no `*.tsbuildinfo` (gitignored); `tsc -b --force` costs about 1 s. | Removing `--force` changes nothing on a cold checkout. No measured benefit; keep `--force` for correctness unless evidence appears. | 0 | Low | Build timing on a cold checkout |

### Release (40–43)

| # | Technique | Status | Existing implementation and evidence | Applicability and expected effect | Runner impact | Risk / effort | Verification |
|---|---|---|---|---|---|---|---|
| 40 | Build shared release outputs once | NOT APPLICABLE | Every job runs `pnpm build` separately (`ci.yml:98,161,311,389`); each is about 1 s. | Sharing would add upload/download and a dependency edge for about 1 s saved. Not applicable. | +0.1 if added | Low | — |
| 41 | Promote an exact previously validated commit | NEEDS EVIDENCE | `verify-release.yml:72-91` proves only that the deployed SHA is contained in `main` (`compare` status `ahead` or `identical`). `verify-live.mjs:411-444` and `:714-774` check the Vercel deployment check named `ci-gate` and the live release. | Ancestry, source-commit CI status, and live configuration are separate evidence layers. The current workflow does not prove the source commit's CI gate passed from the source side; the deployment check is live evidence. Do not conflate them. | 0 | Medium risk | Source-side gate lookup plus deployment-check evidence |
| 42 | Filter release dependencies by job | NOT APPLICABLE | The verify job installs nothing and uses only Node plus local scripts (`verify-release.yml:39-49`). | — | 0 | None | Step list |
| 43 | Skip scheduled releases when unnecessary | NOT APPLICABLE | No `schedule:` trigger in either workflow; releases are Vercel Git builds on `main`. | — | 0 | None | Workflow triggers |

## 7. Reliability investigation: run `41353519798`

This is a separate investigation, not evidence about the four-file config pattern.

- Run `41353519798`, attempt 1 (`fix/release-source-operations`), started 2026-11-01T21:44:09Z.
- Job `124989342509`, `web console (ubuntu-latest)`, ran 21:47:10Z to 22:06:43Z and failed at step `Web API and integration tests`.
- The failing test was `tests/web/ega-719-artifact-release-authorization.test.mjs:209`, "EGA-719: caller that cannot read the release is denied (403)".
- The assertion received HTTP 503, not 403:

  ```text
  AssertionError: {"error":{"code":"E_WEB_READ_UNAVAILABLE","message":"Control-plane data is unavailable: The control-plane read endpoint could not be reached"}}
  503 !== 403
  ```

- The message comes from `apps/web/server/supabase-read.ts:1146`; the session-endpoint variant is at `:1098`.
- The test starts a local HTTPS mock on `127.0.0.1:34974` (`tests/web/ega-719-artifact-release-authorization.test.mjs:23-66`) and launches the BFF child against it. The proximate failure is that the local mock was unreachable from the BFF during the assertion. The deep cause is unconfirmed.
- The failed attempt's web suite reported `duration_ms` 1,092,534 (about 18.2 min), 792 tests, 782 pass, 1 fail, 9 skipped. It is excluded from successful-run performance medians.
- Attempt 2 succeeded. The run was created at 21:44:09Z, restarted at 22:07:12Z, and its `ci-gate` completed at 22:11:02Z: 26m53s original creation to green, 3m50s latest attempt to green.

Log retrieval note: `gh run view` for an old job can return the latest attempt, not the failed attempt. The failed-attempt evidence above was read with:

```sh
gh api repos/egawilldoit/ega-skills/actions/jobs/124989342509/logs \
  --allow-escape-sequences |
  sed -e 's/\x1b\[[0-9;]*m//g'
```

The run-attempt archive also works: `gh api repos/egawilldoit/ega-skills/actions/runs/41353519798/attempts/1/logs`.

Required follow-up, outside Batch 0: isolate why the local mock was unreachable (port reuse, listener lifetime, TLS handshake, or runner resource pressure) with a bounded reproduction. Do not waive the authorization test.

## 8. Rulesets, gates, and classifier contracts verified 2026-11-02

Live read-back:

```sh
gh api repos/egawilldoit/ega-skills/rulesets
gh api repos/egawilldoit/ega-skills/rulesets/23893800
gh api repos/egawilldoit/ega-skills/rulesets/22345614
```

| Ruleset | ID | Target | Required status checks | Notes |
|---|---:|---|---|---|
| `release-2.0-protection` | 23893800 | `refs/heads/release/2.0` | `foundation (ubuntu-latest)`, `foundation (windows-2022)`, `contract-f rls (ubuntu-latest)` | Strict required-status-checks policy is true. Exactly these three contexts. Pull-request rule, deletion and non-fast-forward protection. |
| `main-protection` | 22345614 | `refs/heads/main` | none | Pull-request rule, deletion and non-fast-forward protection. No required status checks at read time. |

`ci-gate` is a workflow job with the exact name `ci-gate` (`ci.yml:420-435`). It is separate from the ruleset required contexts. It is also consumed as a Vercel deployment check (`externalCheckName` `ci-gate`, `scripts/release/verify-live.mjs:411-444`). Preserve both layers; do not treat a green `ci-gate` as a substitute for the three release contexts, and do not treat the three contexts as a substitute for the deployment check.

Workflow contract at `e5a3ae7`:

- `ci-gate.needs` is `[classify, docs, foundation, web, web-isolation, rls]` (`ci.yml:423`) and `check-gate.mjs` normalizes `web-isolation` to the gate key `isolation` (`check-gate.mjs:11-13`).
- `gate()` requires exactly the six keys and rejects missing or extra keys, malformed results, and non-success results for selected jobs (`classify-changes.mjs:36-49`).
- Modes: `docs` = classify and docs; `web` = classify, docs, foundation, web; `full` = all six (`classify-changes.mjs:36-41`). Web mode still runs foundation.
- The classifier is closed: only README selects docs; only README plus four display components selects web; everything else selects full. There is no `paths:` filter. Do not widen without equivalence proof.

Coverage at this commit:

- Default Node discovery: 189 files, split 151 core and 38 web in `scripts/ci/test-ownership.json`.
- `.rls.mjs` files are outside that discovery. Eight exist: `tests/web/cross-workspace-isolation.rls.mjs`, `tests/rls/contract-f.rls.mjs`, `tests/rls/catalog-bootstrap.rls.mjs`, `tests/rls/hosted-live-membership.rls.mjs`, `tests/rls/hosted-skill-scoped-live-membership.rls.mjs`, `tests/rls/telemetry-authz.rls.mjs`, `tests/rls/telemetry-scheduler.rls.mjs`, and `tests/rls/telemetry-gateway.rls.mjs`. They run under `web-isolation` and `rls` (`ci.yml:313-345,392-413`), not under `--ci-scope=web`.
- Windows foundation keeps the unscoped `pnpm test:ci` (189 files), including the deliberate web overlap.

## 9. Additional problems discovered

1. **Test-side snapshot repetition.** Four web files recreate the default frozen config in hot loops, defeating the identity-keyed memo and opening a reader per distinct config. Retained readers live in `openHandles` until `closeRegistry()`. This may increase resource pressure as the catalog grows; a resulting CI flake has not been proven.
2. **Exit 137 is not attribution.** A local OOM kill does not prove which allocation or retained handle caused it. Batch 1 should count configs and readers and measure RSS with a bounded probe.
3. **Dead classification modes on the sampled corpus.** 0 of the 19 successful sampled runs used `docs` or `web`. The allowlist is narrower than actual change patterns, but the obvious broadenings are unsafe (section R6).
4. **Duplicated Windows web coverage.** `foundation (windows-2022)` runs all 189 files, including the 38 web files the other Windows job runs. Documented as deliberate; flagged, not changed.
5. **The two PostgreSQL jobs duplicate installs.** `web-isolation` and `rls` each install and build and each start a container. They are about 1 min each and off the critical path; merging them would add wall.
6. **No timing telemetry.** There is no committed per-file duration or effective-concurrency record. Any shard or concurrency design needs a fail-closed measurement inventory, not a guessed weight table.
7. **Windows install remains the only caching candidate.** A store cache would need to preserve the `git diff --exit-code -- pnpm-lock.yaml` guard and the native-module integrity proof.
8. **Runner specifications are published, not logged.** The audit's CPU statement is the GitHub standard-runner specification; the workflow does not record runtime CPU count. Batch 2 must log it.

## 10. Threats to validity

- One Linux and one Windows run supplied the per-file breakdown; another day's runner image or CPU contention can shift absolute numbers by an unmeasured amount.
- The local microbenchmark ran on 2 vCPU with a warm page cache and is used only for the fresh-versus-shared ratio, not for absolute CI time.
- The 31-PR classifier replay uses PR file lists, not the exact `merge-base` diff. Added and deleted status was preserved.
- The recent sample is small and version-mixed. The four Windows-enabled runs are not a stable p90.
- The 30-day total is a lower bound from latest attempts. Earlier failed attempts and cancelled job records are incomplete.
- No post-change improvement has been measured. The Batch 1 and later figures in the plan are expectations to be replaced by hosted evidence.
- Blacksmith eligibility and quota were not readable with the current token. No decision depends on them.

## 11. Headline

The expensive part of this pipeline is not the runner, the cache, or the workflow graph. Two test files construct fresh release snapshots in hot loops, and the Windows leg runs a 189-file suite at an unlogged effective concurrency. Fixing the snapshot pattern is a test-only change that can remove repeated verification; measuring 3 versus 4 uses the runner that is already provided; sharding is conditional on those measurements. Runner substitution and classifier widening are not part of this program.

## Source references

- Workflow: `.github/workflows/ci.yml` (workflow id `349779559`, blob `ffb5071889ab047fecf3156886b56a86b8806154` at `e5a3ae7`).
- Gate and classifier: `scripts/ci/classify-changes.mjs`, `scripts/ci/check-gate.mjs`, `scripts/ci/ownership.mjs`, `scripts/ci/test-ownership.json`.
- Bounded runner: `scripts/release/run-tests-bounded.mjs`.
- Web tests: `tests/web/skills.test.mjs`, `tests/web/catalog.test.mjs`, `tests/web/releases.test.mjs`, `tests/web/category-browse.test.mjs`.
- Config, registry, identity, loader: `apps/web/server/env.ts`, `apps/web/server/registry.ts`, `apps/web/server/release-identity.ts`, `packages/mcp/src/hosted.ts`.
- Reliability case: `tests/web/ega-719-artifact-release-authorization.test.mjs`, `apps/web/server/supabase-read.ts`.
- Release verification: `.github/workflows/verify-release.yml`, `scripts/release/verify-live.mjs`.
- Operations note: `docs/operations/ci-optimization.md`.
- Run IDs: `41355875171` (Linux push, head `e5a3ae7`), `41353519798` (rerun and failed attempt `124989342509`), `41326881601` (Windows-enabled), `41320045429`, `41318250172`, `41317115302` (other Windows-enabled), `41329224949` (rerun queueing), `41353348511` (cancelled).
- Local analysis retention (not committed): `/tmp/opencode/ci-runs.json` (24-run sample), `/tmp/opencode/ci-30d.json` (282-record summary), `/tmp/opencode/run-a1-logs/` (run `41353519798` attempt 1 logs).
