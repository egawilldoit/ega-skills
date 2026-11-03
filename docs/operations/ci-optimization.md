# CI ownership and operations

The authoritative workflow is [ci.yml](../../.github/workflows/ci.yml). For
release and deployment, use [RELEASE-2.0-RUNBOOK.md](RELEASE-2.0-RUNBOOK.md)
and [web-console-production-promotion.md](web-console-production-promotion.md).

## Workflow and selection

`classify` selects `docs`, foundation, web, web-isolation and RLS as applicable;
`ci-gate` checks that every selected job succeeded. These jobs run concurrently:
feedback latency follows the longest required path, not the sum of job times.
The workflow has no top-level paths filter. Superseded non-release PR runs cancel;
release runs are not cancelled by this mechanism.

Only a modified README selects docs. Modifications limited to README and the
existing allowlisted StatCard, Icon, Disclosure and format components select web.
All other changes, uncertainty, renames, deletions or missing history select full.
Release PRs, pushes and manual runs select full. Pull request workflows normally
checkout GitHub's synthetic merge ref; record both that checkout SHA and the PR
head SHA when reporting evidence.

Full Linux runs foundation, web, real PostgreSQL 16 isolation and Contract F RLS,
plus docs/classification and gate. Isolation includes telemetry, pg_cron and the
writer gateway; RLS includes catalog bootstrap and membership regressions. Do not
replace them with mocks or `continue-on-error`.

## Test ownership

`scripts/ci/test-ownership.json` lists all default Node-discovered files. At the
Batch 2 head `c487883` it contains 152 core and 38 web files (190 total, up from
189 because the bounded-runner contract test was added); `ownership.mjs` checks
the inventory for missing, stale or duplicate owners. When a discovered test is
added, removed or moved, update the manifest and run:

```sh
node --test tests/ci/classify-changes.test.mjs tests/ci/test-ownership.test.mjs
node -e "import('./scripts/ci/ownership.mjs').then(({discover,manifest,validateOwnership})=>{validateOwnership(discover(),manifest);console.log('ownership OK')})"
```

Linux foundation uses the bounded runner's `--ci-scope=core`; web uses
`--ci-scope=web`. Unscoped `pnpm test:ci` still runs default Node discovery.
The pinned source-manager fixture is checked separately, including planner output
and Python add/update/remove candidate validation. React component tests and
explicit `.rls.mjs` suites retain separate execution contracts. The planner is
intentionally run again to produce candidate plans.

Windows is omitted on routine PRs and main pushes, but release PRs/pushes and
manual full runs retain Windows foundation and web. Windows foundation keeps the
full unscoped suite, including deliberate release-time overlap with web. The
release ruleset requires `foundation (ubuntu-latest)`, `foundation (windows-2022)`,
and `contract-f rls (ubuntu-latest)`; preserve those exact names.

## Linux shards and the gate

Linux foundation is `foundation-checks (ubuntu-latest)`, two core shard jobs
`foundation-linux shard (1/2)` and `(2/2)`, and the aggregator `foundation`, which
carries the required `foundation (ubuntu-latest)` name. The checks job holds every
non-test gate (artifact, staging, catalog, typecheck, registry performance, token
vectors, specs); the shards hold the 152-file core suite split by
`run-tests-bounded.mjs --ci-scope=core --shard=i/2`.

The aggregator runs `verify-shards.mjs` with `CI_SHARD_SCOPE=core` and also fails
when `foundation-checks` did not succeed, because the ruleset only sees the
aggregator's name. `ci-gate` lists all three sub-jobs directly.

Changing the shard count means updating `LINUX_FOUNDATION_JOBS` in
`classify-changes.mjs`, the aggregator's `CI_SHARD_JOBS`/`CI_SHARD_COUNT`, the
`ci-gate.needs` list and the gate tests. Evidence is in
[../ci/batches-2-5-results.md](../ci/batches-2-5-results.md) §7.

## Windows shards and the gate

Windows foundation runs as two explicit jobs, `foundation-windows-shard-1` and
`foundation-windows-shard-2`, plus the aggregator `foundation-windows`, which
carries the required `foundation (windows-2022)` name. Explicit job ids are
deliberate: a matrix job collapses to one `needs` entry, so a missing or
duplicated shard would be invisible to the gate.

Each shard runs `pnpm test:ci -- --shard=i/2`, which keeps the unscoped suite and
default Node discovery. `scripts/ci/sharding.mjs` owns the partition: sorted file
*i* goes to shard `(i % n) + 1`, it fails on any duplicate or omission, and it
hashes both the selection and the full inventory. `scripts/ci/verify-shards.mjs`
runs in the aggregator, re-derives both partitions from the checkout and fails on
a missing, failed, cancelled, skipped, duplicated or drifted shard.

`ci-gate` lists the two shards and the aggregator directly because `needs` is not
transitive. `windowsSelected()` decides whether Windows is expected, and the gate
derives the same predicate independently from the event context; a disagreement
fails the gate. When Windows is selected the three jobs must be `success`; when it
is not, they must be an explicit `skipped`. A green Windows job outside a Windows
selection is rejected.

Do not add a new shard job without adding it to `ci-gate.needs`, `WINDOWS_JOBS`
in `classify-changes.mjs`, `CI_SHARD_JOBS` in the aggregator and the partition
tests. Re-measure shard balance after any test-file inventory change; index-parity
membership reshuffles when a file is added or removed. Evidence is in
[../ci/batches-2-5-results.md](../ci/batches-2-5-results.md) §6.

## Test concurrency

`scripts/release/run-tests-bounded.mjs` resolves the effective `--test-concurrency`
from an explicit flag, then `EGA_TEST_CONCURRENCY`, then Node's documented default
(`availableParallelism() - 1`). It logs the resolved runtime as one JSON line so a
hosted log records the machine it actually used instead of the runner label.

Windows foundation runs at an explicit `4`; Linux foundation, the web suite and
every other invocation keep the Node default. `workflow_dispatch` exposes
`linux_core_concurrency` and `windows_concurrency` for controlled comparisons;
both default to empty, so routine and release runs are unaffected. The values are
validated by a shell guard and by the runner (integer 1–32). Registry performance
stays pinned at `--test-concurrency=1` and is not part of the experiment. Evidence
is in [../ci/batches-2-5-results.md](../ci/batches-2-5-results.md) §5.

The duplicate `hashing-traversal.yml` workflow was removed. The two traversal
files and hashing enumeration remain in the foundation inventory; inspect both
release foundation logs for traversal execution. The former separate hashing
workflow references in historical evidence describe historical runs.

## Evidence and maintenance

[Run 41227424085](https://github.com/egawilldoit/ega-skills/actions/runs/41227424085)
passed for PR head `50b3a8c` on synthetic merge checkout `971f42d`: approximately
6m36s run latency and 11.9 summed job-minutes, with foundation about 3m45s and
web about 5m53s. The preceding [run 41224526338](https://github.com/egawilldoit/ega-skills/actions/runs/41224526338)
took 9m24s. Each is one sample; scheduling and workload differ, so this does not
establish a repeatable equal-workload improvement. Record run creation to gate
completion separately from each job's start-to-finish duration and their sum.

For changes: map affected checks and external rulesets, make the smallest edit,
run ownership and selector tests, verify hosted profiles including failure and
release conditions, record head and checkout SHAs plus timings, request an
independent review, and document rollback. A new job is not automatically a
required check. YAML parsing and skipped-job success do not prove execution.

At inspection main ruleset 22345614 did not require `ci-gate`; owner governance
work is deferred. Release ruleset 23893800 retains the three contexts above.
No ruleset is changed by workflow edits. No schedule or paid runner is configured.
Preview readiness is informational and does not authorize production promotion.

To roll back this PR, revert it as a unit, restoring the original `ci.yml` and
`hashing-traversal.yml` and original test commands. Preserve released artifacts
and required check contexts; do not change the source-catalog repository or rulesets.
