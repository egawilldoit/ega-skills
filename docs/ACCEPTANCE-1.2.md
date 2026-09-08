# Release 1.2 acceptance ledger

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

Code-under-test SHA: `610650d44f68023c85a803dc250f1d81696e6279`.
The hosted focused suite and persisted context lifecycle suite pass locally;
the full regression passes 845 total, 840 passed, 0 failed, 5 classified
skips. Exact code-under-test CI is foundation `34215575847` and hashing
traversal `34215575864`, both passing on Ubuntu and Windows.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Authentication required | PASS | `tests/mcp/hosted-runtime.test.mjs`; OAuth verifier tests |
| Exactly four MCP tools | PASS | hosted runtime and Contract D tests |
| Contract D candidate is executable | PASS | `contracts:check-d`, `contracts:test-d` |
| Personal catalog mode is explicit | PASS | hosted scope matrix tests |
| Search and resolve return release identity | PASS | hosted runtime test |
| Inspect and get_content cannot cross releases | PASS | hosted scope and snapshot tests |
| SQLite contains one exact release corpus | PASS | startup corpus and FTS verification |
| New publication cannot alter old release search | PASS | release FTS isolation tests |
| Runtime is read-only | PASS | read-only SQLite and repeated-call tests |
| Emergency deny works | PASS | release, source, and SkillVersion deny tests |
| Tokens are not logged | PASS | OAuth and hosted boundary tests; no token logging path |
| Request, response, content, timeout, and concurrency limits | PASS locally | hosted adversarial transport tests exercise each local limit independently, including cancellation and safe-integer configuration validation |
| Physical connection limit | BLOCKED / NOT YET PROVEN | Requires the production deployment connection adapter; local in-process accounting is not evidence of physical socket enforcement |
| Startup verifies release integrity | PASS | snapshot tamper tests for package, SQLite, catalog, FTS, and artifacts |
| Hosted backup and recovery | BLOCKED / NOT YET PROVEN | The local Hub journal tests prove 1.1 transaction recovery, not hosted stable-pointer/auth/authorization metadata backup, immutable release storage restore, or hosted rollback |
| Retained-release rollback is tested locally | PASS locally / BLOCKED hosted | stable pointer tests require a verified same-Hub release in the retained-reference set and reject arbitrary, cross-Hub, and unretained targets; hosted rollback still requires staging evidence |
| Fresh Codex E2E | BLOCKED | Requires `EGA_CODEX_ACCEPTANCE=1` and a fresh client environment |
| Fresh OpenCode E2E | BLOCKED | Requires `EGA_OPENCODE_ACCEPTANCE=1` and a fresh client environment |

The local hosted HTTP/MCP integration is PASS. Cloud deployment, OAuth client
registration, and fresh-client acceptance remain external operations.
No hosted backup/restore, hosted rollback, physical connection, or fresh-client
acceptance is claimed by this local ledger.
