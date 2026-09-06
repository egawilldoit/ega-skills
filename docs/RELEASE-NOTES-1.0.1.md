# EGA Skills 1.0.1 — Release Notes

Patch release over V1.0.0. No architecture change, no new tools, no LLM
routing. Three real-user defects, all proven before the fix and regressed
after it.

## What changed

1. **Third-party skill compatibility (EGA-614, AMEND-09).** Real
   `mattpocock/skills` corpus (@3cca18b, 37 skills, unmodified upstream):
   15/37 imported before, **37/37 after**. The 22 rejects used
   `disable-model-invocation` (4 also `argument-hint`). Both fields are now
   preserved with frozen strict types (boolean / string), enter manifest
   identity (absent keys omitted, pre-amendment manifests byte-stable), and
   `disable-model-invocation: true` skills NEVER auto-select — they stay
   visible candidates with reason `USER_INVOCATION_ONLY` (13th negative
   reason, appended last), still resolvable by explicit human reference.
   Official upstream semantics verified before the amendment; nothing is
   silently discarded. Curated `ega.yaml` triggers/domains remain the
   supported routing lever, pinned by `to-spec` vs `to-tickets` boundary
   regressions (automatic selection both ways).
2. **Supporting-file access (EGA-615, AMEND-10).** `references/*.md` and
   other TEXT companions were hashed, manifested, and cached but
   unreachable. `get_content` accepts an optional exact `file_path`
   (manifest-path equality, no normalization/glob; L2-only) and returns the
   byte-exact companion — still **exactly four MCP tools**. Policy/lock
   gating precedes all reads, cache bytes are hash-verified (retrievable
   after source removal), scripts/assets/binaries/control files are refused
   (`E_CONTENT_FILE_FORBIDDEN`), unknown paths fail closed without
   enumeration (`E_CONTENT_FILE_UNKNOWN`), same per-call token budget, never
   truncated.
3. **Fresh-project lock UX (EGA-616).** `init` wrote `locking.required:
   true` with no way to generate the lock. New `ega-skills lock`
   (create, refuses when a lock exists) and `lock --refresh` (regenerate +
   deterministic +/-/~ diff) reuse the frozen `refreshLock` pipeline:
   `init` → `lock` → `resolve` works with no hand-editing. Symlinked lock
   paths are rejected, writes are atomic (exclusive temp + rename,
   write-all loop), failed runs leave the previous lock byte-unchanged.

## Verification

- Full suite 624 pass / 0 fail (4 pre-existing skips); `specs:check`
  PASS; `git diff --check` clean; `--frozen-lockfile` clean (one intended
  +6-line lockfile change for the CLI's `project` + pinned `yaml` deps).
- Ubuntu + Windows CI green at every merged HEAD (PRs #60, #61, #62). Two
  Windows cold-import overruns (32.85 s, 95 s vs 30 s budget) were proven
  runner noise via clean reruns (5m14s, 5m20s jobs); the perf test was NOT
  weakened.
- Real-client proofs on the release tree: OpenCode 1.18.29 smoke (exactly
  four tools), 37/37 corpus import, companion-after-source-removal
  byte-exact over MCP stdio, lock workflow end to end.
- Reviews: independent APPROVE on #60; 11 CodeRabbit threads across
  #60/#61/#62 adjudicated as hypotheses — all valid findings fixed
  (SPEC-002 identity trace, LOW retention, boundary-test honesty, atomic
  symlink-safe writes, exclusive temp creation, write-all loop, temp
  cleanup), all threads resolved per the branch ruleset.

## Upgrade / compatibility

Drop-in: registry schema unchanged (version 2), no migration, no config or
lock format change. Nine version strings bumped 1.0.0 → 1.0.1 (root +
seven packages + MCP server identity).
