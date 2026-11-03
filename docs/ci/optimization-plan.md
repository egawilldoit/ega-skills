# EGA Skills CI/CD optimization plan

Status: plan only. Batch 0 (documentation correction) is the only step represented here as completed; no test, workflow, script, or production behavior was changed by this plan. Companion to [performance-audit.md](performance-audit.md) and [optimization-results.md](optimization-results.md).

## 1. Invariants

Every batch must preserve:

- The release/2.0 ruleset (`23893800`) required contexts, byte-identical: `foundation (ubuntu-latest)`, `foundation (windows-2022)`, and `contract-f rls (ubuntu-latest)`.
- The separate `ci-gate` workflow job and its Vercel deployment-check use (`externalCheckName` `ci-gate`).
- `docs`, `web`, and `full` classifier semantics. Web mode still runs foundation. The classifier stays narrow; `docs/**` and `tests/web/**` are not safe broadenings.
- Real PostgreSQL isolation and RLS (`web-isolation` and `rls`), including all eight `.rls.mjs` suites.
- Committed catalog and artifact integrity, digest checks, source pins, tamper refusal, and the authorization assertions including the 403-versus-503 expectation.
- Frozen specifications, typechecks, web builds, source-manager proposal validation, registry cold-import performance, and test ownership.
- The bounded runner's per-test and overall timeouts and its process-tree termination behavior.
- No production writes, no shared database access, no deployment, no ruleset change, no secret change, and no paid runner.

Ordering principles: remove repeated work before adding runners; measure before changing concurrency; shard only after the measurements justify it; preserve gate contracts exactly; prefer reversible changes.

## 2. Measured starting point

From the corrected audit. These are descriptive observations, not after-change promises.

| Path | Measured wall | Binding job | Binding step | Source availability |
|---|---:|---|---|---|
| Full PR or push to `main` | 6.00–6.13 min | `web console (ubuntu-latest)` 5.7–5.8 min | Web API and integration tests 5.27 min | 15 Linux successful runs; one run supplies step detail |
| Windows-enabled release-path run | 17.6 min median; 19.2 min p90 | `foundation (windows-2022)` 17.2 min median | Test 16.13 min | Four Windows-enabled runs; mixed workflow versions |
| README-only docs mode | not observed in the sample | `docs` 0.08–0.12 min | classifier test plus whitespace | 0 sampled runs selected docs |

Two observations drive the plan:

1. `tests/web/skills.test.mjs` accounts for 247 s of attributed reporter time in the sampled 316 s web step. Source inspection shows repeated verification for distinct config objects; file-process elapsed time and causal savings remain unmeasured.
2. The Windows foundation step is 967 s and runs 189 files at an effective concurrency that is not logged. The published runner is 4 CPU / 16 GiB, so about 3 is the expected Node default, but this is unverified.

No caching, checkout, or runner-vendor change addresses either fact.

## 3. Final sequence

The program is sequential. A later step starts only if the previous step's hosted and safety evidence supports it.

### Batch 0 — Correct the record and capture contracts (completed in docs only)

Goal: make the audit and plan traceable to run IDs, code, and live rulesets, and remove invalid claims before any implementation.

Scope:

- `docs/ci/performance-audit.md`
- `docs/ci/optimization-plan.md`
- `docs/ci/optimization-results.md`

Acceptance:

- All 43 techniques have a status from the approved set and evidence.
- Runner, monthly volume, cancellation, Windows concurrency, OOM attribution, rerun latency, and 503 investigation are stated with their limits.
- Live rulesets and `ci-gate` are recorded with read-back date and ruleset IDs.
- No workflow, test, application, or ruleset change.

Rollback: revert the three docs. No runtime effect.

### Batch 1 — Reuse one default `ServerConfig` per web test file

Goal: remove repeated construction and verification of the committed-artifact default config without changing any scenario.

Allowed files:

- `tests/web/skills.test.mjs`
- `tests/web/catalog.test.mjs`
- `tests/web/releases.test.mjs`
- `tests/web/category-browse.test.mjs`
- `docs/ci/optimization-results.md` (measurement evidence only)

No production code, artifact, workflow, script, gate, or ownership change.

Implementation rules:

1. Build one immutable default committed-artifact config per test-file process and have the existing `committedConfig(extraEnv = {})` helper return that same object only for the semantically default call. `fullCatalog(extraEnv = {})` may continue to delegate to `committedConfig(extraEnv)`; default `fullCatalog()` calls then share the same config.
2. Treat a non-empty override as fresh even when the value happens to equal the default. This preserves the "explicit environment override" scenario and avoids evaluation-order surprises. An empty object may share; any own key constructs a new config.
3. Keep every intentionally fresh case fresh: copied or tampered artifacts, wrong digests, source mutations, missing artifacts, mismatched identities, and environment-specific refusal cases. Direct `parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy })` calls stay direct.
4. Do not replace direct `evaluateReleaseIdentity(...)`, `loadHostedReleaseSnapshot(...)`, `openReadOnlyRegistry(...)`, or `createRegistryReader(...)` calls. Those tests independently prove verification and refusal behavior.
5. Preserve every test, assertion, `after()` cleanup, `closeRegistry()`, temporary-directory removal, and before/after digest assertion.
6. A file-scoped config holds no handle itself. `closeRegistry()` clears the reader map and closes every retained reader; a later call reopens a reader for the same frozen config. Verify this behavior before relying on it.
7. If instrumentation is needed, use a bounded local probe excluded from commits. Record config construction counts, opened and closed readers, and RSS where safely measurable. Do not run an uncontrolled 126-config, 700 MiB reproduction on the shared VM.

Required validation:

- Run the four files independently on Linux with the repository's Node 24 setup.
- Confirm unchanged discovered file count, test count, and assertions against the pre-change version.
- Confirm refusal of bad digests, tampered or copied artifacts, mismatched identities, and bad environments.
- Confirm cleanup even when an assertion fails, using safe targeted failure injection, not changes to tracked artifacts.
- Confirm the committed artifact's before/after digest is unchanged.
- Record per-file process wall time, config count, reader count, and RSS where observable.
- Run hosted Linux and the appropriate Windows/release verification. Do not retarget the PR to `release/2.0` just to obtain a Windows status.

Expected effect: direction only, not a promise. The local microbenchmark showed 893 ms per fresh call versus 241 ms per shared call for eight skills. A hosted improvement is expected in the four files, but the magnitude must be measured. A correctness regression overrides any speed gain.

Rollback: revert the four test files. No workflow change.

### Batch 2 — Hosted Node concurrency 3 versus 4

Precondition: Batch 1 passes Linux and Windows, and the four-file change is confirmed not to have altered coverage.

Scope:

- Linux core/foundation tests: compare effective concurrency 3 versus 4.
- Windows full foundation tests: compare 3 versus 4.
- Leave the web suite concurrency unchanged.
- Leave `pnpm test:perf:registry` at its explicit `--test-concurrency=1`.

Requirements:

1. Log the actual Node version, `os.availableParallelism()`, CPU count, total memory, `--test-isolation` mode, and effective `--test-concurrency` in each experiment.
2. Pass the explicit concurrency through `scripts/release/run-tests-bounded.mjs` without breaking `--ci-scope`, file selection, per-test and overall timeouts, exit-code propagation, or signal/process-tree cleanup. The runner already forwards unknown arguments at line 179; prefer that over a new scheduler.
3. If workflow wiring is needed, use a `workflow_dispatch` input limited to 3 or 4 with an unchanged production default. Do not add a permanent complex scheduler.
4. Compare the same source SHA where practicable. If wiring requires different SHAs, record the confound instead of claiming matched-SHA evidence.
5. Capture per-file process duration, wall time, CPU saturation, peak RSS, file count, flakes, timeouts, and summed runner-minutes. Reporter test durations are not file-process elapsed times.
6. Use a few representative executions on the correct runners. Do not spam workflows to manufacture a sample size.
7. Adopt 4 only if it yields a repeatable net benefit with no reliability regression. Otherwise keep the current default and move on.
8. Record adopted and rejected values in `docs/ci/optimization-results.md`.

No numeric speed forecast is made here. The measured values decide.

Rollback: remove the experiment input or restore the previous invocation. No structural effect.

### Batch 3 — Windows release-mode sharding, only if measured data justifies it

Precondition: Batch 2 is complete, Windows still dominates the release path, and the measured data supports a credible reduction after duplicated setup and gate overhead.

Preserve:

- The exact required context `foundation (windows-2022)`.
- The Windows 2022 image.
- Every existing Windows check: checkout, Node, corepack, install, lockfile, build, artifact validation, web staging check, catalog freshness, typecheck, registry cold-import performance, token vectors, frozen specs, the full test suite, and the deliberate web overlap.
- Linux foundation behavior unchanged initially.

Design rules:

- Split only the test work into two independent shards if the workflow architecture permits it without ambiguity. Keep the non-test checks in a separate concern or in the aggregator, owned exactly once.
- Use Node 24 native `--test-shard=i/2` over the exact unscoped discovery, or an explicit file list derived from `scripts/ci/test-ownership.json`. Prove the union of the selected files equals the previous set with zero duplicates and zero omissions. Run both selections and confirm executed results, not just planned partitions.
- Do not add a weight scheduler or a new result service. If native shard selection cannot be proven complete and balanced enough, stop.
- Keep `fail-fast: false` explicit for sibling shards. No `continue-on-error` for mandatory tests.
- Preserve timeout, signal handling, process-tree cleanup, and native `better-sqlite3` behavior.

Gate rules:

- `ci-gate.needs` must list every mandatory direct dependency. `needs` is not transitive. If the design adds `foundation-checks`, two test shards, and a Windows aggregator, all of them must be direct `ci-gate` dependencies, along with the existing jobs.
- The aggregator must be mode-aware. A docs-only or web-only run may skip Windows legitimately; an unexpected skip when the event requires Windows must fail closed. An unconditional aggregator that demands Windows on every run is wrong.
- Web mode still runs foundation. Docs mode does not run foundation.
- Verify both shard completions, not merely a successful matrix aggregate. Reject missing, duplicate, failed, cancelled, or unexpectedly skipped required shards.
- Preserve the three release-required names. If a byte-identical name cannot be maintained without ambiguity, stop the batch and keep Batch 1/2.

Failure matrix before acceptance:

- Windows checks fail: release context red.
- Shard 1 fails: aggregator and `ci-gate` red.
- Shard 2 fails: aggregator and `ci-gate` red.
- One shard cancelled: red.
- One expected shard omitted: red.
- Duplicate or wrong-shard evidence: red.
- Classifier fails or emits an invalid mode: fail closed.
- Docs-only and web-only expected skips follow the mode contract.
- Full and release modes still run real PostgreSQL and all three required contexts.

Rollback: revert the workflow and gate change. No data migration.

### Batch 4 — Linux core sharding, only if still critical

Precondition: Batch 3 is complete or rejected, Windows no longer dominates, and Linux foundation remains slower than the web job.

Scope: two Linux core test shards behind the exact required name `foundation (ubuntu-latest)`, with the same completeness, timeout, cleanup, and gate rules as Batch 3.

Additional constraints:

- Preserve the existing `foundation (ubuntu-latest)` required context.
- Never remove foundation from web mode.
- Keep the real-PostgreSQL `web-isolation` and `rls` jobs unchanged and owned exactly once.
- Account for the extra runner start, install, and build. If the web job becomes the critical path, stop and re-evaluate instead of adding more shards.

Rollback: revert the workflow and gate change.

### Not in this program

- No web sharding without measured evidence that it shortens the critical path after Batch 1.
- No classifier widening.
- No Blacksmith migration, paid runner, or alternate CI provider.
- No dependency-graph service, per-test pass cache, remote task-result service, or custom multi-service infrastructure.
- No merging of the PostgreSQL jobs.
- No timeout increases, retries, or `continue-on-error` to hide flakes.

## 4. Gate and coverage contract

| Guarantee | How it is preserved | Proof |
|---|---|---|
| 151 core files run | B1/B2 do not change discovery; a later Linux shard must prove union equals the ownership manifest | `scripts/ci/test-ownership.json`; `ownership.mjs`; shard proof |
| 38 web files run | Web suite unchanged except the config reuse in Batch 1 | Job log file list |
| Eight `.rls.mjs` suites run | `web-isolation` and `rls` jobs unchanged | `ci.yml:313-345,392-413`; job results |
| Windows full unscoped suite | Windows keeps all 189 files, including the deliberate web overlap, unless Batch 3 proves complete shard parity | Windows job log |
| Required release contexts | Names stay byte-identical: `foundation (ubuntu-latest)`, `foundation (windows-2022)`, `contract-f rls (ubuntu-latest)` | Ruleset `23893800` read-back |
| `ci-gate` and deployment check | `ci-gate` stays unconditional at the workflow level and fail-closed; any new shard/check job is a direct `needs` entry; the Vercel deployment check is unchanged | `ci.yml`; `check-gate.mjs`; `verify-live.mjs` |
| Mode-aware skips | Docs may skip foundation and web; web still runs foundation; full and release run everything | `classify-changes.mjs:36-41`; gate tests |
| Artifact and authorization integrity | No artifact, digest, source-pin, or authorization assertion changes | Artifact validation steps and the four web tests |
| Bounded runtime | Per-test and overall timeouts and process-tree kill unchanged | `run-tests-bounded.mjs` diff |

## 5. Verification strategy

For every batch:

1. Inspect the exact diff and confirm no file outside the allowed list.
2. Run focused tests first. For B0: `node --test tests/ci/classify-changes.test.mjs tests/ci/test-ownership.test.mjs`, ownership validation, and `git diff --check`.
3. For B1: run the four files independently; compare file/test counts and assertions; exercise refusal cases; confirm cleanup and artifact digests.
4. For B2: run the 3/4 experiment on the same SHA where possible; record runtime CPU, memory, effective concurrency, per-file process time, wall, RSS, and runner-minutes.
5. For B3/B4: prove file parity before enabling the gate; inject failures and omissions; confirm red propagates to the aggregator and `ci-gate`; confirm expected skips in docs and web modes.
6. Re-read the required contexts after any workflow change. A local parse or a skipped job is not evidence of execution.
7. Record run URLs or IDs, revision, attempt, wall time, and runner-minutes in `docs/ci/optimization-results.md`.

## 6. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Shared config masks an artifact mutation | Only default committed-artifact tests share it; mutation tests use fresh copies; `after()` digest assertion stays | Revert the four test files |
| Concurrency change causes timing flakes | Measure 3 and 4 on the same SHA; keep the stable value; do not raise timeouts | Restore the previous invocation |
| Shard assignment drops or duplicates a file | Prove union equals the ownership manifest with zero duplicates before enabling | Revert the workflow change |
| Aggregator reports green without a shard | Direct `needs` entries; explicit per-needs result checks; failure injection | Revert the workflow change |
| Unexpected Windows skip passes in release mode | Mode-aware aggregator; manual full and release events require Windows; routine main PRs do not require Windows even in full mode | Revert the workflow change |
| Required context identity changes | Keep byte-identical names; re-read ruleset after the first run | Revert the workflow change |
| Classifier misclassifies a change | Keep the current narrow allowlist; do not add `docs/**` or `tests/web/**` | Revert the classifier change, if any |
| Cache breaks native modules | No cache in this program; any later cache must prove `better-sqlite3` ABI integrity and keep the lockfile diff | Remove the cache step |

## 7. Explicitly rejected

1. **Remove or scope down Windows validation.** Violates the release ruleset and the documented deliberate overlap.
2. **Widen `docs` mode to `docs/**`.** Skips the generated-catalog freshness check for `docs/generated/SKILL-CATALOG.md`.
3. **Widen `web` mode to `tests/web/**`.** Skips `cross-workspace-isolation.rls.mjs`, which is outside ordinary ownership discovery and needs real PostgreSQL.
4. **Replace the classifier with `on.pull_request.paths`.** A path-filtered workflow would not report the required gate.
5. **Mock or skip real PostgreSQL isolation or RLS.** They are the security proof.
6. **Merge `web-isolation` and `rls`.** Each is about 1 minute and they run in parallel; merging adds wall.
7. **Linux pnpm or Node caches, or sparse checkout.** Install is about 5 s, checkout about 2 s, repository about 10.8 MB.
8. **Blacksmith or paid larger runners.** Deferred; no verified benefit and no authorization for paid capacity.
9. **Per-test or impact-analysis result caching.** Can hide regressions in shared fixtures and generated catalogs.
10. **Cancel or skip main-branch runs, or deduplicate push versus PR by SHA.** The push run is the deployment gate.
11. **Raise timeouts, add `continue-on-error`, or retry flaky tests.** These mask the failure mode the bounded runner exists to expose.
12. **A giant shard scheduler or new infrastructure.** Use native Node sharding only if it proves complete coverage; otherwise stop.

## 8. Decision

Proceed with Batch 1 next. It is test-only, addresses the measured dominant file, and does not touch the workflow, the gate, the artifact, or the release contracts. Batch 2 is a bounded experiment that can be rejected without affecting Batch 1. Batches 3 and 4 remain conditional on measured hosted evidence and complete gate proofs.
