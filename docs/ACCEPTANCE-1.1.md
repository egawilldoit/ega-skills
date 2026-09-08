# Release 1.1 acceptance ledger

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

Code-under-test SHA: `610650d44f68023c85a803dc250f1d81696e6279`.
Exact code-under-test CI: foundation `34215575847`; hashing traversal
`34215575864` (Ubuntu and Windows).

| Criterion | Status | Evidence |
| --- | --- | --- |
| Fresh registry | PASS | `tests/project/hub-builder.test.mjs`; `tests/project/hub-adoption.test.mjs` |
| Developer registry cannot affect output | PASS | `hub-builder.test.mjs` history isolation |
| Release-scoped aliases | PASS | `hub-release-state.test.mjs` alias derivation and ownership tests |
| Release-only search rows | PASS | `hub-release-state.test.mjs` FTS corpus tests |
| R2 cannot change R1 search | PASS | release FTS isolation regression |
| Zero import failures | PASS | isolated builder and CLI `hub build` tests |
| Exact expected catalog | PASS | builder and release verification tests |
| Self-contained source adoption | PASS | `hub-release.test.mjs`; real-upstream E2E |
| License provenance integrity | PASS | `hub-planning.test.mjs`; real-upstream E2E |
| Immutable explicit UpdatePlan | PASS | `hub-planning.test.mjs`, Contract B tests |
| Crash recovery | PASS | `hub-adoption.test.mjs` journal recovery tests |
| Exact commit apply | PASS | A to B to C lifecycle regression; `fetchExactCommit` test |
| External scripts never execute | PASS | import/build boundary tests and MCP source-boundary test |
| HubRelease binds runtime semantics | PASS | `hub-release.test.mjs`; startup snapshot tests |
| Semantic and SQLite digests are separate | PASS | Contract C and HubRelease package-binding tests |
| Removed skills only disappear in newer releases | PASS | release-state and lifecycle coverage |
| Historical releases remain intact | PASS | lifecycle proves R1 artifact remains unchanged |
| Fresh checkout reproduces semantic release | PASS | deterministic builder, FTS, and real-upstream tests |

Real upstream command:

```bash
EGA_REAL_UPSTREAM=1 node --test tests/project/real-upstream-e2e.test.mjs
```

Result: PASS, 1 test, 0 failures. Exact commits were Cursor
`71ed0d1076fec562c1b74ee353121a8d00f75382` and Matt
`3cca18b368ae95cdbdebbff572ccafa662551015`.

The same gated test also proves the real Matt lifecycle with a controlled
bare mirror: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
C=`3cca18b368ae95cdbdebbff572ccafa662551015`. The latest run recorded the
run-scoped approved B plan digest
`sha256:6e47b09b38763f702de35f3ed122723faa4db9ffcbe8180c47436f9ed7e06484`;
the tracked ref advanced to C and apply still landed B while preserving R1.
The digest varies with the temporary local-mirror path because that path is
part of the Contract A source configuration digest; it is not a semantic
release identity.

Final code-under-test gate summary: full regression PASS, 845 total, 840
passed, 0 failed, 5 classified skips. Build, typecheck, specs, and Contracts A
through E passed. The focused repair-boundary suite passed 109/109 using:
`node --test tests/project/hub-adoption.test.mjs tests/project/hub-release-state.test.mjs tests/project/hub-release.test.mjs tests/project/remote.test.mjs tests/mcp/hosted-runtime.test.mjs tests/router/remote-fingerprint.test.mjs tests/contracts/contract-c.test.mjs`.
No 1.1 release tag or publication was performed. The documentation snapshot
is evidence-only after the code-under-test commit above.
