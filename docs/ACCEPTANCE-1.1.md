# Release 1.1 acceptance ledger

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

Implementation candidate tested: `13a23037030630eb0fb32d6d289e826af2e8e5ce`
Final code candidate HEAD: `ff688ea90491f95b97216d0f2ee5c523561798c6`
Focused provenance regression: `a8ec090f79894f56d2ddb85627fe49448386e774`.

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
`93b00b89ef425a9c1bac0d0b317dfc49c930ac99` and Matt
`3cca18b368ae95cdbdebbff572ccafa662551015`.

Candidate gate summary: full regression PASS, 798 total, 793 passed, 0
failed, 5 skipped. Build, typecheck, specs, and Contracts A through E passed.
Exact-head CI run `34131637759` passed on Ubuntu and Windows; the focused
hashing run `34131637767` passed on both platforms.
No 1.1 release tag or publication was performed.
