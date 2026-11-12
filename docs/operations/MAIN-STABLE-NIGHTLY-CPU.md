# EGA Skills — main, stable/nightly, and Vercel CPU

Status: **proposal / safe pilot only**. This document does not authorize production traffic changes or bypass issue #168.

## Source and deployment model

One GitHub monorepo (`egawilldoit/ega-skills`), three existing Vercel projects:

| Project | Directory | Intended production source |
| --- | --- | --- |
| `ega-skills-auth` | `packages/oauth-ui` | `main` |
| `ega-skills-web-console` | `apps/web` | `main` |
| `ega-skills-mcp` | `packages/mcp` | `main` |

**Stable** means a previously tested, pinned `main` commit, with exact HubRelease digest and three separately verified deployment IDs, manually promoted to the production domains. **Nightly** means an opt-in protected preview of a pinned `main` commit. Neither channel requires a permanent divergent Git branch or extra Vercel projects. Label releases `vX.Y.Z` and `vX.Y.Z-nightly.YYYYMMDD.N`; a label is not proof of live publication.

Do **not** switch Auth or MCP from `release/2.0` while the 117 → 126 skill publication, legacy readiness migration and PR #176 remain unresolved. Keep the currently working production alias and OAuth flow unchanged until a verified cutover is approved.

## First CPU pilot: Web Console assets

The console is a Vite SPA plus a Node BFF (`apps/web/server.mts`). Historically, its `vercel.json` forwarded all requests to the Node function, including immutable `/assets/*`. A future routing change should publish Vite's fingerprinted assets as Vercel CDN static output, with the same cache lifetime as the existing handler. `/api/*`, `/healthz`, `/readyz`, and SPA deep links remain on the Node fallback. No auth, catalog, or release runtime logic changes.

**2026-10-30 preview result: unsafe CDN route reverted.** A draft pilot on this branch added `@vercel/static` for `dist/assets/**` and rewrote `/assets/*` to `/dist/assets/*`. The preview deployment was READY and HTML, `/healthz`, API and SPA deep links worked, but its generated JS and CSS returned **HTTP 404**. The changes to `apps/web/vercel.json`, the added regression test, and the CI test hook were reverted before this PR is considered for merge. This document is now a plan only; it does **not** claim reduced CPU. A future implementation must prove that Vite output is deployed as real static output (e.g. a reviewed Build Output API approach), then retest live asset delivery and Function invocations.

**Build concern to verify:** generated `dist/assets/**` must actually exist when the Vercel static builder collects source files. A passing JSON contract test is insufficient; if the build process produces assets too late for `@vercel/static`, rework the build-output delivery before merging rather than silently falling back to a function.

Before merging a future CDN optimization PR, inspect its preview deployment and verify:
1. The Vite bundle builds and a real hashed `/assets/*.js` and `/assets/*.css` respond 200 with correct bytes, types, security headers and immutable caching.
2. Static requests are served by Vercel's static infrastructure, **not by the Node function** (compare function invocations/logs against a controlled request set; response headers alone do not prove this).
3. `/`, a deep link, `/api/no-such-view`, `/healthz`, and `/readyz` preserve the prior behavior; unknown write methods remain rejected, and traversal cannot expose server files.
4. Existing test suites and deployment build checks pass on the exact PR head.

Do not merge this optimization if the preview fails any of these.

## Runtime CPU baseline and improvements

For the `egas-projects-4fb87621` team, open [Vercel Usage](https://vercel.com/egas-projects-4fb87621/~/usage), select each of the three EGA Skills projects, and inspect **Vercel Functions → Fluid Active CPU**, **Invocations**, and **Provisioned Memory** (labels may vary). Save screenshots or available CSV exports with project, UTC time window, units and date. If Usage has no accessible per-project CPU metric, try the supported `vercel metrics vercel.function_invocation.function_cpu_time_ms --project <project> --since 7d --prod` command **only if the account permits it**; Vercel Query/Observability Plus may require an unavailable paid entitlement. Record `unavailable` rather than inventing a zero baseline or purchasing an upgrade. Capture comparable seven-day windows before and after, normalized to request counts as well as absolute usage; never claim a CPU percentage without measured data.

Priority after the asset pilot:
- **Web:** static CDN assets first; consider CDN HTML delivery only if it preserves SPA routes, no-store API responses, and method restrictions.
- **Auth:** already Vite static; do not add a server or new service. Avoid unnecessary deployments.
- **MCP:** profile initialization and the most expensive real handlers before changing caching. Never publicly cache OAuth tokens, authenticated content, or per-user results.

For monorepo builds, configure each existing Vercel project's **Root Directory → Skip deployment** feature for unaffected projects when Vercel recognizes the pnpm workspace dependency graph. Verify the shared workspace packages trigger all affected projects. This reduces **build** usage, not automatically Function Active CPU.

## Safe cutover to main

1. Finish and verify the existing issue #168 release under its separately approved publication policy; retain predecessor deployments, immutable artifacts and rollback receipts. **This plan does not relax the existing MCP gates** in [RELEASE-2.0-HANDOFF.md](./RELEASE-2.0-HANDOFF.md) or [RELEASE-2.0-RUNBOOK.md](./RELEASE-2.0-RUNBOOK.md).
2. Record each project's canonical production domain, **all** reachable aliases, current deployment ID, source SHA, release/artifact identity, environment, root directory, branch, authorized publisher identity and rollback deployment. Save evidence outside the repo.
3. Before any deployment or branch switch, identify the **approved single publisher** and obtain fresh, independently verified single-writer/access-control evidence. Verify effective Git auto-deployment suppression from the configuration Vercel actually loads, including a behavior test; re-read the live control immediately before publishing. For MCP, the existing `git.deploymentEnabled` read-back, canonical alias, successful deployment-check and publisher-identity gates remain binding **unless a separately reviewed and owner-approved equivalent policy replaces them**. Unknown API fields, additional production aliases, or absent checks do not count as success. Apply the same independently documented equivalent safeguards to Auth and Web. Stop if any gate cannot be proven.
4. Only for a separately authorized future stable release, disable **Auto-assign Custom Production Domains**, build all three staged production deployments from the same reviewed `main` SHA and verify each immutable deployment, source digest, package artifact and read-only readiness result before any promotion. Ensure that each *intermediate* mixed-version state is compatible, especially OAuth sign-in and authenticated MCP tools. A successful preview build alone is not acceptance.
5. Following the reviewed cross-project release policy, promote **Auth → Web Console → MCP** one at a time (never in parallel). Immediately before **each** promotion, re-check the approved publisher, single-writer lease, live alias ownership, deployment checks or explicitly approved durable stage-acceptance alternative, expected predecessor, and exact candidate identity. Immediately afterward, verify the canonical domain, OAuth/MCP smoke where applicable, release SHA and digest; write a durable project/deployment-specific receipt. **On any mismatch or failed promotion, stop all further promotions, restore every already-promoted project in reverse order to its individually recorded predecessor using the authorized rollback procedure, and independently verify the restored aliases and functionality.** Do not resume until the partial operation is reconciled and separately authorized. Vercel's manually promoted deployments are not atomic across projects.
6. After issue #168 is closed and the cutover is approved, move Auth and MCP production branch tracking to `main`; Web already tracks `main`. Keep nightly as a protected opt-in preview with pinned SHA and no stable domain assignment. Do not create another permanent release branch. Retire `release/2.0` **push triggers from both** repository-owned workflows, `.github/workflows/ci.yml` (CI) and `.github/workflows/hashing-traversal.yml` (Hashing traversal verification), in a later reviewed PR; preserve normal `main`/PR checks, historical tags, deployment identities, and release evidence.

**No new Redis, database, paid tier, release service, or additional Vercel project.** If the current guarded publisher controls production mutation, the cutover must be approved and coordinated with it; Vercel's built-in promotion is not a silent override of the old policy.

References:
- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/monorepos
- https://vercel.com/docs/deployments/promoting-a-deployment
- https://vercel.com/docs/functions/usage-and-pricing
- https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml
