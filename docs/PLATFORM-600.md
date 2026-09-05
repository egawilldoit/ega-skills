# EGA-600 platform / offline / performance evidence

Reference measurements + cross-platform parity record. Correctness is gated
by CI on both OSes; this document separates that from reference performance
numbers and runner-noise observations (no rerun-until-green performance proof).

## Reference platform (this run)

- linux arm64, 2 vCPU (Neoverse-N1), node v24.18.0, 2026-09-05T16:22:27.519Z
- Method: `node scripts/perf/reference-bench.mjs` (committed); 100 synthetic
  skills with shared + distinctive vocabulary; cold phases use fresh homes.

## Reference results (linux-arm64)

| measure | median ms | p95 ms | target ms | verdict |
| --- | --- | --- | --- | --- |
| cold_hash_100 | 4.8 | 14.4 | 5000 | PASS |
| cold_import_100 | 1113.6 | 2309.8 | 5000 | PASS |
| registry_open | 0.8 | 1.1 | 250 | PASS |
| fts_warm_p95 | 0.4 | 0.5 | 100 | PASS |
| cache_get_typical | 0 | 0 | 50 | PASS |
| resolve_warm_100skill_p95 | 39.4 | 47.6 | 300 | PASS |

Raw runs + env: kept with the EGA-600 Linear evidence (`reference-bench.mjs
--out` JSON). All six measures pass with wide headroom on the reference box.

## Cross-platform parity (CI-gated, Ubuntu + Windows)

Every merged PR since Wave 6 runs the FULL suite on both OSes at the exact
feature HEAD (representative: #47–#54, all Ubuntu PASS + Windows PASS):

- canonical hash parity: frozen cross-platform hash fixtures + TEST-002
  ega-o200k-v1 vectors green on both OSes.
- token estimator parity: T001–T009 identical both OSes.
- router golden parity: 41/41 TEST-001 scenarios + x10 determinism in CI.
- MCP parity: contract + tool suites (incl. output-schema validation) green
  on both OSes.

## Windows x64 notes (honest runner-noise record)

- The 100-skill cold-import test carries a documented 30s Windows ceiling
  (vs 5s reference) for the identical corpus.
- One 50.3s Windows outlier observed (PR #51 first run; correctness
  assertions passed; PR diff could not affect the import path); the rerun
  went green. A second, unrelated 50s-class event was seen earlier in the
  program with the same signature. These are CI-runner noise, NOT product
  regressions — and NOT accepted as performance proof either. Standing
  conclusion: Windows correctness is gated green; Windows reference
  performance remains CI-observational until dedicated runner capacity exists.

## Offline parity

- MCP server holds ZERO socket fds before and after serving (live /proc
  audit on the fixed binary; repeated for EGA-595 and EGA-597).
- Frozen suites assert no network/shell/script imports on registry/MCP paths.
- All Codex/OpenCode acceptance runs used local stdio binaries only.
- `unshare -n` namespace isolation is blocked in this VM (operation not
  permitted) — recorded limitation, not a gap: the socket audit + static
  import assertions cover the same property.

## Versions / behavior parity statement

No OS-specific product behavior exists by construction: canonical hashing
(SHA-256 + RFC 8785 JCS), LF-normalized text handling, `query_only` reads,
and frozen fixtures are platform-independent. No platform-conditional code
was added in this cycle.
