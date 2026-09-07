# Release 1.1 acceptance ledger

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`

Implementation candidate tested: `cf4d85b2d83e8c9fa0cfbf1fa7d1aa89fc7c5df3`
Final repair HEAD: `44a4dd441550ec0bb6da692cb062ccedccb247ce` (evidence-only
commits after the reviewed code candidate).
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

The same gated test also proves the real Matt lifecycle with a controlled
bare mirror: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
C=`3cca18b368ae95cdbdebbff572ccafa662551015`. The approved B plan digest
recorded in the latest run was
`sha256:6f77e29c7a8c28befcb168833d2bde9a920119e7471b5c91353ffef65bab50f`;
the tracked ref advanced to C and apply still landed B while preserving R1.

Final-head gate summary: full regression PASS, 806 total, 801 passed, 0
failed, 5 skipped. Build, typecheck, specs, and Contracts A through E passed.
Exact-head CI run `34140809559` passed on Ubuntu and Windows; the focused
hashing run `34140809741` passed on both platforms.
No 1.1 release tag or publication was performed.
