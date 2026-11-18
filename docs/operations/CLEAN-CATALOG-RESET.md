# Clean catalog reset: operating model and acceptance

Status: **implementation + local verification**. This document describes the
target operating model for the reset of `egawilldoit/skills` and
`egawilldoit/ega-skills`. It does not authorize a merge, deployment, production
write, or alias change. The lead agent integrates the five parallel branches.

Verified revisions: hub base `f76f3a674069fde70e082ff73130b71d33a63c0d`
(`cleanup/reset-verification`); source base
`5ec137b05995219d11ff6633263fc855bf6fbeab`
(`cleanup/source-catalog-reset`); historical source fixture pin
`8f264fc5fcb5691694c3653287f4d9370c5b025c` (kept, not rewritten).

## Operating model

1. The **active catalog is empty** at the reset commit. Zero skills are
   published, discovered, or routed. An empty catalog is a valid state, not an
   error.
2. **Immutable history is preserved.** Nothing is dropped: previous release
   identities (`previous-hub-release.json`), release artifacts, Git history,
   database tables/roles/migrations, auth, OAuth, RLS, and workspace isolation
   all remain.
3. **Publication only via `main`.** A reviewed PR lands on `main`; GitHub CI
   publishes the required `ci-gate`; Vercel's native Git integration builds and
   the Deployment Check moves the canonical alias. There is no manual publisher,
   staging/promote command, approval envelope, or hand-moved alias. See
   [AUTOMATIC-RELEASE.md](AUTOMATIC-RELEASE.md).
4. **A later skill is added the same way.** Source PR → source CI → hub rebuild
   → reviewed hub PR → `main` → CI/Vercel → `verify-release.yml`. Discovery is
   never granted by a catalog edit; presentation metadata is non-authoritative
   (SPEC-004).
5. **No second registry and no bulk re-import.** The single registry is the
   artifact built from immutable source snapshots. Historical fixtures remain
   for contract tests; they are not re-imported into the active catalog.

## Cross-repository sequence

The two repositories move in a fixed order. Do not publish the hub before the
source commit it binds is green.

| Step | Repository / branch | Action | Gate |
| --- | --- | --- | --- |
| 1 | `egawilldoit/skills` @ `cleanup/source-catalog-reset` (base `5ec137b05995219d11ff6633263fc855bf6fbeab`) | Remove active skills; keep history, license, notices, and validation scripts. Empty `skills/` with `.gitkeep`, empty `sources` in `upstream-sources.json`. | Source `catalog-validation.yml`: `validate-head` + `validate-merge` + `validate-main` Python gates (`validate_catalog.py` accepts zero skills with empty provenance). |
| 2 | `egawilldoit/skills` | Merge/reset source `main` only after both source check names are green. Record the source commit SHA. | Source CI on the exact pushed SHA. |
| 3 | `egawilldoit/ega-skills` @ `cleanup/hub-catalog-reset` + runtime branch | Rebuild the artifact from that exact source snapshot: zero-skill `hub-release.json`, matching `release-package.json`, regenerated `docs/generated/SKILL-CATALOG.md`, empty-state web console. Keep `previous-hub-release.json`. | `pnpm build`, `pnpm catalog:check`, `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact`. |
| 4 | `egawilldoit/ega-skills` @ this verification branch | Land clean-catalog regression coverage, cross-repo checks, and this documentation. | `node --test tests/ci/...`, `pnpm specs:check`, `git diff --check`, `pnpm release:verify`. |
| 5 | `egawilldoit/ega-skills` | Lead opens the two draft PRs; integration review confirms all five branches agree on the source SHA and the empty-catalog contract. | Real GitHub Actions on the final candidate, not a local simulation. |
| 6 | `main` | Merge the reviewed PR. Vercel builds `main`; `ci-gate` must succeed before the alias moves. | `ci-gate` + Vercel Deployment Check on the same commit. |
| 7 | production | `verify-release.yml` runs on the production `deployment_status` event, confirms the deployed SHA is contained in `main`, verifies identity/alias/gate, then (on exit 4) recovers the previous healthy deployment. | `scripts/release/verify-live.mjs`; `scripts/release/recover-production.mjs`. |

The source-manager pinned fixture in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) stays at
`8f264fc5fcb5691694c3653287f4d9370c5b025c`. That is deliberate: source-manager
tests assert a historical baseline inventory and run the Python unit suite
against that baseline. The reset of source `main` must not rewrite the pin.
Proposed-tree validation uses copies of that fixture with plans applied, so the
historical baseline remains available while the active catalog is empty.

## CI gates that must stay active

- Change classification is fail-closed: release-sensitive paths (workflows,
  `scripts/release/`, `scripts/ci/`, `packages/mcp/artifact/`, lockfiles,
  Supabase) always select `full`.
- `ci-gate` is unconditional (`always()`) and requires every selected job,
  including Linux foundation checks and both shards, plus real Windows shards
  when Windows is selected.
- `catalog:check` fails on a stale or missing generated catalog.
- Artifact validation, RLS/isolation, OAuth, and `specs:check` remain required.
- `scripts/ci/test-ownership.json` fails closed on discovered-test drift; new
  tests must be registered there.

## E2E acceptance matrix — final integration head

Evidence labels: **local** (VM run), **hosted** (GitHub Actions PR #203),
**mocked HTTP** (isolated origin/Vercel test servers), **not production**.

| ID | Scenario | Verification | Result / evidence |
| --- | --- | --- | --- |
| A1 | Valid empty catalog accepted | `tests/ci/clean-catalog-regression.test.mjs` empty presentation against an empty release | **PASS** — local + hosted |
| A2 | Invalid manifests still fail | Same file plus `tests/release/clean-release-lifecycle.test.mjs` | **PASS** — local + hosted |
| A3 | Stale generated catalog fails CI | Same file: `catalog:check` on stale/missing/current temp outputs | **PASS** — local + hosted |
| A4 | Empty release builds and validates | `tests/release/clean-release-lifecycle.test.mjs`: empty hub → `validate-artifact` → `skills=0` | **PASS** — local + hosted |
| A5 | Empty discovers nothing | Release-scoped FTS search on empty artifact returns `[]` | **PASS** — local + hosted |
| A6 | Add → publish → discover | Same file: one skill added to a temp hub, new digest, FTS finds it | **PASS** — local + hosted |
| A7 | Post-promotion verification of empty release | `tests/release/verify-live.test.mjs` V1–V6 and V12: `verifyCatalog()` and full CLI entrypoint | **PASS** — local, mocked HTTP |
| A8 | Rollback identity preserved | Committed `previous-hub-release.json` present, valid, distinct; package digest bound | **PASS** — local + hosted |
| A9 | Security gates remain active | `tests/ci/classify-changes.test.mjs`, `tests/release/ci-release-path.test.mjs`, `tests/release/verify-live.test.mjs`; hosted RLS and PostgreSQL isolation jobs | **PASS** — local + hosted |
| A10 | Docs match behavior | This document, `REGENERATE.md`, artifact README | **PASS** — current revision |
| A11 | First skill from an empty source catalog | `tests/web/source-manager/planner.test.mjs`, source `tests/test_trigger_audit.py`, `tests/integration/catalog-reset-lifecycle.test.mjs` | **PASS** — local |
| A12 | Zero → one → two → one → zero | `tests/integration/catalog-reset-lifecycle.test.mjs` with `EGA_RESET_SOURCE_ROOT` pointing at source PR #20 | **PASS** — local |
| A13 | Populated and non-TStack live verification | `verify-live.test.mjs` V7–V11 (mocked HTTP) | **PASS** — local, mocked HTTP |

All required PR #203 checks pass on the final head in hosted CI run
`44299830894` (including `ci-gate`, both Linux foundation shards, web console,
`contract-f rls`, and real PostgreSQL web isolation). Source PR #20 checks pass
on `e4871b9`.

## Operating model

1. **Zero-skill release verification.** `verify-live.mjs` confirms alias,
   deployment id, readiness digest and `ci-gate` first. With `snapshot_rows=0`
   it verifies the four authenticated MCP tools, requires `search` to return
   exactly `[]` bound to the expected release digest, performs zero inspect and
   zero L2 content reads, and reports `skill_count=0`, `inspected=0`,
   `search_result_count=0` with `ok: true`. Unexpected results, missing tools,
   auth failure or digest drift still fail closed with the original exit codes
   and recovery contract. Populated releases keep full inspect/L2 coverage; a
   release with no `t3dotgg/*` skills probes the first pinned manifest skill
   and requires that skill to appear in search.
2. **First skill.** The source catalog is empty by design. In the console, Add
   skill remains available; with no neighbors the UI explains that no competing
   skills exist and sends the explicit `null` sentinel for `negative_expected`
   and `collision_expected`. The planner inserts metadata and provenance into
   the canonical empty generator tables (`= {}` / `= []`), writes SKILL.md,
   ega.yaml and agents/openai.yaml, and records a real trigger case. Source CI
   validates the case: the negative and collision examples must be meaningful
   and must not describe the target itself.
3. **Routing expectations before competitors exist.** `null` means "no
   competing skill exists", not "validation skipped". A named neighbor must be
   an existing pinned source skill. `null` stays valid after a second skill is
   added, so the first case never has to be rewritten.
4. **Second skill.** The console restores neighbor selectors (with an explicit
   "No competing skill" option). The planner requires named neighbors to exist
   and rejects unknown or malformed values.
5. **Removing the last skill.** Removal reconciles referencing trigger cases,
   deletes the skill directory, removes the exact generator entries and returns
   both tables to their canonical typed empty forms. Source CI must pass again.
6. **Regenerate and validate a release.** Follow
   [`reset-inputs/REGENERATE.md`](../../packages/mcp/artifact/reset-inputs/REGENERATE.md):
   use `hub release preview --policy` and `hub release export`, then run
   `pnpm generate:catalog`, `pnpm catalog:check`, `pnpm release:verify`, and
   `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact`. Never
   hand-edit immutable artifacts.
7. **Review vs automatic release.** These changes live in draft PRs and need
   independent review. Only a merge to `main` triggers the native Vercel
   production build; `ci-gate` must succeed before the canonical alias moves,
   and `verify-release.yml` verifies and can invoke the existing recovery flow.
   Vercel previews are not production acceptance.
8. **Historical recovery.** The 126-skill release, the 117-skill predecessor,
   the 858 superseded blobs and the pinned discovery report remain in Git at
   base `f76f3a6…`. Historical contract tests read that immutable fixture from
   Git (`tests/fixtures/historical-artifact.mjs`); if the commit is missing the
   helper fails with an actionable fetch instruction rather than skipping.

## Evidence boundaries

- Implemented and tested locally: verifier, planner, source validators, zero→
  one→two→one→zero lifecycle, artifact regeneration.
- Tested in hosted CI: full platform required checks, source validate-head and
  validate-merge.
- Tested with mocked HTTP only: live verifier success/failure paths; no real
  promotion, alias move or production database was contacted.
- Not tested in production: by design. No deploy or publication was performed.

## References

- [AUTOMATIC-RELEASE.md](AUTOMATIC-RELEASE.md) — authoritative production path.
- [RELEASE-2.0-RUNBOOK.md](RELEASE-2.0-RUNBOOK.md) — release runbook.
- [source-skill-manager.md](source-skill-manager.md) — source proposal validation boundary.
- [ci-optimization.md](ci-optimization.md) — CI selection, ownership, rollback.
- [`docs/specs/`](../../docs/specs/) — frozen behavioral contracts.
- Regression tests: [`tests/ci/clean-catalog-regression.test.mjs`](../../tests/ci/clean-catalog-regression.test.mjs),
  [`tests/release/clean-release-lifecycle.test.mjs`](../../tests/release/clean-release-lifecycle.test.mjs).
