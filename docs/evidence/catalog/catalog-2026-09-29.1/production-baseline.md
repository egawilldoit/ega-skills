# Production baseline (recorded 2026-09-29, before deployment)

- Canonical: https://ega-skills-mcp.vercel.app
- GET /healthz → 200 `{"status":"ok"}`
- GET /readyz → 200 `{"status":"ready"}`
- POST /mcp (anonymous) → 401, `www-authenticate: Bearer resource_metadata="https://ega-skills-mcp.vercel.app/.well-known/oauth-protected-resource"`
- Current production deployment: `ega-skills-idezkq62c-egas-projects-4fb87621.vercel.app`
  - state READY, created 2026-09-27T17:41:11.829Z
  - Git SHA `185b8e3f699623b68a10a605c31a1ccc491d954e`, ref `release/2.0`
- ROLLBACK_DEPLOYMENT (retain): `ega-skills-idezkq62c-egas-projects-4fb87621.vercel.app`
- Production env (keys present, no static token): EGA_HOSTED_ARTIFACT_DIR, ISSUER,
  AUDIENCE, RESOURCE_URL, JWKS_URL, AUTHZ_JSON, ALLOWED_ORIGINS, SUPABASE_URL,
  SUPABASE_SECRET_KEY. (Values encrypted in API output; current /readyz 200 proves
  the running config passes startup validation.)

## Outstanding release-owner actions before/at deployment
1. Activate the merge guard so merging `release/2.0` does not auto-replace production
   (Section 40), or explicitly authorize direct production replacement.
2. Merge PR #119; record FINAL_CATALOG_SHA; run exact-SHA CI.
3. Deploy the exact FINAL_CATALOG_SHA; wait for Ready.
4. Production acceptance: infrastructure, inventory 114, routing smoke,
   Direct MCP, Codex, OpenCode, cross-client parity.
5. Rollback target retained above.
