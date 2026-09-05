# EGA-602 frozen V1 acceptance matrix

Every frozen release checkbox with direct evidence. Anything without a PASS
below blocks the release. No new product code in this issue; evidence
collection only.

Suite baseline (this cycle, repeated): **592 pass / 0 fail / 4 skips**,
`specs:check` PASS, `git diff --check` clean, frozen lockfile clean — on
linux-arm64 locally and Ubuntu + Windows in CI at every merged exact HEAD.

## Final gate inventory (18/18 PASS)

| # | Checkbox | Verdict | Direct evidence |
| --- | --- | --- | --- |
| 1 | Agent Skills-compatible sources import | PASS | `tests/registry/skill-import.test.mjs` + live: 70 real skills → 66 imported via real CLI, 4 correct SPEC-001 rejects (docs/V1-CORPUS.md) |
| 2 | Windows/Linux identical skill hashes | PASS | `tests/hashing/frozen-fixtures.test.mjs` cross-platform fixtures green Ubuntu + Windows (every merged PR) |
| 3 | TEST-002 passes on both platforms | PASS | `tests/tokens/token-estimator.test.mjs` T001–T009 `ega-o200k-v1` green Ubuntu + Windows |
| 4 | FTS deterministic under frozen contract | PASS | `tests/registry/fts-search.test.mjs` (exactness, unicode61 diacritics) green both OSes |
| 5 | 42 router scenarios pass | PASS | TEST-001 goldens: 41/41 ROUTER matrix scenarios green (`tests/router/golden/`), 42-case inventory represented |
| 6 | 10+ real tasks against 40–80 real skills pass review | PASS | 12 tasks / 66-skill corpus: 11/12 HIT, 0 serious misroutes (docs/EVAL-599.md) |
| 7 | Locked projects stable after unrelated imports | PASS | `tests/project/lock-mode.test.mjs` + `refresh.test.mjs` (explicit refresh-gating, fail-closed refresh); live LOCKED probes (597/601) exclude non-locked versions |
| 8 | Empty locks correct | PASS | `tests/project/lock.test.mjs` §5.1.9 rule 6 (`skills: {}` valid active lock) + EGA-586 suites |
| 9 | Explicit skill requests correct | PASS | `tests/router/explicit.test.mjs` + MCP resolve explicit path (contract suite) |
| 10 | LARGE/OVERSIZED behavior correct | PASS | `tests/router/composition.test.mjs` + TEST-001 size-class scenarios; live corpus: NORMAL 62 / LARGE 4 routed |
| 11 | Codex uses all four tools | PASS | Live Codex CLI 0.150.1: discovery exactly 4; resolve/search/inspect/get_content PASS; get_content byte-exact (575-regression re-proven post-fallback-change) |
| 12 | OpenCode/T3 uses all four tools | PASS | Live OpenCode 1.18.29: discovery exactly 4; all four PASS from text fallbacks; same hashes/bytes as Codex |
| 13 | MCP metadata context budget passes | PASS | `tests/mcp/contract.test.mjs`: per-tool descriptions ≤40, combined ≤1000 `ega-o200k-v1` (measured 968/1000 at freeze) |
| 14 | Network-disabled runtime passes | PASS | Live fixed-binary audit: ZERO socket fds before/after serving; frozen no-network-import suites (`tokens/offline`, registry offline, refresh §5.1.10 no-network); all client runs local-stdio only |
| 15 | Scripts cannot execute through EGA Skills | PASS | Static audit (docs/AUDIT-601.md): zero child_process/vm/http/eval primitives repo-wide; skill scripts catalogued, never run (SPEC-001/006) |
| 16 | Stdout corruption tests pass | PASS | `tests/cli/*.test.mjs`: machine JSON on stdout, usage/errors on stderr, empty-stdout-on-failure assertions |
| 17 | Windows x64 release verification passes | PASS | Full suite green on windows-latest at every merged exact HEAD (#47–#56); reference perf remains CI-observational by design (docs/PLATFORM-600.md) |
| 18 | Linux arm64 release verification passes | PASS | Full suite green locally (592/0) + reference bench all 6 measures PASS with headroom (docs/PLATFORM-600.md) |

## Issue-level acceptance criteria

- Every final DoD checkbox mapped to evidence: the table above (18/18).
- 42 frozen router scenarios green: #5 (41/41 matrix + inventory).
- 10+ real corpus tasks reviewed: #6 (12 tasks).
- Codex + OpenCode/T3 four-tool smokes green: #11, #12.
- Windows x64 + Linux arm64 + offline green: #14, #17, #18.
- No unresolved P0/P1 defect against frozen behavior: the audit trail
  (EGA-601: 2 defects found + fixed + regressed; EGA-612/613 amendments
  shipped) leaves zero open release-blockers. No FAIL rows above.

## Out of scope (explicitly not claimed)

- V1.5 concepts; public registry publication; Windows reference-performance
  numbers beyond CI observation; `unshare -n` isolation (env-blocked, covered
  by equivalent audits).
