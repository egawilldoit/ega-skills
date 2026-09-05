# EGA Skills 1.0.0 — Release Notes

V1: local-first skill registry + deterministic resolver + read-only MCP for
Codex and OpenCode/T3.

## What shipped

- Portable skill import (SPEC-001) into immutable SHA-256 versions with a
  content-addressed cache (SQLite + FTS5), deterministic across Linux/Windows.
- `ega-o200k-v1` token estimator with frozen T001–T009 vectors.
- Deterministic router (SPEC-004): 41/41 TEST-001 scenarios green, x10
  determinism, suggest-mode conservatism, hard max 3 selections.
- Project config + lockfiles (SPEC-005): policy, exact-version locks
  (empty locks valid), explicit refresh, fail-closed corruption handling.
- Read-only local MCP (SPEC-006): exactly `resolve`, `search`, `inspect`,
  `get_content`; structured outputs + self-sufficient text fallbacks;
  capability-enforced read-only (query_only handles, SQLite readonly
  connections); offline; zero sockets.
- Real-client acceptance: Codex CLI (4/4 tools, byte-exact content) and
  OpenCode/T3 (4/4 parity, same hashes/bytes).
- Real corpus basis: 70 evaluated → 66 imported, 4 documented rejects.
- Security audit: 2 defects found + fixed (read-only resolve, fail-fast
  validation) with regressions; secrets clean.

## Acceptance

18/18 frozen checkboxes PASS (docs/ACCEPTANCE-602.md). Full suite
592 pass / 0 fail, Ubuntu + Windows CI at every merged HEAD.

## Upgrade / compatibility

First release; no prior versions. On-disk registry schema is version 2;
read-only flows refuse stale schemas (run a read-write flow to migrate).

## Known limitations

See OPERATOR-GUIDE §13 (partial-name ranking observation, exec-bit note,
Windows perf observational, V1 non-goals, branch-protection gap).
