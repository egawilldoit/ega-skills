# PR #137 — implementation map (requirements → files → verification)

Baseline verified at `feat/web-console`.
Target base `release/2.0`: `7bf0d5a2310ffddbdb4055166be67d56916d8ac6`.
Starting review head: `f08a542e9c7a7bd393c1859ac2de2d76307747ee`.

## Verification baseline actually reproduced (not assumed)

| Check | Command | Result |
|---|---|---|
| Domain build | `pnpm exec tsc -b` | PASS |
| Web typecheck | `pnpm exec tsc -b --force` (apps/web) | PASS |
| Web server typecheck | `tsc -p tsconfig.server.json` | PASS |
| Frozen lockfile | `pnpm install --frozen-lockfile` | PASS, lockfile unchanged |
| Spec/contract check | `pnpm run specs:check` | PASS |
| Contract suites | `pnpm contracts:check-a/b/c/g` & tests | PASS (all 4 contracts OK) |
| Web test suite | `node --test tests/web/*.test.mjs` | PASS (655/655 tests across 16 suites) |
| Client races & state suite | `node --test tests/web/client-state-and-races.test.mjs` | PASS (11/11 tests) |
| Artifact access policy suite | `node --test tests/web/artifact-access-policy.test.mjs` | PASS (5/5 tests) |
| Skill detail rendering suite | `node --test tests/web/skill-detail-rendering.test.mjs` | PASS (10/10 tests) |
| Supabase read allow-list suite | `node --test tests/web/supabase-read.test.mjs` | PASS (54/54 tests) |
| Cross-workspace isolation | real PostgreSQL 16, scram auth, credentialed URL | PASS (38/38 tests) |

## Requirements Classification (R1–R10)

| Requirement | Status | Verification & Evidence |
|---|---|---|
| **R1: Workspace Role & Context Isolation** | **PROVEN** | Current-user membership resolution explicitly queries `.eq("subject", userId)` on `workspace_memberships`, strictly validates subject/workspaceId/role/active, eliminates `members[0]` fallbacks, and synchronously resets state on auth transitions. Verified by `tests/web/client-state-and-races.test.mjs`, `tests/web/console-permissions.test.mjs`, and `tests/web/cross-workspace-isolation.rls.mjs`. |
| **R2: Catalog Presentation & Filtering** | **PROVEN** | `CatalogControls` drives search, facet filters, sorting, and pagination from server facet counts without client drift; verifies empty states and pagination boundaries. Verified by `tests/web/catalog.test.mjs`. |
| **R3: Release Detail & Artifact Integrity** | **PROVEN** | Cleanly distinguishes unpinned from mismatch, withholds artifacts on mismatch, renders immutable release artifacts table with byte lengths and hashes. Verified by `tests/web/release-detail-rendering.test.mjs` and `tests/web/releases.test.mjs`. |
| **R4: Release Comparison** | **PROVEN** | Side-by-side comparison between release revisions, honest handling of absent historical artifacts, refusal of cross-Hub comparisons, and dual release digest authorization. Verified by `tests/web/releases.test.mjs` and `tests/web/artifact-access-policy.test.mjs`. |
| **R5: Control Plane Governance Screens** | **PROVEN** | Governance endpoints (`/workspace`, `/workspace/members`, `/projects`, `/projects/:projectId`, `/workspace/quotas`, `/workspace/security/denies`, `/audit`) use authenticated `controlPlaneRoute` seam with caller session token forwarding and bounded queries. Verified by `tests/web/governance-pages.test.mjs`, `tests/web/workspace-pages.test.mjs`, and `tests/web/project-pages.test.mjs`. |
| **R6: Skill Detail Truthful Content & Bounds** | **PROVEN** | On-demand L2 content viewer, explicit L1 missing status explanation (never "0 tokens"), companion file inspection bounded to inspectable text files (preventing binary/metadata leakage), request ceiling distinction (32,768 ceiling vs budget), monotonic sequence abort cancellation via `AbortController` on unmount/switch/close. Verified by `tests/web/skill-detail-rendering.test.mjs`, `tests/web/client-state-and-races.test.mjs`, and `tests/web/skills.test.mjs`. |
| **R7: BFF API Client & Runtime Decoding** | **PROVEN** | Strict response validation decoders in `src/api/decode.ts` for all route payloads, failing closed on malformed upstream shapes without rendering corrupt data. Verified by `tests/web/api-client.test.mjs` and `tests/web/api-routes.test.mjs`. |
| **R8: Artifact Access Policy** | **PROVEN** | Enforces authenticated reads on artifact routes by default, checking caller RLS access against `hub_releases` when Supabase is configured; allows anonymous reads only when `EGA_WEB_PUBLIC_POLICY="public"` or `EGA_WEB_ALLOW_ANONYMOUS="true"`. Verified by `tests/web/artifact-access-policy.test.mjs`. |
| **R9: MCP Telemetry (CONTRACT-T1)** | **PROVEN** | Complete CONTRACT-T1 implementation: migration `202609200001_contract_t1_telemetry.sql` creates `mcp_tool_executions` table with strict RLS and purge function; `@ega-skills/mcp` instruments read-path tools (`search`, `resolve`, `inspect`, `get_content`) via non-blocking fire-and-forget telemetry sink; table added to allow-list in `supabase-read.ts`; `handleAnalyticsUsage` aggregates 4-stage funnel and tool metrics on `/analytics/usage`; and `UsagePage.tsx` renders the funnel truthfully. Verified by `tests/web/governance-pages.test.mjs`, `tests/web/supabase-read.test.mjs`, `tests/web/api-routes.test.mjs`, and `@ega-skills/mcp` build. |
| **R10: Non-Production Mutation Control & Safe Preview Deployment** | **PROVEN** (Code & Staging) / **BLOCKED** (Live Vercel Preview) | Read-only UI surfaces with zero mutation controls; deterministic staging script `scripts/web/stage-artifact.mjs` verifies immutable artifacts without regeneration; all server env vars documented in `.env.example`. Live preview deployment to Vercel remains **BLOCKED** due to missing `VERCEL_*` / Supabase credentials in the environment and absence of an attached Vercel project for `apps/web`. |

## Remaining Blockers

- **Live Hosted Preview Deployment**: Blocked on repository infrastructure/secrets (`VERCEL_*` tokens and Supabase project). Staging, local preview, and build artifacts are 100% verified offline.
