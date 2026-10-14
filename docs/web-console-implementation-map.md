# PR #137 implementation and evidence map

**NOT READY — draft.** Repairs are committed and locally exercised; isolated
hosted/browser acceptance and independent review remain mandatory gates.

Starting reviewed head: `e1a2a21466ae7f7a1a32e0fca3d83f431c7123aa`.
Verified target `release/2.0`: `7bf0d5a2310ffddbdb4055166be67d56916d8ac6`.
Repair commit: `601a6fe0e74099d2f0f2ac9013c1add8635b9616`.
The [PR description](https://github.com/egawilldoit/ega-skills/pull/137) records
the final full head and exact-head CI job links after documentation commits.
[Current-head checks](https://github.com/egawilldoit/ega-skills/pull/137/checks)
are a separate gate from local execution and hosted acceptance. Earlier review
approvals do not cover subsequent changes; self-review is not independent review.

## Requirements and evidence boundaries

| Requirement | Implementation and relevant verification | Scope |
|---|---|---|
| R1 Workspace role/context | Production `workspace/WorkspaceProvider.tsx` filters active current-subject memberships, clears account state, discards superseded responses. Mounted in StrictMode tests with external Auth/Supabase boundaries mocked. Cross-workspace PostgreSQL suite enforces isolation. | Executed component and database evidence; hosted switching open |
| R2 Catalog | Catalog controls, facet counts, sorting and pagination; `tests/web/catalog.test.mjs` | Executed module/API evidence |
| R3 Release integrity | Unpinned/mismatched identity and immutable artifact metadata; release tests and committed artifact verification | Executed module and artifact evidence |
| R4 Release comparison | Retained releases, cross-Hub refusal and digest authorization; release/access-policy tests | Executed module/API evidence |
| R5 Governance | Authenticated control-plane routes, forwarded caller sessions and bounded queries; governance/workspace/project tests | Executed module/API evidence |
| R6 Content viewer | Production `SkillDetailPage` and resource hooks mounted with deferred API responses; A→B navigation, close/reopen, unmount and rejection | Executed component evidence; real-browser acceptance open |
| R7 API decoding | Strict production decoders and API client/route tests reject malformed responses | Executed module/API evidence |
| R8 Artifact access | Authenticated artifact access by default and explicit public-policy configuration; access-policy tests | Executed module/API and database evidence |
| R9 Telemetry | CONTRACT-T1 closed projection; server-derived workspace ownership; delegated containment; 250 ms cancellation; bounded records/in-flight/bytes and drop-oldest; live diagnostics; paginated analytics bounded to 90 days. Writer now uses separate application key and restricted role JWT, INSERT-only RLS and sequence USAGE. | Executed module, database and isolated self-hosted REST evidence; hosted MCP→event→analytics open |
| R10 Preview safety | Deterministic staging of committed release bytes; read-oriented console; deployment build and server typecheck | Local artifact/build evidence; identified isolated preview open |

## Repairs and executed regressions

All code repairs below are in `601a6fe0e74099d2f0f2ac9013c1add8635b9616`.

| Defect | Repair | Executed regression |
|---|---|---|
| Invalid three-part purge call and ambiguous job variable | Minimal fresh-chain corrections in migration 003; additive migration 004 replaces historic commands, verifies operator identity separately, requires visibility of all jobs, and leaves one named job | Real PostgreSQL 16 + pg_cron: seed historic invalid command, repeat setup, execute exact stored SQL as stored role, deny client/writer purge, observe clock-triggered success and row survival |
| INSERT-only writer missing RLS/sequence authority | Additive migration 005 explicitly provisions NOLOGIN/NOINHERIT/NOBYPASSRLS role, INSERT policy, sequence USAGE and authenticator SET ROLE membership; rejects wider effective grants | 52 telemetry database tests: generated ID insertion, authorized observer, checks/FK failures, forbidden reads/mutations/DDL/sequence mutation/purge/unrelated tables/role escape; authenticated/delegated writes denied |
| Custom role JWT incorrectly used as application key | `telemetry-writer.ts` and `hosted-runtime.ts` separate `apikey` from signed role Authorization, reject broad/delegated writer credentials and missing configuration; no read-key fallback | 67 writer/config tests plus real isolated Kong/PostgREST integration with JWT signature verification |
| Conflict-resolution request incompatible with INSERT-only role | Plain `return=minimal` INSERT; absorb SQLSTATE 23505 only; foreign-key conflict remains failure; body parsing shares bounded cancellation | Real REST insert/retry and invalid-workspace failure; executed stalled-body deadline test |
| Test-local race implementations | Replace Switcher/ContentViewer helpers with mounted production WorkspaceProvider, WorkspaceOverviewPage and SkillDetailPage; mock external boundaries only | 18 jsdom tests. Removing production provider cancellation guard caused account-switch and sign-out tests to fail (2 failures); restoring it returned 18 passes |
| Overstated evidence/readiness | Rewrite implementation map and both runbooks, add separate application-key environment example; CI runs scheduler and gateway in its existing PostgreSQL job | Exact executed results below; isolated hosted/browser and independent review explicitly outstanding |

## Verification

See the [acceptance record](operations/web-console-pr137-acceptance.md) for commands,
sanitized job/run identifiers, skips and external prerequisites. Local results:

- Domain/frontend/server typechecks and clean domain/frontend build: PASS.
- Frozen-lockfile installation, unchanged lockfile, frozen specifications,
  contract A/B/C/G checks, artifact validation/staging and whitespace check: PASS.
- Production components: **18 passed**, jsdom; no real-browser acceptance claim.
- Web API/module integration: **375 passed**, no skips.
- Writer/configuration: **67 passed**, no skips.
- PostgreSQL cross-workspace isolation **38 passed**; Contract F **15 passed**;
  telemetry authorization/retention/writer **52 passed**, no skips.
- Real pg_cron scheduler **1 passed**, no skips; real isolated REST gateway
  **1 passed**, no skips. CI executes these in the existing eight core jobs.
- Foundation/performance and final-head CI results are recorded in the linked
  acceptance record and PR after execution; earlier-head green checks are not
  substitutes for final-head checks.

## Retention state by environment

| Claim | Disposable local PostgreSQL / CI harness | Hosted isolated Supabase |
|---|---|---|
| Purge implementation | Executed with expired/recent rows and 90-day bound | Not exercised here |
| Scheduler configuration | Correct stored command and maintenance username verified | Forward repair available; not applied here |
| Schedule installation | Exactly one active daily job inspected in isolated test DB | Unobserved |
| Scheduler execution | Clock-triggered `succeeded` run and expired-row deletion observed | Unobserved |

Without installed/preloaded pg_cron, setup explicitly reports **INACTIVE**. It
must never be described as installed or operational in that state.

## Hosted/browser/review gates

Connector metadata was refreshed read-only on 2026-10-14. Supabase organization
`EGA MCPS` (`wjaleuflynupwrwclhsu`) exposes project `EGA SKILLS`
(`divriwexbijtojjulqtu`) with **zero development branches**. This project is not
verified isolated and was not changed. On the matching Vercel team
`ega's projects` (`team_e2x4kf12yL43qmBIs2t2YaD2`, Hobby plan), metadata exposes
only the unrelated `ega-house-platform` GitHub project; the other linked Vercel
accounts expose unrelated repositories. No `ega-skills` console project,
candidate deployment, or `apps/web` root is available. No migrations, settings,
or project links were changed.

The collaborative browser's `preview_status` and `preview_open` calls both
returned `Authentication required`; no real-browser session or browser evidence
was available in this run. This is separate from the executed jsdom component
suite. Hosted acceptance remains blocked on a verified isolated console and
Supabase target, plus browser access.

Owner/operator next actions:

1. Identify the already authorized isolated console preview and Supabase project
   or branch; verify deployed full SHA and both SPA/BFF routes.
2. Apply the migration chain there, configure project-trusted short-lived writer
   JWT and separate application key, and observe hosted REST persistence/denials
   plus runtime diagnostics. Keep signing keys outside runtime.
3. Run hosted Auth login→membership→dashboard, delayed account/workspace switching,
   production viewer navigation/cancellation, MCP→attributed event→analytics,
   writer-failure independence and delegated/cross-workspace containment.
4. Observe that isolated project's retention job installation and successful
   scheduler-triggered execution with sanitized run identifiers.
5. Obtain the required independent reviews on the final candidate. This repair
   pass and its self-review do not satisfy independent approval.

Independent review briefs are prepared in the acceptance record. No review or
review request for the current full head is recorded; prior approvals do not
cover subsequent commits.

No production deployment, production migration, merge or readiness promotion
occurred. Keep the PR draft and **NOT READY** while these gates remain open.
