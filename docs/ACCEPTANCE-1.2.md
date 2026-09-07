# Release 1.2 acceptance ledger

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

Implementation candidate tested: `a8ec090f79894f56d2ddb85627fe49448386e774`.
The hosted focused suite passed 10 tests before the final provenance-only test
was added; the full regression at the parent candidate passed 798 total, 793
passed, 0 failed, 5 skipped.

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
| Request, response, content, timeout, concurrency, and connection limits | PASS | hosted adversarial transport test, each limit independently |
| Startup verifies release integrity | PASS | snapshot tamper tests for package, SQLite, catalog, FTS, and artifacts |
| Backup and recovery are tested | PASS | Hub journal PREPARED/TREE_SWAPPED recovery tests |
| Retained-release rollback is tested | PASS | stable pointer tests reject arbitrary and cross-Hub hashes |
| Fresh Codex E2E | BLOCKED | Requires `EGA_CODEX_ACCEPTANCE=1` and a fresh client environment |
| Fresh OpenCode E2E | BLOCKED | Requires `EGA_OPENCODE_ACCEPTANCE=1` and a fresh client environment |

The local hosted HTTP/MCP integration is PASS. Cloud deployment, OAuth client
registration, and fresh-client acceptance remain external operations.

