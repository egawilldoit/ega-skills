# Web Console v3 — design implementation record

Branch: `feat/web-console-v3-design` (from `main` at `039e6b3`, plus a merge of
`fix/web-console-api-error-preservation`, PR #161).

This directory holds the visual evidence for the catalog-overview-v3 design
pass. It is a presentation-only change: no route, API client, response
contract, permission gate, or data behaviour moved.

## Branch construction

`main` and PR #161 had diverged (`main` 7 ahead, the fix branch 2 ahead, common
ancestor `c0437cd`). The work branch was created from `origin/main` and the fix
branch was merged with a merge commit (`c42551c`), so both sets of changes are
preserved and nothing was reset or force-pushed. `toApiError` and the strict
`isApiError` guard are present on this branch and are the code path the resource
hook uses (`apps/web/src/api/useApiResource.ts`).

## Route mapping (recorded before editing)

| Route | Page component | Data hook / client | API endpoint | User actions |
| --- | --- | --- | --- | --- |
| `/login` | `LoginPage` | `AuthProvider` → Supabase | — | password sign-in, provider sign-in |
| `/` | `OverviewPage` | `useApiResource` + `useApiClient` | `GET /api/catalog?workspace_id` | view release, browse skills, copy digest, expand technical details |
| `/skills` | `SkillsPage` | `useApiResource` + `useApiClient` | `GET /api/skills` (`q`, facets, `sort`, `limit`, `offset`) | search, filter, category chips, sort, page, open skill |
| `/skills/:skillId` | `SkillDetailPage` | `useApiResource` + `useApiClient` | `GET /api/skills/:id`, `GET /api/skills/:id/content?level=` | load L1/L2, inspect companion file, close viewer |
| `/discovery` | `DiscoveryPage` | `useApiResource` + `useApiClient` | `GET /api/discovery` | inspect pinned intent report (deep link, not in nav) |
| `/releases` | `ReleasesPage` | `useApiResource` + `useApiClient` | `GET /api/releases` | open release, open comparison |
| `/releases/:digest` | `ReleaseDetailPage` | `useApiResource` + `useApiClient` | `GET /api/releases/:digest` | read identity, notice, immutable artifacts |
| `/releases/compare` | `ReleaseComparePage` | `useApiResource` + `useApiClient` | `GET /api/releases/compare?base&candidate` | submit comparison, read diff |
| `/projects` | `ProjectsPage` | `useApiResource` + `useApiClient` | `GET /api/projects` | open project |
| `/projects/:projectId` | `ProjectDetailPage` | `useApiResource` + `useApiClient` | `GET /api/projects/:id` | read identity and pinned context per context |
| `/workspace` | `WorkspaceOverviewPage` | `useApiResource` + `useWorkspace` | `GET /api/workspace` | read identity, role, read path |
| `/workspace/members` | `MembersPage` | `useApiResource` + `useApiClient` | `GET /api/workspace/members` | read roster |
| `/workspace/quotas` | `QuotasPage` | `useApiResource` + `useApiClient` | `GET /api/workspace/quotas` | read policy and usage windows |
| `/workspace/security` | `SecurityPage` | `useApiResource` + `useApiClient` | `GET /api/workspace/security/denies` | read recorded denies |
| `/analytics` | `UsagePage` | `useApiResource` + `useApiClient` | `GET /api/analytics/usage?workspace_id` | read quota rollup, telemetry funnel, daily chart, windows |
| `/audit` | `AuditPage` | `useApiResource` + `useApiClient` | `GET /api/audit` (date, actor, operation, target, result) | filter, clear filters, read events |
| `/settings` | `SettingsPage` | `useAuth` + `useWorkspace` | — | read session/build/workspace diagnostics |
| `*` | `NotFoundPage` | `useLocation` | — | return to the console root |

Preserved throughout: URL parameters and deep links, browser back/forward,
workspace scoping (`workspace_id`), permission gating (`RequireSession`,
`RequirePermission`, `visibleNavSections`), search/filter/pagination state,
content retrieval, real counts, release digests, provenance and the truthful
unavailable/permission states.

## Route coverage checklist

- [x] `/login` — sign-in, unavailable-configuration state
- [x] `/` — catalog overview
- [x] `/skills` — search, facets, sort, paging, empty results
- [x] `/skills/:skillId` — identity, token budgets, L1/L2 viewer, files, sources
- [x] `/discovery` — pinned intent inspection
- [x] `/releases` — release list and single-release history state
- [x] `/releases/:digest` — release identity and artifacts
- [x] `/releases/compare` — comparison form and idle/unavailable states
- [x] `/projects` — project list
- [x] `/projects/:projectId` — project identity and pinned context
- [x] `/workspace` — workspace overview
- [x] `/workspace/members` — roster
- [x] `/workspace/quotas` — policy and usage windows
- [x] `/workspace/security` — recorded denies
- [x] `/analytics` — usage, telemetry, chart
- [x] `/audit` — filters and events
- [x] `/settings` — session, build, workspace diagnostics
- [x] `*` — not found

## How the screenshots were produced

All screenshots are the real SPA rendered by the real code in this branch and,
for every API-backed screen, served by the real BFF (`apps/web/server.mts`) and
the committed release artifact (`packages/mcp/artifact`, 116 skills).

The data plane is Supabase and no live session credential was available in this
environment, so a **local fixture control plane** supplied only the
control-plane tables (`workspace_memberships`, `projects`, `quota_*`,
`audit_events`, `mcp_tool_executions`, …). It is not part of this branch. Every
catalog number, skill row, digest, release identity and instruction body in the
screenshots comes from the committed artifact through the real BFF.

Disclosed limits of this evidence:

- Screens are rendered in a headless Chromium at 1440×900 and 390×844. This is
  observed rendering, not a review of the deployed Console.
- The production dependency `ega-skills-web-console.vercel.app` was inspected.
  It answers `/healthz` and serves the SPA, but its API routes return
  `E_WEB_READ_UNAVAILABLE` because `EGA_SUPABASE_URL` is not configured on that
  deployment. Nothing about telemetry, live membership or hosted reads is
  claimed from it.
- The Usage page is shown with fixture telemetry rows. That the redesigned
  screen renders is not evidence that hosted telemetry is operational.

## Files

`desktop-*.png` — 1440×900 viewport captures of each route.
`mobile-*.png` — 390×844 captures, including the navigation drawer.
