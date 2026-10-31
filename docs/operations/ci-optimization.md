# CI optimization baseline

Baseline inspected 2026-10-31 at main `4d7c1d01e0668f424319a4405c2720d87769ec6f`. This is design evidence, not a claim that the proposed replacement is implemented or verified.

## Existing ownership and proposed replacement

| Existing owner | Coverage | Proposed owner and trigger |
| --- | --- | --- |
| CI foundation, Ubuntu and Windows | Frozen install and lockfile, build, committed and staged artifact checks, catalog, typecheck, registry cold-import performance, token vectors, bounded `test:ci`, frozen specs | Full foundation on release PRs, pushes and manual runs on both platforms; Linux on code changes until a narrower mapping is demonstrated. Keep release contexts unchanged. |
| CI web console, Ubuntu and Windows | Domain build, both web typechecks, web build, component and API/integration tests, pinned source proposal tests; Linux also validates baseline and add/update/remove candidate trees | Web and source-manager changes plus full runs; Windows on release/manual runs. Preserve Linux candidate validation and fixture pin. |
| CI web isolation | PostgreSQL 16 cross-workspace isolation, telemetry authorization, pg_cron scheduler and dedicated writer gateway | Database/security or uncertain/shared changes and full runs, unchanged real services. |
| CI contract-f rls | PostgreSQL 16 Contract F, catalog bootstrap and both live membership regressions | Database/security or uncertain/shared changes and full runs; preserve release-required context. |
| Hashing traversal, Ubuntu and Windows | Frozen install/lockfile, build, typecheck, registry performance, two explicit traversal files, bounded full suite, specs and whitespace | Full foundation covers shared checks. Traversal files match Node's default `*.test.mjs` discovery in `test:ci`; prove actual execution before removing duplicate workflow. Retain whitespace check and Windows full coverage. |

Node's default discovery also includes `tests/hashing-enumeration.test.mjs`. The `.rls.mjs` suites are explicitly invoked, not ordinary test discovery. Source-manager tests and candidate validation require their pinned corpus fixture; do not infer that the ordinary suite substitutes for this job. The two explicit traversal invocations currently duplicate files matched by default discovery, but execution equivalence has not yet been demonstrated on a candidate head.

Unknown paths, renames, deletions, missing history, shared packages, root scripts, manifests, dependency/build configuration and workflow changes must select FULL until a complete dependency map proves narrower selection safe. Security, database adapters, telemetry, workspace isolation and SQL require both real database jobs. No recurring schedule is proposed; a schedule would add the sum of its jobs' elapsed runner-minutes per run and needs owner approval.

## Measured starting runs

Job runner-minutes are each job's `completed_at - started_at`, summed even where jobs overlap; latency below is the longest job duration, excluding queue time. One sample per row; variance and confidence limits cannot be estimated from one sample.

| Run | Head | Slowest job | Sum runner-minutes | Result |
| --- | --- | ---: | ---: | --- |
| [PR #183 CI](https://github.com/egawilldoit/ega-skills/actions/runs/41215483740) | `46b68823d036eba34ac8c4ddc33ebf1397b1b68e` | 19.40 min | 43.80 min | success |
| [main hashing](https://github.com/egawilldoit/ega-skills/actions/runs/41217819345) | `4d7c1d01e0668f424319a4405c2720d87769ec6f` | 13.58 min | 21.52 min | success |

The latter is a different run from the earlier 24.4-minute sample in the request. A [source corpus validation run](https://github.com/egawilldoit/skills/actions/runs/40368765379) succeeded; the source repository is read-only for this work.

## Protection and costs

On inspection main ruleset 22345614 had no required status checks; release ruleset 23893800 required `foundation (ubuntu-latest)`, `foundation (windows-2022)`, and `contract-f rls (ubuntu-latest)`. Workflow changes do not change rulesets. After a new `ci-gate` has been observed and verified on a PR, an authorized owner may add that exact context to main protection. Recheck rules before finalizing and preserve the three release contexts until an explicitly approved protection migration.

Blacksmith is not enabled. An owner must install its app scoped to this repository, verify the organization's remaining allowance and confirm whether a hard spending cap exists before any pilot. A 4-vCPU runner consumes two equivalent 2-vCPU minutes per wall minute; alerts alone are not a hard cap. The public GitHub-hosted runner remains the fallback. Roll back a future pilot by switching its runner to GitHub, disabling the manual workflow and optionally removing app access.
