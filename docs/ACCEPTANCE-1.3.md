# Release 1.3 acceptance ledger

Canonical specification: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

This ledger separates local proof from evidence that requires a real hosted
deployment. A blocked row is not a release PASS.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Multiple immutable contexts per project | PASS | `tests/project/remote.test.mjs`, `tests/cli/remote-projects.test.mjs` |
| Context binds config, lock, and release | PASS | `createProjectContextArtifact` and Contract E tests |
| Initial locks bind one HubRelease | PASS | Contract E validator and lock-mismatch tests |
| Existing local lock refresh remains unchanged | PASS | Existing CLI lock suite plus full regression |
| Remote planning requires an exact release | PASS | CLI remote workflow and Contract E tests |
| Remote lock changes are explicit and reviewable | PASS | `remote-lock plan/apply` tests; apply requires approval |
| Context publication does not mutate project files | PASS | CLI remote-project acceptance test |
| Package-scoped fingerprints | PASS | web/mobile fingerprint tests |
| Dirty-tree provenance is explicit | PASS | real temporary Git monorepo E2E |
| Absolute machine paths are excluded | PASS | fingerprint adversarial tests |
| Missing fingerprints are explicit | PASS | hosted runtime `MISSING` response tests |
| Context failures never fall back | PASS | Contract D/E and hosted revocation tests |
| Cache identity covers routing inputs | PASS | Contract E cache identity validator/tests |
| Context revocation works | PASS | context-store and hosted runtime tests |
| Web/mobile routing distinction | PASS | real monorepo E2E |
| Fresh-machine remote project E2E | BLOCKED | No safe hosted staging deployment or remote URL is available; local monorepo proof passes |

## Gate summary

- Full regression: PASS — 785 tests, 780 passed, 5 skipped, 0 failed.
- TypeScript build and spec checks: PASS.
- Contract validators A–E: PASS.
- Real upstream 1.1 E2E: PASS — 1 test, 0 failures.
- Linux/Windows PR #73 CI: PASS at exact PR head (`34097504690`).
- 1.1/1.2 public release publication: BLOCKED by GitHub merge/release permissions.
- 1.2 hosted deployment and fresh Codex/OpenCode E2E: BLOCKED; no safe staging identity exists.
- 1.2 backup/restore/rollback evidence: OPEN in the local hosted implementation.
- 1.3 hosted control-plane publication and fresh remote-client evidence: BLOCKED by the same staging/deployment constraint.

Explicit non-goals: Contract F and release 2.0 have not started.
