# EGA Skills 1.0.1 — Release Notes

Patch release over V1.0.0. No architecture change, no new tools, no LLM
routing. Three real-user defects, all proven before the fix and
regression-tested after it.

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

## Post-release real end-to-end validation — 2026-09-06

After publishing V1.0.1, the release was tested again as a real user from a
fresh checkout of the public tag. This was a manual end-to-end validation of
the released product, separate from CI and the pre-release test suite.

This documentation records observed runtime results only; it does not change
or replace the frozen contracts in [`SPEC-004`](specs/SPEC-004-Router-and-Resolution-Contract.md),
[`SPEC-005`](specs/SPEC-005-Project-Config-and-Lockfile.md), or
[`SPEC-006`](specs/SPEC-006-MCP-Runtime-Contract.md).

### Test environment

- Public tag: `v1.0.1`
- Release commit observed after `git checkout v1.0.1`:
  `cb6a9ae890487e12796bf91c4627d132e86e5e27`
- Fresh checkout: clean detached HEAD at the release tag
- Package/CLI version observed: `1.0.1`
- Host: Ubuntu
- Real third-party corpus: unmodified `mattpocock/skills`
  @ `3cca18b368ae95cdbdebbff572ccafa662551015`
- Real client: OpenCode using the local EGA Skills MCP server

### E2E scenarios and results

| Scenario | Real-user result |
| --- | --- |
| Fresh release checkout | **PASS** — `git checkout v1.0.1` produced HEAD `cb6a9ae...`; working tree was clean and package version was `1.0.1`. |
| Frozen install + build + CLI | **PASS** — `pnpm install --frozen-lockfile`, `pnpm build`, CLI `--version`, and CLI help all succeeded; the new `lock` command was present. |
| Real unmodified third-party import | **PASS** — 37 skills staged, **37 imported, 0 failed** from the pinned upstream corpus. |
| Fresh-project lock workflow | **PASS** — `init` wrote `locking.required: true`; `lock` created a 37-skill lock; `resolve` worked immediately with no YAML hand-editing. |
| Real routing | **PASS** — task `I want to use TDD to build a feature test-first.` selected `mattpocock/tdd` as Tier B / MEDIUM confidence with `lockStatus: LOCKED`. |
| No-op lock refresh | **PASS** — the exact `lock /tmp/ega-v101-project --refresh` run returned `added: []`, `removed: []`, `changed: []`, `skills: 37`. |
| Local-first persistence after source removal | **PASS** — the original `mattpocock/skills` checkout was deleted; EGA still inspected the immutable TDD version and its manifested files from the local registry/cache. |
| OpenCode MCP connectivity | **PASS** — OpenCode reported `ega-skills connected` using the released MCP server. |
| Companion retrieval after source deletion | **PASS** — OpenCode used `ega-skills_inspect` + `ega-skills_get_content` with `file_path: "tests.md"`; retrieval succeeded after the source tree had been deleted, returning the real `# Good and Bad Tests` heading. |
| Natural client skill discovery | **PASS** — without naming EGA, MCP, or tool names, a project-skill prompt caused OpenCode to use `search → resolve → get_content`; missing L1 was rejected and the client correctly fell back to L2. |
| User-only skill cannot auto-select | **PASS** — `mattpocock/to-spec` matched as Tier B but remained a candidate with `USER_INVOCATION_ONLY`; `selected` stayed empty and automatic selected tokens stayed `0`. |
| Explicit human invocation of user-only skill | **PASS** — `--explicit mattpocock/to-spec` produced Tier E with `EXPLICIT_USER`; the observed row used version hash `sha256:abfbefcd66d260b31389cebbd2bb9fe11e4121a48a388b0e3cc040d0033733fb` and reason `LOCKED_VERSION`. |
| Companion path traversal | **PASS** — `file_path: "../tests.md"` was rejected. L1+`file_path` failed input validation; the valid L2 attempt failed closed with `E_CONTENT_FILE_UNKNOWN`. No normalized traversal or file disclosure occurred. |

Across the real E2E session, all four public MCP tools were exercised:
`resolve`, `search`, `inspect`, and `get_content`.

### Real-client observation

One minor ergonomics issue was observed in OpenCode: on some first attempts it
removed the required `sha256:` prefix from `version_hash`. EGA rejected the
malformed or non-locked identity with `E_MCP_INPUT_INVALID` /
`E_VERSION_NOT_LOCKED`; OpenCode then recovered by using the canonical hash
returned by EGA. The invariant stayed fail-closed, no incorrect version was
served, and this was not a V1.0.1 release blocker.

### E2E conclusion

**PASS for the observed real-user session.** V1.0.1 completed a fresh
install/import/project/client workflow covering the three patch goals:
third-party compatibility, companion access after source disappearance, and
fresh-project lock UX. The same session also observed user-only invocation
semantics and traversal rejection in the released build. Determinism and
cross-platform guarantees remain backed by the automated frozen contract/test
suite and Ubuntu + Windows CI rather than this single manual run.

Detailed retained transcript/evidence:
[`docs/evidence/V1.0.1-REAL-E2E-2026-09-06.md`](evidence/V1.0.1-REAL-E2E-2026-09-06.md).

## Upgrade / compatibility

Drop-in: registry schema unchanged (version 2), no migration, no config or
lock format change. Nine version strings bumped 1.0.0 → 1.0.1 (root +
seven packages + MCP server identity).
