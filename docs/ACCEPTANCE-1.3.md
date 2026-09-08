# Release 1.3 acceptance ledger

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

Final repair/evidence HEAD: `6065cf417fa31d1de8377e0fe8934b56f6f30041`.
Implementation tree tested: `036647d68e30feb87a17fb5f8335b507262f200b`.
Exact implementation-tree CI: foundation `34170586093`; hashing traversal
`34170586088` (Ubuntu and Windows).
Final-head CI: foundation `34171163650`; hashing traversal `34171163658`
(Ubuntu and Windows; documentation-only delta after the implementation run).

| Criterion | Status | Evidence |
| --- | --- | --- |
| Multiple immutable contexts per project | PASS | `tests/cli/remote-projects.test.mjs`, `tests/project/remote.test.mjs` |
| Context binds config, lock, and release | PASS | context identity and control-plane tests |
| Initial locks bind one HubRelease | PASS | Contract E and remote lock containment tests |
| Local lock refresh remains unchanged | PASS | existing CLI lock suite and full regression |
| Remote planning requires an exact release | PASS | remote lock plan/apply tests |
| Remote lock update is explicit and reviewable | PASS | apply approval and atomic write tests |
| Context publication never mutates project files | PASS | authenticated local HTTP publication E2E |
| Package-scoped fingerprints work | PASS | `tests/router/remote-fingerprint.test.mjs` |
| Dirty-tree provenance is explicit | PASS | monorepo context E2E |
| Absolute machine paths are excluded | PASS | fingerprint portability and symlink tests |
| Missing fingerprints are explicit | PASS | hosted context binding tests |
| Context failures never fall back | PASS | hosted revocation and Contract D/E tests |
| Cache identity covers routing inputs | PASS | Contract E validator and tests |
| Context revocation works | PASS | local control-plane and store tests |
| Web/mobile routing distinction | PASS | root, package, branch, and worktree E2E |
| Fresh-machine remote project E2E | BLOCKED | No safe hosted staging URL or authenticated fresh client is available |

Gate summary: local authenticated publication and revocation PASS. The
remaining row requires a real staging control plane and fresh client. No
production deployment or remote mutation was performed.
Local persisted publication/list/restart/revocation E2E passes. Real hosted
control-plane and fresh-machine acceptance remain blocked until an isolated
staging environment exists.
