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

`scripts/ci/test-ownership.json` lists all default Node-discovered files. At head
`50b3a8c` it contains 150 core and 38 web files; `ownership.mjs` checks the
inventory for missing, stale or duplicate owners. When a discovered test is
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
