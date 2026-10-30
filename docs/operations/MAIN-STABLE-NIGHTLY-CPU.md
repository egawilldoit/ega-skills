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

The console is a Vite SPA plus a Node BFF (`apps/web/server.mts`). Historically, its `vercel.json` forwarded all requests to the Node function, including immutable `/assets/*`. The proposed routing publishes Vite's fingerprinted assets through `@vercel/static` and serves them from the CDN, with the same cache lifetime as the existing handler. `/api/*`, `/healthz`, `/readyz`, and SPA deep links remain on the Node fallback. No auth, catalog, or release runtime logic changes.

**Build concern to verify:** generated `dist/assets/**` must actually exist when the Vercel static builder collects source files. A passing JSON contract test is insufficient; if the build process produces assets too late for `@vercel/static`, rework the build-output delivery before merging rather than silently falling back to a function.

Before merging, inspect the preview deployment and verify:
1. The Vite bundle builds and a real hashed `/assets/*.js` and `/assets/*.css` respond 200 with correct bytes, types, security headers and immutable caching.
2. Static requests are served by Vercel's static infrastructure, **not by the Node function** (compare function invocations/logs against a controlled request set; response headers alone do not prove this).
3. `/`, a deep link, `/api/no-such-view`, `/healthz`, and `/readyz` preserve the prior behavior; unknown write methods remain rejected, and traversal cannot expose server files.
4. Existing test suites and deployment build checks pass on the exact PR head.

Do not merge this optimization if the preview fails any of these.

## Runtime CPU baseline and improvements

Measure per project using Vercel Usage → **Functions → Fluid Active CPU**, together with Function Invocations and Provisioned Memory. Collect equivalent seven-day windows before and after, and compare CPU per request as well as absolute CPU. Hobby may not expose paid Query/Observability Plus metrics; do not purchase a plan just for this work.

Priority after the asset pilot:
- **Web:** static CDN assets first; consider CDN HTML delivery only if it preserves SPA routes, no-store API responses, and method restrictions.
- **Auth:** already Vite static; do not add a server or new service. Avoid unnecessary deployments.
- **MCP:** profile initialization and the most expensive real handlers before changing caching. Never publicly cache OAuth tokens, authenticated content, or per-user results.

For monorepo builds, configure each existing Vercel project's **Root Directory → Skip deployment** feature for unaffected projects when Vercel recognizes the pnpm workspace dependency graph. Verify the shared workspace packages trigger all affected projects. This reduces **build** usage, not automatically Function Active CPU.

## Safe cutover to main

1. Finish and verify the existing issue #168 release; retain predecessor deployment and rollback evidence.
2. Record current domain-to-deployment mapping, environment variables, project root directory and active branch for **each** project.
3. For the next release, disable **Auto-assign Custom Production Domains** on each project's Production environment. Test a staged production build from a reviewed main SHA and verify its exact release/artifact identity.
4. Move Auth and MCP production branch tracking to `main` only with an agreed cutover; Web already tracks `main`. No unrelated branch or Git source switching. Enable protected preview/nightly builds from main SHAs without production domains.
5. Independently smoke-test all three services and OAuth/MCP integration, promote stable manually, then prove rollback. Keep the three project URLs and deployment IDs in the release record.
6. Retire the perpetual `release/2.0` workflow only after all services are stable on this model. Preserve historical tags and evidence.

**No new Redis, database, paid tier, release service, or additional Vercel project.** If the current guarded publisher controls production mutation, the cutover must be approved and coordinated with it; Vercel's built-in promotion is not a silent override of the old policy.

References:
- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/monorepos
- https://vercel.com/docs/deployments/promoting-a-deployment
- https://vercel.com/docs/functions/usage-and-pricing
- https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml
