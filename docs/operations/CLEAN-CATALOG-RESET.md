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

## E2E acceptance matrix

| ID | Scenario | Verification | Status (base SHA `f76f3a6`) |
| --- | --- | --- | --- |
| A1 | Valid empty catalog accepted | `tests/ci/clean-catalog-regression.test.mjs`: empty presentation against an empty release | **FAIL** — hub-side blocker B1 |
| A2 | Invalid manifests still fail | Presentation cases in `clean-catalog-regression.test.mjs` (removed-skill reference, routing keys, malformed input) plus release-manifest cases in `clean-release-lifecycle.test.mjs` (digest drift, bad version hash, row-count drift) | **PASS** |
| A3 | Stale generated catalog fails CI | Same file: `catalog:check --check` on stale/missing/current temp outputs | **PASS** |
| A4 | Empty release builds and validates | `tests/release/clean-release-lifecycle.test.mjs`: empty hub → `validate-artifact` → `skills=0` | **PASS** |
| A5 | Empty discovers nothing, not a crash | Same file: release-scoped FTS search on empty artifact returns `[]` | **PASS** |
| A6 | Add → publish → discover | Same file: add one skill to temp hub, rebuild, new digest, artifact validates, FTS finds it | **PASS** |
| A7 | Post-promotion verification of empty release | Same file: `loadExpectedCatalog` on zero-skill manifest | **FAIL** — release-side blocker B2 |
| A8 | Rollback identity preserved | Same file: committed `previous-hub-release.json` is present, valid, and distinct from current; package digest bound to release | **PASS** |
| A9 | Security gates remain active | `tests/ci/classify-changes.test.mjs`, `tests/release/ci-release-path.test.mjs`, `tests/release/recover-production.test.mjs`, `tests/release/verify-live.test.mjs` | **PASS** (baseline run) |
| A10 | Docs match behavior | This document + README/AGENTS updates | **PASS** once B1/B2 land; currently describes target state with blockers listed |

## Blockers and required fixes

These are not hidden by skips. The two failing tests above are intentional
acceptance assertions and must pass after integration.

| ID | Location | Observed failure | Required fix (outside this branch's ownership) |
| --- | --- | --- | --- |
| B1 | `packages/cli/src/catalog.ts` `validatePresentation` (~L241, L263) | `CatalogError: groups must be a non-empty sequence`; an empty `presentation.yaml` also fails the `group needs a non-empty skills sequence` check. `pnpm catalog:check` will fail once the committed presentation is empty. | Accept `favorites: []` and `groups: []` when the release has zero skills, while still rejecting unknown/stale ids and non-empty groups with empty skills when skills exist. Mirror the source-side `validate_catalog.py` empty-catalog contract. Owner: hub catalog reset / CLI agent. |
| B2 | `scripts/release/verify-live.mjs` L141 (and L592 TStack check) | `ConfigError: hub-release.json has an empty catalog`; TStack L2 verification also requires at least one matching skill. After promotion an empty release would exit `2` (config), which never establishes a verified live release. | Treat zero skills as valid: skip per-skill inspect and TStack L2 reads when the catalog is empty, still verify digest/alias/`ci-gate`, and report `skill_count: 0` with `ok: true`. Owner: release/runtime agent. |
| B3 | `apps/web/server/presentation.ts` ~L245 | Empty presentation payloads are rejected by the web server projection. | Web empty-state agent must accept an empty presentation and render the empty state. |
| B4 | `tests/catalog/catalog-generator.test.mjs` | Hard-codes `EXPECTED_CATALOG_SKILLS = 126` and references removed skill ids; will fail after the artifact is emptied. | Hub catalog reset agent must update these historical assertions to the empty end state while keeping the general rendering/validation contracts. Not modified here (not owned by this branch). |

## Unverified behaviors

- **Real hosted promotion.** No production write, deployment, or alias move was
  performed. `READY` was not treated as live. All hosted evidence in this repo's
  release tests is mocked; the live production path remains unverified.
- **Source repo CI.** The source repository was inspected read-only at its
  in-progress reset worktree; its CI was not executed here. Step 1/2 gates must
  be observed by the source agent and the lead.
- **Real PostgreSQL RLS/isolation.** Not run in this branch; those jobs need a
  service container and remain CI-only.
- **Final integrated run.** `pnpm release:verify` and the full `pnpm test:ci`
  were run against base `f76f3a6`, not the merged five-branch tree. The lead
  must rerun them after integration and after B1/B2 land.

## References

- [AUTOMATIC-RELEASE.md](AUTOMATIC-RELEASE.md) — authoritative production path.
- [RELEASE-2.0-RUNBOOK.md](RELEASE-2.0-RUNBOOK.md) — release runbook.
- [source-skill-manager.md](source-skill-manager.md) — source proposal validation boundary.
- [ci-optimization.md](ci-optimization.md) — CI selection, ownership, rollback.
- [`docs/specs/`](../../docs/specs/) — frozen behavioral contracts.
- Regression tests: [`tests/ci/clean-catalog-regression.test.mjs`](../../tests/ci/clean-catalog-regression.test.mjs),
  [`tests/release/clean-release-lifecycle.test.mjs`](../../tests/release/clean-release-lifecycle.test.mjs).
