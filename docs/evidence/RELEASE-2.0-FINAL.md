# EGA Skills 2.0 — Final release evidence

Status: final integration candidate assembled; independent review round 1
completed (both reviewers BLOCK); all P1 software fixes applied and awaiting
round-2 verification. Every PASS below carries observable evidence. `BLOCKED`
and `SKIPPED` are not passes.

## Identity

- Repository: `egawilldoit/ega-skills`
- Canonical branch: `release/2.0`
- Baseline SHA: `2259364616b1255b00285fe6f2e280e9495896de`
- Integration branch: `fix/2.0-release-integration` (PR #113)
- Integration history:
  - `175b05d` — Agent A integrated (reliability/CI)
  - `a34b0f9` — Agent B integrated (protocol/artifact)
  - `9997291` — Agent C integrated (OAuth/staging)
  - `36e93aa` — integration fix: protocol-era identity test bound to the
    package version (resolved A's 2.0.0 bump vs B's 1.0.1 pin)
  - `1e5e87b` — release notes, runbook, doc reconciliation (**review round 1
    target**)
  - `7aec2f8` — review fix round (C): deterministic signature tamper, frozen
    hosted error codes, authorize-before-deny (**review round 2 target**)
- Product version: `2.0.0` (root + 10 workspace packages + both MCP
  serverInfo identities)
- Execution date: 2026-09-22 UTC
- Node: v24.18.0 · pnpm: 10.0.0 · OS: Ubuntu 22.04 aarch64 (2 cores)
- Artifact identity: release digest
  `sha256:70a37c28e767230e04e45e34a33689113870394cda88f017f2aac322aaeb3f66`
  (`hub=personal`, `skills=5`), byte-identical to the committed
  `packages/mcp/artifact` and to what production and both clients serve.
- Cross-client identity for skill `cursor/architect`:
  version hash
  `sha256:59b17ec966644abbd8754d5f0780e6fcb39ce95bb7c8e92461066681815b353e`,
  L2 bytes `sha256:897a59beaa3cab107d98c256206e062cc4a5e9421a45b9d462fbded19291fea5`
  (5383 bytes) — identical across direct MCP probe, Codex, OpenCode, and
  legacy/modern sessions.

## Baseline blocker and root cause (fixes B1)

- GitHub run `35544811605`, job `106168728100` (ubuntu foundation) started
  `pnpm test` at 2026-09-20T23:30:04Z and never terminated; cancelled at
  2026-09-21T05:30:05Z. Windows job `106168728098` passed in ~6.5 min.
- Root cause (Agent A, deterministic A/B): `tests/mcp/retained-serving.test.mjs`
  attached a child `exit` listener *after* awaited file polling. A child that
  had already exited replays no event, so the promise never settled and the
  test-file process stayed alive; Node 24 does not force test files to exit.
  The same test also parsed the child result file while it was being written.
- Fix (`7caf652`): exit-state-aware helper; atomic temp-file + rename result
  publication; bounded sibling barriers; `t.after` kill-on-failure. Regression:
  `tests/release/lifecycle-termination.test.mjs` (runner must exit naturally
  and a leaked-handle fixture must fail with named evidence).
- Bounded runner: `pnpm test:ci` (`scripts/release/run-tests-bounded.mjs`) —
  per-test 600 s, overall 1500 s, survivor evidence, SIGTERM→SIGKILL, exit 124.
- Local reproduction of the *healthy* baseline in the integration worktree
  before the fix terminated in 1012 s with 1029/1024/0/5 — the race is latent
  under CPU pressure and fatal on a fast runner, which is why CI (and not every
  local run) hit it.

## Implementation agents

### A — release reliability and CI

- Branch `fix/2.0-release-a-reliability`, commit `7caf652`, 27 files.
- Root cause above; CI now triggers on `pull_request`, `push main`,
  `push release/2.0`, and `workflow_dispatch`, with `timeout-minutes: 45` and
  the bounded `pnpm test:ci`. Hashing workflow applicability fixed.
- `pnpm release:verify`: 20 named credential-free stages, fail-fast, tee'd
  logs; nonzero on failure.
- Release identity normalized to 2.0.0 (frozen schema/contract/format versions
  untouched) with `tests/release/version-consistency.test.mjs`.
- `pnpm audit --prod`: no runtime advisories (`pnpm audit` full output recorded
  in the branch evidence; no upgrades performed).
- Full suite on the branch: 1036 tests / 1031 pass / 0 fail / 5 skipped.
- Evidence: `docs/evidence/2.0-A-RELIABILITY.md`.

### B — MCP protocol and artifact correctness

- Branch `fix/2.0-release-b-protocol`, commits `24864fa`, `2692bde`; 17 new
  tests, no product-code changes (the 2.0 SDK already serves `2026-07-28`).
- Proven: legacy HTTP/stdio, modern `2026-07-28` HTTP/stdio via
  `server/discover` with no `initialize` and no fallback, auto negotiation,
  legacy-vs-modern product parity, exactly four tools in both eras,
  artifact-only serving after upstream source deletion, protected-content
  isolation, tamper matrix, read-only runtime hash proof.
- Two candid follow-ups recorded: hosted error-code collapsing (fixed in the
  review round) and conditional-path literal-source assertions.
- Evidence: `docs/evidence/2.0-B-PROTOCOL.md`.

### C — hosted OAuth, real-client, and staging

- Branch `fix/2.0-release-c-live-interop`, commits `f84f32b`, `250750b`,
  `b53aa24`, `891b84f`, plus review fix `0744b33`.
- Live OAuth: discovery, anonymous 401 challenge, JWT positive/negative matrix,
  real authorization-code + PKCE, refresh with identity preservation, DCR
  observed (opaque UUID; CIMD not advertised).
- Real clients: Codex (isolated `CODEX_HOME`) and OpenCode (isolated XDG dirs)
  authenticated headlessly, discovered exactly four EGA tools, and observed the
  same skill/version/digest as the direct probe; Codex restart persistence
  proven.
- Staging: candidate artifact built/validated, four immutable preview
  deployments with A→B→A→B rollback transcript, four fail-closed previews
  (partial JWT, malformed authz, wrong audience, missing artifact) with
  `readyz 503` and no tools, and no secret in logs.
- Evidence: `docs/evidence/2.0-C-STAGING.md`.

## Integrated verification

- `pnpm release:verify` on `1e5e87b` (review round 1 target): **20/20 stages
  PASS**, full suite 1058 tests / 1051 pass / 0 fail / 7 skipped, natural exit
  after 762.1 s; log
  `/tmp/opencode/release/integration-verify3.log` (`integration-verify3`
  wrapper timestamps 2026-09-22T20:44:34Z → 20:58:19Z).
- The same gate on `7aec2f8` (round 2 target) is recorded in the post-merge
  evidence update; the round-1 run failed once on an unrelated environmental
  perf flake (registry cold import 6375 ms > 5000 ms budget while an unrelated
  `next-server` saturated the 2-core box; passed on re-run at 3.1 s, and CI
  passes this step on both OSes).
- PR #113 CI on `1e5e87b`: run `35782175610` — foundation windows PASS,
  contract-f rls PASS; foundation ubuntu **FAIL** on the flaky tampered-signature
  test (fixed in `7aec2f8`); hashing traversal run `35782175511` PASS on both
  OSes. The exact-SHA run on the merged `release/2.0` commit is recorded in the
  post-merge evidence update.

## Independent review round 1 (SHA `1e5e87b`)

Both reviewers worked read-only in isolated worktrees and did not share
conclusions. Raw reviews are held by the main agent; findings register:

| ID | Reviewer | Sev | Area | Finding | Status |
|---|---|---|---|---|---|
| R1-F1 = R2-P1-01 | R1, R2 | P1 | OAuth test/CI | Tampered-signature negative was ~24% no-op (last base64url char is padding-only), causing the red exact-SHA CI (`35782175610` job `106930103001`) | **FIXED** `0744b33`; 20/20 deterministic runs |
| R1-F2 = R2-P2-03 | R1 | P1 / R2 P2 | Client interop | G58 strict `protocol=2026-07-28` on OpenCode not executable: `McpRemoteConfig` has no protocol field (1.18.32 and today's dev build); observed negotiation `2025-11-25` | **BLOCKED** (external client capability); modern proven at SDK/live layer |
| R1-F3 = R2-P2-04 | R1 | P1 / R2 P2 | Process | Merging to `release/2.0` auto-deploys production (Vercel production branch) | Mitigation applied at merge time (production build suppressed); production untouched |
| R1-F4 | R1 | P2 | Artifact/staging | Staging previews built from `f84f32be` (not an ancestor of integration); product delta is two version strings | Accepted deviation; artifact bytes identical; post-merge preview re-check planned |
| R1-F5 = R2-P2-01 | R1, R2 | P2 | Hosted error contract | `errorResult` collapsed frozen `McpContextError` codes to `E_RUNTIME_UNAVAILABLE` | **FIXED** `0744b33` + regression `tests/mcp/hosted-content-codes.test.mjs` |
| R2-P2-02 | R2 | P2 | Hosted authz order | Deny classification preceded authorization (latent deny/nonexistent oracle for unauthorized principals) | **FIXED** `0744b33` + regression test |
| R1-F6 | R1 | P2 | Docs | `docs/EXECUTION-STATE.md` stale ("NOT MERGED") | **FIXED** historical banner |
| R1-F7 = R2-P2-06 | R1, R2 | P2 | Docs | Aggregate ledger incomplete | **FIXED** by this record |
| R1-F8 = R2-P2-05 | R1, R2 | P2 | Governance | `release/2.0` has no branch protection/ruleset | Recorded; recommendation below |
| R1-F9 | R1 | P3 | Docs | `docs/OPERATOR-GUIDE.md` unmarked V1.0.1 | **FIXED** historical banner |
| R2-P3-01 | R2 | P3 | Interop | Case-sensitive `Bearer ` scheme check | Accepted (RFC nit; no observed client affected) |
| R2-P3-02 | R2 | P3 | Diagnostics | Absolute artifact path can appear in a corrupted-blob error message | Accepted for 2.0 |
| R2-P3-03 | R2 | P3 | OAuth provider | Supabase advertises `plain` PKCE; hook binds all project OAuth clients to the MCP audience | Accepted; dedicated-issuer invariant documented in `packages/mcp/VERCEL.md` |

Round-1 verdicts: R1 **BLOCK**, R2 **BLOCK** — both driven by the same P1
(test/CI nondeterminism); no P0 found by either reviewer. Round-2 verdicts are
recorded in the post-merge evidence update.

## Gate ledger (specification G01–G75)

Round-1 statuses reconciled from both reviewers' independent observations plus
main-agent logs. `PENDING` marks gates whose evidence is produced by the final
verification/merge cycle.

| Gate | Status | Evidence |
|---|---|---|
| G01 clean checkout | PASS | worktrees at baseline; `git status --short` empty |
| G02 frozen lockfile | PASS | `pnpm install --frozen-lockfile` + lockfile diff clean locally and in CI |
| G03 build | PASS | `pnpm build` exit 0 (local + CI both OS) |
| G04 typecheck | PASS | `pnpm typecheck` exit 0 (local + CI both OS) |
| G05 specs | PASS | `pnpm specs:check` 8 frozen files |
| G06 Contract A | PASS | `CONTRACT-A-OK` |
| G07 Contract B | PASS | `CONTRACT-B-OK` |
| G08 Contract C | PASS | `CONTRACT-C-OK` |
| G09 Contract G | PASS | `CONTRACT-G-OK sha256:f7e1b715…` |
| G10 Contract F | PASS | CI job `contract-f rls` at `1e5e87b` |
| G11 registry performance | PASS | CI step both OS; local 2491 ms / 5000 ms |
| G12 token vectors | PASS | 25/25 local; CI step |
| G13 full Linux suite | PASS (local) | 1058/1051/0/7, natural exit 762 s; CI hashing-ubuntu full suite PASS |
| G14 full Windows suite | PASS | CI `1058/1050/0/8`, 542 s, natural exit |
| G15 hashing Linux | PASS | run `35782175511` ubuntu job |
| G16 hashing Windows | PASS | run `35782175511` windows job |
| G17 no process hang | PASS | bounded runner + lifecycle regression; all runs exited naturally |
| G18 no unexpected skipped mandatory test | PASS | 7 Linux / 8 Windows skips all accounted (opt-in live/upstream/OS-specific) |
| G19 intake publication E2E | PASS | `intake-publication-e2e` green |
| G20 derivative publication E2E | PASS | `intake-derivative-publication-e2e` green |
| G21 exact approval enforcement | PASS | apply-before-approval refused |
| G22 stale approval rejection | PASS | stale expected-revision review rejected |
| G23 stale preview rejection | PASS | exit 4, no stale candidate dir |
| G24 artifact validation | PASS | `validate-artifact.mjs` on committed + candidate artifact |
| G25 source-deleted artifact serving | PASS | `artifact-only-serving-e2e` 1/1 |
| G26 promotion | PASS | retained RL-04 |
| G27 rollback | PASS | retained monotonic explicit rollback |
| G28 CAS | PASS | revision CAS enforced |
| G29 concurrent one-winner | PASS | W6 concurrent promote/rollback |
| G30 interrupted-write recovery | PASS | killed before/after pointer write |
| G31 retry idempotency | PASS | retry stays at same revision |
| G32 historical pinned selection | PASS | RL-05 pinned r2; unknown digest refused |
| G33 legacy HTTP | PASS | protocol-http-eras B2 |
| G34 modern HTTP | PASS | B3 `server/discover`, no initialize |
| G35 auto HTTP | PASS | B4 selects modern |
| G36 legacy stdio | PASS | protocol-stdio-eras |
| G37 modern stdio | PASS | protocol-stdio-eras |
| G38 exactly four tools | PASS | B8 both eras/transports |
| G39 semantic parity | PASS | B7 parity 2/2 |
| G40 protected content rejection | PASS | artifact-only frozen codes; hosted now preserves them (`0744b33`) |
| G41 OAuth discovery | PASS | live curl + C evidence; canonical resource |
| G42 anonymous challenge | PASS | `/mcp` 401 + canonical `resource_metadata` |
| G43 PKCE authorization code | PASS | live interop 33/33 + offline stub |
| G44 DCR/CIMD observed | PASS | DCR opaque UUID both clients; CIMD absent |
| G45 access token | PASS | delegated token four-tool probe |
| G46 refresh token | PASS | refresh grant + rotated token re-probe |
| G47 exact audience | PASS | hook binding + offline matrix |
| G48 exact issuer | PASS | live + offline wrong-issuer rejection |
| G49 wrong audience rejection | PASS | offline 401; live first-party 401 |
| G50 first-party token rejection | PASS | live negative matrix 401 |
| G51 hostile Origin rejection | PASS | origin tests green; live 403 |
| G52 authorization/RLS isolation | PASS | contract-f rls CI green; multi-user authz tests |
| G53 no credential leakage | PASS | repo secret scan clean; sentinel-log tests |
| G54 Codex remote connection | PASS | `codex mcp list` + remote-login exit 0 |
| G55 Codex OAuth | PASS | DCR + PKCE S256, resource pinned |
| G56 Codex four-tool proof | PASS | per-tool JSONL, exactly four tools, identity match |
| G57 Codex restart proof | PASS | fresh process, persisted OAuth |
| G58 OpenCode strict 2026-07-28 | **BLOCKED** | client 1.18.32 (and today's dev build) has no protocol pin; observed `2025-11-25` |
| G59 OpenCode OAuth | PASS | headless login, `connected (OAuth)` |
| G60 OpenCode four-tool proof | PASS | same identity as Codex/probe |
| G61 OpenCode auto mode | PASS (discrepancy recorded) | auto negotiated `2025-11-25` |
| G62 deployment artifact exact identity | PASS | candidate A/B IDs; digest `70a37c28…` |
| G63 Vercel preview | PASS | deployment IDs verified Ready/Preview |
| G64 healthz | PASS | production + previews `200` |
| G65 readyz | PASS | production `200`; bad configs `503` |
| G66 fail-closed bad startup | PASS | four fail-closed previews; offline startup matrix |
| G67 rollback proof | PASS | A→B→A→B transcript; runbook |
| G68 version consistency | PASS | version test 4/4; CLI and both MCP identities 2.0.0 |
| G69 release notes | PASS | `docs/RELEASE-NOTES-2.0.0.md` |
| G70 operator runbook | PASS | `docs/operations/RELEASE-2.0-RUNBOOK.md` |
| G71 exact-SHA CI | PENDING (round 1 FAIL) | round 1 red on the flaky test; post-fix exact-SHA run recorded post-merge |
| G72 reviewer R1 PASS | PENDING | round 1 BLOCK; round-2 verdict recorded post-merge |
| G73 reviewer R2 PASS | PENDING | round 1 BLOCK; round-2 verdict recorded post-merge |
| G74 zero P0 | PASS | no P0 found by either reviewer; boundary attacks all failed closed |
| G75 zero P1 | PENDING | P1 test defect fixed and awaiting round-2 confirmation; G58 BLOCKED |

## Governance and authorization

- `release/2.0` is **not protected** (no branch protection; only a ruleset for
  `main`). Recommended: required CI status checks, no force pushes, no branch
  deletion. Not applied silently.
- Vercel production branch is `release/2.0`; production deployment is NOT
  authorized by the execution brief. The merge that produces the exact-SHA CI
  evidence therefore suppresses the Vercel production build for its duration
  (project ignore command), and production is restored to its prior state
  immediately after. Production remains the pre-candidate deployment
  (`dpl_7sZekMx6LV1iDc3qcXU9TxddxyiL`, digest `70a37c28…`).

## Production

Production deployment was NOT performed under this execution. The existing
production deployment is pre-candidate and was not modified, promoted, or
rolled back. Production remains a separate release-owner action per
`docs/operations/RELEASE-2.0-RUNBOOK.md`.
