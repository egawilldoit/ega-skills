# PR #137 repair acceptance record — 2026-10-14

Starting head `e1a2a21466ae7f7a1a32e0fca3d83f431c7123aa` and target base
`7bf0d5a2310ffddbdb4055166be67d56916d8ac6` were fetched and verified before edits.
Repair commit: `601a6fe0e74099d2f0f2ac9013c1add8635b9616`.
Final documentation head and all eight exact-head core CI job URLs/results are
maintained in [PR #137](https://github.com/egawilldoit/ega-skills/pull/137).
[Current-head CI](https://github.com/egawilldoit/ega-skills/pull/137/checks)
is separate from every local and hosted evidence class below.

## Executed local commands

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile`; `git diff --exit-code -- pnpm-lock.yaml` | PASS; lockfile unchanged |
| `pnpm exec tsc -b --clean`; `pnpm typecheck` | PASS; clean domain outputs rebuilt |
| `pnpm --filter @ega-skills/web typecheck` | PASS |
| `pnpm --filter @ega-skills/web typecheck:server` | PASS |
| `pnpm --filter @ega-skills/web exec tsc -b --clean`; `pnpm --filter @ega-skills/web build` | PASS; immutable artifacts staged/verified, production bundle rebuilt |
| `pnpm test:web:components` | 18 passed; jsdom production component evidence |
| CI's explicit `node --test tests/web/...` API/module command | 375 passed, 0 failures/skips |
| `node --test tests/mcp/telemetry-writer.test.mjs tests/mcp/telemetry-config.test.mjs` | 67 passed, 0 failures/skips |
| `EGA_RLS_DATABASE_URL=<disposable-db> node --test tests/rls/contract-f.rls.mjs tests/web/cross-workspace-isolation.rls.mjs` | 53 passed: 15 Contract F + 38 isolation; 0 skips |
| `EGA_RLS_DATABASE_URL=<disposable-db> node --test tests/rls/telemetry-authz.rls.mjs` | 52 passed, 0 failures/skips; explicit inactive pg_cron path and actual writer authority |
| `EGA_PGCRON_DATABASE_URL=<disposable-cron-db> node --test tests/rls/telemetry-scheduler.rls.mjs` | 1 passed, 0 skips; real pg_cron scheduling |
| `EGA_PGCRON_DATABASE_URL=<disposable-cron-db> node scripts/testing/telemetry-gateway.mjs` | 1 passed, 0 skips; real isolated Kong/PostgREST/PostgreSQL |
| `pnpm specs:check`; `pnpm contracts:check-a`; `pnpm contracts:check-b`; `pnpm contracts:check-c`; `pnpm contracts:check-g` | PASS; frozen contracts unchanged |
| `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact`; `node scripts/web/stage-artifact.mjs --check-only` | PASS; 116 skills and committed release/SQLite identities verified. Runtime readiness explicitly NOT-CHECKED |
| `git diff --check` | PASS |

Full foundation suite totals and final-head CI links are recorded in the PR
description after completion. `pnpm test:perf:registry` passed on repeat: cold
import 4.063 s against the 5 s Linux budget (1 passed, no skips). It initially
failed at 6.294 s while large suites ran concurrently; that failed observation
is retained here rather than erased.

## Scheduler evidence — separate configuration, installation and execution

PostgreSQL 16.15 with real pg_cron 1.6.8, disposable local cluster, loopback only:
`jobid=9`, `runid=2`, execution role `postgres`, status **succeeded**,
start `2026-10-14T15:47:43.052045+00:00`, end
`2026-10-14T15:47:43.072662+00:00`.

The test applied the full migration chain, seeded the previous invalid command,
repeated forward repair, inspected exactly one job, executed its exact stored
command as its registered role, proved expired-row deletion/recent-row survival,
and denied anon/authenticated/delegated/writer purge. It then observed a real
clock-triggered successful run after temporarily changing frequency to one
second. The daily `17 3 * * *` schedule was restored.

The exact CI container setup was also exercised locally with `postgres:16`,
`postgresql-16-cron`, preload and background workers. Its observed execution:
`jobid=4`, `runid=1`, role `postgres`, status **succeeded**, start
`2026-10-14T15:53:24.511822+00:00`, end
`2026-10-14T15:53:24.522793+00:00`.

This proves configuration, installation and execution in disposable local
instances. It proves none of those claims for hosted Supabase.

## Dedicated-role and gateway evidence

The actual dedicated role generated an ID using sequence USAGE and inserted
through the applicable INSERT RLS policy. A separately authorized observer
confirmed persistence. Tests denied telemetry reads/update/delete/truncate,
DDL, sequence reads/mutations, unrelated control-plane reads, purge and role
escape, and exercised NOINHERIT authenticator switching. Invalid fields and
workspace foreign keys failed; authenticated/delegated clients could not write.

The production writer executed through isolated **Kong 2.8.1 → PostgREST 13.0.7
→ PostgreSQL**, using an ephemeral application key and signed dedicated-role
JWT in distinct headers. A valid event persisted; invalid key/signature returned
401; reads/mutations/unrelated data/purge and ordinary/delegated writes returned
403. A retry retained one event; a foreign-key conflict remained a failure and
invalid authentication incremented live writer failure statistics.

Official Supabase [API-key](https://supabase.com/docs/guides/getting-started/api-keys)
and [signing-key](https://supabase.com/docs/guides/auth/signing-keys) documentation
supports separate application authentication and externally minted role JWT
Authorization. This protocol implementation has local integration evidence;
it has **no hosted Supabase gateway acceptance evidence** yet.

## Production component evidence and regression sensitivity

Production WorkspaceProvider, WorkspaceOverviewPage and SkillDetailPage were
mounted under StrictMode with deferred external-boundary responses. Tests cover
mixed rosters, absent/inactive current memberships, account switching and
sign-out during loading, stale workspace clearing, selected-workspace requests,
late-response discard, content A→B navigation, close/reopen, unmount and errors.

Mutation experiment: temporarily remove the production provider's cancellation
guard, execute the component suite, observe **2 failures / 16 passes** (account
switch and sign-out), restore the guard, execute again: **18 passes**. No removed
guard remains committed. This is executed component evidence, not real-browser
or hosted Auth acceptance.

## Missing external prerequisites and verdict

Read-only Supabase/Vercel connector metadata did not identify an authorized
isolated console preview or database branch. Available project
`divriwexbijtojjulqtu` has no development branches and is not assumed safe for
writes. No candidate-matching `apps/web` preview was identified. Collaborative
browser automation is available; it is not the blocked prerequisite.

The owner/operator must identify the authorized isolated preview/project, provide
server configuration through the approved secret mechanism, verify deployed SHA,
apply migrations there, run the hosted gateway/Auth/MCP/analytics and real-browser
scenarios, and observe its actual retention scheduler run. Required independent
reviewers must review the final full head separately. Prior approvals do not
cover later commits; self-review is not independent approval.

**NOT READY.** No hosted/browser scenarios are counted as executed or fabricated.
No production writes/deployment, merge or readiness promotion occurred.
