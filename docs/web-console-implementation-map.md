# PR #137 — implementation map (requirements → files → verification)

Baseline verified at `feat/web-console`.
Target base `release/2.0`: `7bf0d5a2310ffddbdb4055166be67d56916d8ac6`.
Starting review head: `b5339c2636b1c347f14ac4ea40cef33417c9299f`.
Final head: the PR's current `headRefOid` (read it with `gh pr view 137 --json
headRefOid`; a copied SHA goes stale the moment a commit is added, and one
earlier in this file was already wrong). Code-final commit for the nine
repairs: `f30ffc8663a1e24fe88e0a61fa50ff51abd9823a`.

The earlier-recorded head `f08a542e9c7a7bd393c1859ac2de2d76307747ee` was wrong and
is not used anywhere in this document.

## Verification baseline actually reproduced (not assumed)

Run on the final head `f30ffc8`, each command executed rather than asserted:

| Check | Command | Result |
|---|---|---|
| Domain build | `pnpm exec tsc -b` | PASS |
| Web frontend typecheck | `pnpm --filter @ega-skills/web typecheck` | PASS |
| Web server typecheck | `pnpm --filter @ega-skills/web typecheck:server` | PASS |
| Frozen lockfile | `pnpm install --frozen-lockfile` | PASS, lockfile unchanged |
| Spec/contract check | `pnpm run specs:check` | PASS |
| Full suite | `pnpm test:ci` | **1894/1894 pass, 7 pre-existing skips, exit 0** |
| Contract F RLS (real PG 16) | `node --test tests/rls/contract-f.rls.mjs` | 15/15 |
| Telemetry authorization, containment, retention (real PG 16) | `node --test tests/rls/telemetry-authz.rls.mjs` | 35/35 |
| Cross-workspace isolation (real PG 16) | `node --test tests/web/cross-workspace-isolation.rls.mjs` | 38/38 |
| Executed React component behaviour | `pnpm test:web:components` | 16/16 |
| Analytics window & pagination | `node --test tests/web/analytics-window.test.mjs` | 16/16 |
| Artifact staging | `node scripts/web/stage-artifact.mjs --check-only` | PASS, identity verified |
| Web frontend build from `apps/web` | `pnpm --filter @ega-skills/web build` | PASS |

The 7 skips in `test:ci` are pre-existing and unrelated to this branch.

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
| **R9: MCP Telemetry (CONTRACT-T1)** | **IMPLEMENTED BUT UNPROVEN (runtime)** | Implemented and tested at `f30ffc8`. Migration `202609200001` (table, RLS, purge), `202609200002` (SECURITY DEFINER entry point repairing the revoked `is_active_member`, delegated-OAuth containment, 90-day clamp), `202609200003` (retention schedule). Writer: `createSupabaseTelemetryWriter` with permitted-column projection and idempotent writes; `createSupabaseWorkspaceResolver` attributing both context-bound and context-free (Hub/release) executions through the verified ownership chain, never a zero-UUID or another member's workspace. Isolation: `fireAndForgetTelemetry` contains synchronous throws, passes an `AbortSignal` to the sink, enforces the 250 ms ceiling, and releases queue capacity exactly once. Buffer: bounds on records, in-flight writes, real serialized BYTES, and drop-oldest-first per CONTRACT-T1 §6.4. Diagnostics are live (a getter, not a startup snapshot). `handleAnalyticsUsage` paginates to a verified-empty page with a database-enforced 90-day window and reports `partial` rather than a truncated sum. Writer credential is separated behind `EGA_HOSTED_TELEMETRY_WRITER_KEY` with no fallback to the read key. **Still not proven: E5 runtime.** No live MCP execution against hosted Supabase, so `tool call -> stored event -> analytics number` is unobserved, and telemetry writer credential separation is proven as configuration behaviour but not as an observed provisioned deployment. |
| **R10: Non-Production Mutation Control & Safe Preview Deployment** | **PROVEN** (Code & Staging) / **BLOCKED** (Live Vercel Preview) | Read-only UI surfaces with zero mutation controls; deterministic staging script `scripts/web/stage-artifact.mjs` verifies immutable artifacts without regeneration; all server env vars documented in `.env.example`. Live preview deployment to Vercel remains **BLOCKED** due to missing `VERCEL_*` / Supabase credentials in the environment and absence of an attached Vercel project for `apps/web`. |

## Evidence classes used below

Claims are labelled so a static check is never mistaken for runtime proof:

- **E1 static** — source-text / regex assertion. Useful for a bound that cannot
  otherwise drift; it proves the *statement* is present, not that the behavior runs.
- **E2 local** — executed against a real process, real database, or real module.
- **E3 CI** — executed in required checks on the final SHA.
- **E4 artifact** — verified against the committed immutable release bytes.
- **E5 runtime** — observed in a live deployment against hosted infrastructure.
- **E6 browser** — driven in a real browser.

No claim in this document is E5 or E6. Those require live preview access, which
this environment does not have.

## Remaining Blockers

- **Live Hosted Preview Deployment (blocks E5/E6, therefore blocks READY)**: two
  independent causes. (1) No `VERCEL_*` or Supabase credentials exist in this
  environment. (2) **No Vercel project is attached to `apps/web` at all** — the
  repository's two integrations are `ega-skills-mcp` (`packages/mcp`) and
  `ega-skills-auth` (`packages/oauth-ui`), so even with credentials there is no
  deployment target. Owner action: create a Vercel project rooted at `apps/web`
  and supply preview + first-party Supabase credentials. Nothing may claim live
  acceptance until then.
- **Telemetry runtime proof (E5)**: R9's code is implemented and covered by E2/E3,
  but the chain `MCP tool call -> stored telemetry event -> analytics number` has
  not been observed against hosted Supabase. It stays IMPLEMENTED BUT UNPROVEN.
- **Telemetry writer credential separation (deployment)**: the runtime REFUSES a
  reused or missing writer credential, and that refusal is tested. That a hosted
  deployment has actually been provisioned with two distinct credentials is NOT
  observed here; it requires inspecting a live instance's role grants. See
  `docs/operations/telemetry-writer-credential.md`.
- **Retention schedule activation (E5)**: the purge function is proven against real
  PostgreSQL, and `202609200003` installs a daily idempotent schedule that
  degrades to a NOTICE on an instance without `pg_cron`. The installed schedule has
  NOT been observed executing, because no hosted instance with `pg_cron` was
  reachable. Retention is **configured, not operational**.
