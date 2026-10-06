# Baseline gate results — feat/web-console

Repo: /home/ubuntu/ega-skills
Branch at baseline: release/2.0
EXACT BASE SHA: 39ae0d7b19ab5cf5830b5d36dd9280cebcbcc0d9
Host: 2 vCPU, 11 GB RAM, Linux aarch64, node v24.18.0, pnpm 10.0.0

## Working tree state at baseline

Untracked only (NOT part of this work, never read or committed):
  .vercel/                 local Vercel link dir; .vercel/.env.production.local may hold secrets
  packages/mcp/.gitignore  untracked single-line file

Preserved pre-existing user work (NOT part of this work):
  scripts/oauth/interop-check.mjs had an uncommitted modification on codex/intake-p12.
  Saved to git stash "preflight: in-progress OAuth interop apikey change ..." and also to
  /tmp/opencode/ega-baseline/uncommitted-preflight.patch. Not applied, not committed.

## Gate results

| Gate | Command | Result |
|---|---|---|
| install | `pnpm install --frozen-lockfile` | PASS |
| build | `pnpm build` | PASS |
| typecheck | `pnpm typecheck` | PASS |
| specs | `pnpm specs:check` | PASS (8 frozen files, G001-G042 x1, T001-T009) |
| artifact validation (CI step) | `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact` | PASS — digest sha256:1efdbc3d...31b77, hub=personal, skills=114 |
| Contract F RLS (real PostgreSQL 16.15) | `node --test tests/rls/contract-f.rls.mjs` | PASS 15/15 |
| full suite | `pnpm test:ci` | **1117 pass, 1 fail, 7 skipped**, 1177s |
| release verification | `pnpm release:verify` | **FAIL** at stage `registry:performance` |

## The two baseline failures are BOTH frozen performance budgets on a 2-vCPU host

1. `tests/performance/registry-cold-import.perf.mjs`
   `AssertionError: cold import elapsed 6740 ms exceeds budget 5000 ms on linux`
   (SPEC-003 section 5.1.11; re-run gave 6741 ms and 7395 ms)

2. `tests/router/golden/determinism.test.mjs:364`
   `warm benchmark: 100-skill registry, 30 timed resolves, p95 <= 300ms`
   `AssertionError: warm benchmark p95 326.1ms exceeds the 300ms budget`

Both are wall-clock budgets in frozen specs. SPEC-003 and SPEC-004 are marked
`Status: FROZEN` and are gated by `scripts/specs/check-specs.mjs`. Neither failure is
functional: every behavioural test passes.

DECISION: these are recorded as pre-existing, environment-caused baseline failures. The specs
are NOT weakened and the budgets are NOT relaxed to manufacture a green run. They are
re-measured at the end of the session and reported honestly.

CONTEXT CAVEAT: the first `pnpm test:ci` measurement was taken while two subagents were
concurrently building and testing in other worktrees on the same 2-vCPU host, which can only
inflate wall-clock timings. A quiet re-measurement is reported separately at the end.
