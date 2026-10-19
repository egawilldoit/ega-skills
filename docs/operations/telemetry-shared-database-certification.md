# Telemetry on the approved shared database: runtime mapping, target certification and shared-safe operation plan

Issue: [EGA-742](https://linear.app/egawilldoit/issue/EGA-742/operator-can-certify-the-approved-shared-database-and-runtime-mapping)
— "Operator can certify the approved shared database and runtime mapping for telemetry".

Status: **CERTIFICATION AND PLAN ONLY — no mutation, no deployment.**
No schema, role, policy, scheduler, credential, deployment or data change was
performed in preparing this document. Every database observation below is a
read-only query; every deployment observation is a read of a public endpoint or
of GitHub deployment metadata.

Delivery boundary for EGA-742: the runtime mapping and the shared-safe operation
scope are recorded **and accepted by the owner**. This document supplies the
recording; acceptance is the owner's remaining step, plus authorization for the
mutations in §11.

Shared-target decision (owner, 2026-10-18/19, recorded on EGA-742 and EGA-725):
one existing Supabase project, `divriwexbijtojjulqtu` (EGA SKILLS, eu-west-1),
classified **SHARED, not disposable**. No second project, no database branching.
Nothing in this plan shortens retention, widens a policy, or purges unrelated
data.

## 1. Runtime mapping (Console, MCP, Auth → Supabase)

| Component | Deployment identity | Source revision | Environment | Supabase target | Classification | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Console (web) production | `dpl_7N4LnFXNcDSwq8yGNFdW2Y9Ek5qU`, alias `ega-skills-web-console.vercel.app` | `f762622cfa7fdcc712b94094626e809f8c847a48` | production | `divriwexbijtojjulqtu` | **MATCH** | `GET /readyz` → `200` verifying release `sha256:3de9177a…` (116 skills, stable); served bundle inlines `https://divriwexbijtojjulqtu.supabase.co`; GitHub commit status `Vercel – ega-skills-web-console` on `f762622…` = success (2026-10-19T07:45:27Z) with that deployment id |
| Console (web) preview | PR #163 preview deployment `74mPxvD8esqCYp9DHQTHH9P7dtRV` | `6bfe774ac07f2642f4a87c07456545575ee5f477` | preview | `divriwexbijtojjulqtu` (owner decision 2026-10-18) | **MATCH (recorded), bundle not re-read here** | Owner decision recorded on this issue; preview deployment recorded by the Vercel check on PR #163. The preview **bundle** was not re-fetched in this session, so the ref is recorded rather than re-observed |
| MCP (hosted) production | `dpl_BJNrmsRuTEN1cbDJHBtnANUrre6G`, alias `ega-skills-mcp.vercel.app` | `7bf0d5a2310ffddbdb4055166be67d56916d8ac6` | production (`release/2.0`) | `divriwexbijtojjulqtu` | **MATCH** | `GET /.well-known/oauth-protected-resource` → `authorization_servers: ["https://divriwexbijtojjulqtu.supabase.co/auth/v1"]`; `GET /healthz` → 200, `GET /readyz` → 200 |
| Auth / OAuth UI | `ega-skills-auth` Vercel project | not re-verified this session | production/preview | `divriwexbijtojjulqtu` | **MATCH (bundle)** | served bundle `/assets/index-DgObURH-.js` inlines `https://divriwexbijtojjulqtu.supabase.co`; source SHA **UNKNOWN** (project is not linked to this repository's GitHub deployments) |
| Database | Supabase project `divriwexbijtojjulqtu` | n/a | shared | itself | **MATCH (single target)** | PostgREST reachable at `https://divriwexbijtojjulqtu.supabase.co`; all three deployments above resolve to this ref |

Still **UNKNOWN** after read-only discovery:

- The MCP deployment's exact environment **variable names/values** (only the
  authorization-server mapping is observable from outside; the Vercel and
  Supabase management APIs are not available in this session).
- The Auth project's source revision and environment list.
- Whether the shared project is the MCP host's *only* target (the OAuth metadata
  proves the auth issuer; a second data source cannot be excluded from outside).

## 2. Read-only database inventory (2026-10-19)

Method: PostgREST queries to `https://divriwexbijtojjulqtu.supabase.co/rest/v1/…`
with the publishable key that the Console already ships to browsers. No secret
key, no service role, no DDL, no write. Values are never printed.

| Object | Observed state | Evidence |
| --- | --- | --- |
| `public.mcp_tool_executions` | **ABSENT** | `GET /rest/v1/mcp_tool_executions?select=*&limit=1` → `404 PGRST205` ("Could not find the table … Perhaps you meant 'public.context_revocations'") |
| `public.audit_events` | present, no anonymous rows | `200 []` (RLS filters to nothing for the anonymous role) |
| `public.security_denies` | present, no anonymous rows | `200 []` |
| `public.hub_releases` | present, no anonymous rows | `200 []` |
| `public.workspace_memberships` | present, not anonymously readable | `401 42501 "permission denied for function has_workspace_role"` |
| `public.quota_policies`, `public.quota_usage` | present, not anonymously readable | same `42501` |
| `public` table list | not enumerable anonymously | `GET /rest/v1/` → `401` (the OpenAPI description is not served to an anonymous caller) |
| `ega_telemetry_writer` role | **UNKNOWN** | role metadata is not reachable through PostgREST |
| `pg_cron` extension and `cron` schema | **UNKNOWN** | same; extension presence requires a database session |
| Applied migration history | **UNKNOWN**, but at least `202609200001` is **not** applied | the absent table is created by that migration |

The `42501` responses are themselves a useful result: the tables exist and their
policies call `private.has_workspace_role`, so the anonymous role is refused by a
function it cannot execute. That is the expected shape for the control-plane
tables, and it confirms the shared project is the live control plane rather than
an empty shell.

## 3. What is implemented versus what is absent

Source state at `f762622` (this branch's base):

**Implemented in the repository**

- Migrations `supabase/migrations/202609200001_contract_t1_telemetry.sql` …
  `202609200005_telemetry_writer_provisioning.sql`.
- Runtime writer: `packages/mcp/src/telemetry-writer.ts` (separate application
  key and dedicated role JWT, bounded body, `return=minimal`, `23505` absorbed as
  a duplicate) and the bounded sink `packages/mcp/src/telemetry.ts`.
- Wiring: `packages/mcp/src/hosted-runtime.ts` imports both and reads
  `EGA_HOSTED_TELEMETRY_ENABLED` as an exact `"true"` comparison.
- Read path: `apps/web/server/governance.ts` (bounded, paginated, 90-day window,
  partial-coverage flag) and `apps/web/src/pages/UsagePage.tsx` plus the daily
  chart.
- Documents: `docs/contracts/CONTRACT-T1-MCP-Usage-Telemetry.md`,
  `docs/operations/telemetry-retention.md`,
  `docs/operations/telemetry-writer-credential.md`.
- Tests: `tests/mcp/telemetry-{config,writer,workspace-attribution}.test.mjs`,
  `tests/rls/telemetry-authz.rls.mjs`, `tests/rls/telemetry-gateway.rls.mjs`,
  `tests/rls/telemetry-scheduler.rls.mjs`, `tests/rls/telemetry-seed.sql`,
  `scripts/testing/telemetry-gateway.mjs`.

**Absent, and this is the runtime gap that gates EGA-725**

At the revision the live MCP host actually runs (`7bf0d5a`, `release/2.0`):

- `packages/mcp/src/telemetry-writer.ts` — **absent**.
- `packages/mcp/src/telemetry.ts` — **absent**.
- `packages/mcp/src/hosted-runtime.ts` — present, with **zero** telemetry
  references (no import, no `EGA_HOSTED_TELEMETRY_ENABLED` read, no wiring).

So the deployed MCP host cannot emit telemetry **at all**, regardless of schema
or credentials. The delta that adds it is 1 539 insertions across seven files:

```
packages/mcp/src/telemetry-writer.ts   269 +++
packages/mcp/src/telemetry.ts          499 ++++++++++++++++++++++++++
packages/mcp/src/hosted-runtime.ts     194 ++++++++++-
packages/mcp/src/hosted-supabase.ts    269 ++++++++++++++-
packages/mcp/src/hosted.ts             255 ++++++++++++++-
packages/mcp/src/index.ts               35 +-
packages/mcp/artifact/discovery-report.json  42 +++
```

The telemetry source commits, oldest first:

| Commit | Date | Subject |
| --- | --- | --- |
| `8535db0` | 2026-10-12 | feat(web-console): … CONTRACT-T1 telemetry and artifact policy |
| `d7bb5e3` | 2026-10-12 | fix(telemetry): repair telemetry RLS, containment and retention with real-PG proof |
| `742ce6a` | 2026-10-12 | feat(telemetry): operational writer, real workspace identity, failure isolation |
| `df8fd04` | 2026-10-12 | fix(telemetry): send the permitted projection; add executed writer tests |
| `2575ce4` | 2026-10-12 | fix(telemetry): real deadlines, byte bounds, dedicated writer key, live diagnostics |
| `8e7a05f` | 2026-10-12 | feat(telemetry): install retention scheduling, and document it honestly |
| `9e59e56` | 2026-10-12 | fix(telemetry): attribute context-free executions to the right workspace |
| `601a6fe` | 2026-10-14 | fix(web): repair telemetry authority and exercise production races |

Later commits in `7bf0d5a..main` also touch the same MCP files but are **not**
telemetry: `a69da44`/`2b81877` (EGA-736 principal-aware context resolver),
`e0b645a` (EGA-718 unscoped live membership), `a5fd4b7` (EGA-755 skill-scoped
live membership), plus web/discovery commits. That overlap is the conflict
surface for any backport (§8).

## 4. Ordered change plan and its actual effects

Each step is additive and idempotent. Nothing here deletes or rewrites existing
rows, and nothing touches a table other than `mcp_tool_executions` and `cron`.

| # | Change | Actual effect |
| --- | --- | --- |
| 1 | Apply `202609200001_contract_t1_telemetry.sql` | Creates `public.mcp_tool_executions` (id identity PK, workspace/subject/tool/release/latency/bytes/result columns, checks and FKs), enables RLS, creates admin/owner and self-read SELECT policies, two time-series indexes, and `public.purge_expired_telemetry(retention_days default 90)`. Grants `SELECT` to `authenticated`; `EXECUTE` on the purge function to `service_role` only |
| 2 | Apply `202609200002_telemetry_authorization_containment.sql` | Repairs three defects of step 1 against real PostgreSQL: the self-read policy stops calling the revoked `private.is_active_member`; the table is added to the delegated-OAuth containment list; `retention_days` is clamped to `[1, 90]`. Additive, does not edit step 1 |
| 3 | Apply `202609200003_telemetry_retention_schedule.sql` | Installs the `ega-telemetry-retention` schedule through `pg_cron` when the extension exists, and **skips with a NOTICE** when it does not, so a platform without scheduling never fails the migration. Retention then has enforcement, not just a bound |
| 4 | Apply `202609200004_telemetry_scheduler_repair.sql` | Forward repair for instances that registered the original invalid registered command (`select service_role.public.purge_expired_telemetry(90)`), replacing it with `select public.purge_expired_telemetry(90);`, idempotently, plus two bootstrap corrections |
| 5 | Apply `202609200005_telemetry_writer_provisioning.sql` | Creates `ega_telemetry_writer` (`NOLOGIN`, non-inheriting) and grants it to `authenticator`; `USAGE` on `public`; `INSERT` only on `mcp_tool_executions`; `USAGE` only on its sequence; `EXECUTE` on the purge function **revoked**; adds an INSERT policy only (no SELECT/UPDATE/DELETE policy for that role) |
| 6 | Enable telemetry on the MCP host | Sets `EGA_HOSTED_TELEMETRY_ENABLED=true` (exact string) plus the writer's application key and signed role JWT. Until this is done the writer path is a no-op, so applying steps 1–5 changes no runtime behaviour |
| 7 | Promote the MCP runtime revision that contains the writer | See §8. Without this, steps 1–6 have no caller |

Steps 6 and 7 are the two changes that produce any write. Until both exist, the
shared database is byte-for-byte unchanged by this plan.

## 5. Least-privilege writer configuration (names only, never values)

| Item | Name | Notes |
| --- | --- | --- |
| Enable flag | `EGA_HOSTED_TELEMETRY_ENABLED` | exact `"true"` comparison; anything else, including `false`, disables the writer path |
| Application key | `EGA_HOSTED_TELEMETRY_API_KEY` | the project publishable key used as the `apikey` header, not as a bearer |
| Writer credential | `EGA_HOSTED_TELEMETRY_WRITER_KEY` | a **signed role JWT** for `ega_telemetry_writer`; signed outside runtime, rotated by the owner |
| Database role | `ega_telemetry_writer` | `NOLOGIN` and non-inheriting; `INSERT` on one table, `USAGE` on one sequence, `EXECUTE` on the purge function revoked |

The runtime never receives a signing key, a service-role key, or `SELECT` on the
event table. The browser never receives any of the three values: they are
unprefixed server variables, and the promotion plan forbids `VITE_`-prefixing a
secret.

## 6. Synthetic verification data: boundary, identity and cleanup

The shared project holds real control-plane rows. Verification rows must be
unmistakable and removable by exact identity:

- **Workspace**: the already-registered workspace
  `e692094d-b89a-4aed-b3be-76876f194db0`. No new hub, no owner-membership change,
  no RLS change.
- **Subject**: a synthetic principal string, `synthetic-<issue>-<run>`, never a
  real `auth.users` id. Attribution must therefore be derivable from the request
  context, which is exactly what `tests/mcp/telemetry-workspace-attribution.test.mjs`
  covers.
- **Event identity**: `execution_id` and `idempotency_key` set to a fresh UUID
  generated for the run, so "exactly one event" is provable by key, not by count
  deltas.
- **Retention rows (EGA-729 only)**: one row with `observed_at = now() - 91 days`
  and one fresh row. Backdating a **retention** row is required by that issue's
  acceptance and is not the fabrication EGA-727 forbids: it does not claim real
  traffic for a day that had none.
- **Cleanup**: `ega_telemetry_writer` is INSERT-only by design, so cleanup is a
  privileged, exactly-scoped `DELETE` of the recorded synthetic keys (or letting
  the 90-day retention remove the aged one naturally). It is never a bulk delete,
  never a truncate, and never a retention-window change. The exact DELETE
  statement is recorded in the comment on EGA-725 before it runs.

## 7. Failure recovery, disable and rollback

| Failure | Recovery | Data impact |
| --- | --- | --- |
| Writer rejects (wrong role/key) | The writer is failure-isolated: the MCP read path continues and increments its failure class. Fix the credential; no schema change | none |
| Telemetry read fails in the console | `governance.ts` reports **unavailable/partial**, never a fabricated zero; the Usage page renders the unavailable state | none |
| Migration step fails mid-chain | Steps are additive and idempotent; re-run the failing file. Nothing is dropped or rewritten | none |
| Scheduler misbehaves | `select cron.unschedule('ega-telemetry-retention');` disables retention without touching rows or the table | none |
| Runtime regression after promotion | Redeploy the previous MCP deployment (immutable deployments; `vercel rollback <previous-deployment-id>`); the pre-writer revision keeps serving reads and simply stops writing telemetry | none |
| Need telemetry off immediately | Set `EGA_HOSTED_TELEMETRY_ENABLED=false` (or unset) and redeploy; the writer path becomes a no-op | none |

No step in this plan requires a destructive rollback. There is no "undo" for
appended rows because there is nothing to undo: the table is append-only and its
retention is bounded.

## 8. Required runtime deployment revision

The live MCP host runs `7bf0d5a` (`release/2.0`), which has no writer (§3). Two
options, in recommended order:

1. **Smallest: a `release/2.0`-based candidate containing the telemetry commits.**
   Backport the eight telemetry commits of §3 onto `release/2.0` (the MCP
   project's production branch) as one reviewed change, then promote that
   revision. Conflict surface is real but bounded: `hosted.ts`,
   `hosted-supabase.ts` and `hosted-runtime.ts` are also touched by the later
   EGA-736/718/755 commits, which must **not** be pulled in silently. The
   resulting SHA becomes the recorded production revision.
2. **Larger: promote `main` (`f762622`).** This also lands the EGA-736/718/755
   membership behavior changes, the discovery/inspection feature and the v3
   console source in the MCP project. This is a broader production change than
   telemetry needs and should not be chosen silently.

Either option is a **production runtime promotion** and therefore needs its own
authorization with a recorded rollback deployment (§11 item 4). This document
does not create the candidate; it names the exact scope so the promotion is a
reviewable unit.

## 9. Local (disposable) verification executed for this certification

Run on `f762622` in this session, against a **fresh, disposable** PostgreSQL 16
cluster with `pg_cron 1.6` (not the shared project, no shared data):

| Suite | Result |
| --- | --- |
| `tests/rls/contract-f.rls.mjs` | **15 passed, 0 failed** |
| `tests/rls/telemetry-authz.rls.mjs` | **52 passed, 0 failed** |
| `tests/rls/telemetry-scheduler.rls.mjs` | **1 passed, 0 failed**, with `SANITIZED_CRON_EVIDENCE {"jobid":4,"runid":1,"username":"postgres","status":"succeeded","start_time":"2026-10-19T08:10:57.882747+00:00","end_time":"2026-10-19T08:10:57.902936+00:00"}` |
| `tests/mcp/telemetry-{config,writer,workspace-attribution}.test.mjs` | **83 passed, 0 failed** |
| `tests/rls/telemetry-gateway.rls.mjs` | **EXTERNAL BLOCKER** — the harness runs `postgrest/postgrest:v13.0.7` and `kong:2.8.1` through Docker, and this session has no usable Docker socket (`permission denied … /var/run/docker.sock`); no local `postgrest`/`kong` binary exists. Prerequisite: Docker socket access or a local PostgREST+Kong pair |

Interpretation: the migration chain, the writer authorization model, and the
retention scheduler are proven **locally**, which is what the repository's own
suites are for. That is explicitly not hosted acceptance: local pg_cron success
does not certify the shared project's scheduler, and the shared project still has
no `mcp_tool_executions` table.

## 10. Compatibility with the existing services

| Existing behaviour | Effect of this plan |
| --- | --- |
| MCP read tools (`resolve`, `search`, `inspect`, `get_content`) | Unaffected. The writer is failure-isolated and bounded; a telemetry failure increments a failure class and does not fail the tool call |
| Console catalog, skills, releases, projects, governance reads | Unaffected. They read different tables; nothing here alters an existing policy, grant or index |
| Console Usage page | Gains data only after telemetry exists. Until then it must keep reporting unavailable/partial, never a zero: that is the current behaviour and this plan does not change it |
| Existing telemetry-off deployments | Remain off. `EGA_HOSTED_TELEMETRY_ENABLED` is opt-in with an exact `"true"` comparison, so a deployment that does not set it behaves exactly as today |
| Console artifact routes and auth | Unaffected; no `VITE_*` value is added or changed by any step |
| Retention policy | The 90-day maximum stays at 90 days. Nothing in this plan shortens it globally to make a test faster |

## 11. Authorization required before each mutation

| # | Action | Why it is gated | Exact authorization needed |
| --- | --- | --- | --- |
| 1 | Apply migrations `202609200001`…`202609200005` to `divriwexbijtojjulqtu` | Schema, role, grant and policy changes on a SHARED production database | Owner approval of this plan and of the ordered statements in §4, applied as one reviewed unit |
| 2 | Confirm or enable `pg_cron` on the shared project | Scheduler activation; the plan skips the schedule when the extension is absent | Owner confirmation of scheduler availability. If unavailable, retention is reported **INACTIVE**, never PASS |
| 3 | Set `EGA_HOSTED_TELEMETRY_ENABLED`, `EGA_HOSTED_TELEMETRY_API_KEY`, `EGA_HOSTED_TELEMETRY_WRITER_KEY` on the MCP production project (`prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG`) | Credentials are owner-reserved and never handled by the agent | Owner enters values in Vercel; the agent never reads or prints them |
| 4 | Promote the MCP runtime revision that contains the writer (§8) | Production runtime promotion; `main` auto-deploys, so the target branch and revision must be chosen deliberately | Owner approval of the option (1 or 2), the resulting SHA, and a recorded rollback deployment |
| 5 | Insert and later delete the synthetic verification rows (§6) | Writes into the shared project's telemetry table | Owner approval of the exact rows and the exactly-scoped cleanup statement, recorded on EGA-725/729 before execution |

Items 1–3 can be prepared and reviewed now. Item 4 needs a source candidate
(§8 option 1) if the owner prefers the smallest promotion. Item 5 only becomes
possible after items 1–4.

## 12. Remaining gaps and next actions

| Gap | Status | Next action |
| --- | --- | --- |
| MCP environment variable names/values | UNKNOWN | Owner reads them in the Vercel project settings; the agent must not |
| Auth project source revision | UNKNOWN | Optional: the project is not linked to this repository's GitHub deployments |
| `ega_telemetry_writer` role presence in the shared project | UNKNOWN | Resolved by step 1 (the migration creates it idempotently) |
| `pg_cron` availability in the shared project | UNKNOWN | Owner confirmation (§11 item 2) |
| Hosted gateway proof (`telemetry-gateway.rls.mjs`) | EXTERNAL BLOCKER (Docker socket) | Run it in an environment with Docker or a local PostgREST+Kong pair |
| Hosted event, count and daily chart (EGA-725/726/727) | NOT RUN | Follows authorization items 1–5 |
| Hosted scheduled retention (EGA-729) | NOT RUN | Follows authorization items 1–2 and the approved synthetic rows |

The single next action for EGA-742 is the owner's acceptance of this mapping and
operation scope, plus a decision on §8 option 1 or 2. Everything else in the
telemetry chain is blocked on that decision, not on further investigation.
