# EGA Skills 2.0 operator runbook

Deployment architecture: `packages/mcp/VERCEL.md` (authoritative). This
runbook does not define a second deployment path; it lists the exact
pre-deployment, deployment, smoke, and rollback checks for the hosted MCP.

Never print or commit secrets. All values below come from the Vercel project
environment (`ega-skills-mcp`, scope `team_e2x4kf12yL43qmBIs2t2YaD2`) or from
short-lived token files with mode 0600.

## Pre-deployment

1. Verify the exact release SHA is green in CI:
   `gh run list --repo egawilldoit/ega-skills --branch release/2.0 --limit 5`
   `gh run view <run-id> --repo egawilldoit/ega-skills`
   Required: Linux PASS, Windows PASS, Contract F PASS, hashing PASS.
2. Verify the candidate artifact and release digest:
   `node scripts/hosted/validate-artifact.mjs <artifact-dir>`
   `cat <artifact-dir>/hub-release.json | jq -r '.release_digest'`
   The digest must equal the digest recorded in
   `docs/evidence/RELEASE-2.0-FINAL.md` and the value production selects.
3. Verify the artifact matches the tested commit:
   `git rev-parse HEAD` equals the CI-verified SHA; the artifact was built
   from this tree with no uncommitted changes (`git status --short` empty).
4. Verify OAuth settings in the Vercel project (`EGA_HOSTED_*` in the target
   environment): `EGA_HOSTED_RESOURCE_URL` and `EGA_HOSTED_AUDIENCE` equal the
   deployed MCP URL + `/mcp`; issuer/JWKS point at the Supabase project;
   `EGA_HOSTED_ALLOWED_ORIGINS` contains only exact HTTPS origins; the
   Supabase secret key is present; static-token mode is absent.
5. Record the previous known-good deployment:
   `vercel ls ega-skills-mcp --scope <team>` — save the deployment URL/ID and
   its `effective_release_digest` before deploying.

## Deployment

Follow `packages/mcp/VERCEL.md`:

- Production Branch `release/2.0`, Root Directory `packages/mcp`,
  Install `pnpm install --frozen-lockfile`, Build `pnpm -w build`,
  Node 24, include files outside root.
- Production deployment is a release-owner action. Preview/staging
  verification uses the same project with preview-scoped environment values
  and must never change the production alias.

## Post-deployment smoke

```
EGA_SMOKE_URL=<origin> \
EGA_SMOKE_BYPASS=<protection-bypass> \        # preview only, never printed
EGA_SMOKE_TOKEN_FILE=<0600 token file> \
node scripts/oauth/hosted-smoke.mjs
```

Checks: `GET /healthz` 200, `GET /readyz` 200 only after verified startup,
OAuth protected-resource metadata on both discovery paths, anonymous `/mcp`
401 with challenge, authenticated `/mcp`, four-tool catalog, controlled
404 for unknown paths and 405 for unsupported discovery methods.

Then the four-tool identity probe:

```
EGA_MCP_TOKEN_FILE=<0600 token file> EGA_MCP_URL=<origin>/mcp \
node scripts/oauth/mcp-probe.mjs
```

Then client smoke: `codex mcp login ega-skills` followed by `codex mcp list`,
and `opencode mcp list`; run one explicit call per tool and compare skill ID,
version hash, and content digest against the direct probe. All clients must
observe the same identity.

## Rollback

Preview proof and the immutable-deployment transcript:
`docs/evidence/2.0-C-STAGING.md` (gate C15); procedure details:
`packages/mcp/VERCEL.md` § "Rollback (immutable deployments)".

1. Identify the previous known-good production deployment ID/URL and its
   release digest (recorded in pre-deployment step 5).
2. Re-point production to it:
   `vercel rollback <deployment-url-or-id> --scope <team>` or
   `vercel promote <deployment-url> --scope <team>`.
3. Re-run the post-deployment smoke against the production origin and confirm
   `/readyz` 200 and the expected `effective_release_digest`.
4. To restore the new release, promote/redeploy its immutable deployment URL
   and repeat the smoke.

## Fail-closed recovery

If `/readyz` reports `503`, the process is alive but startup validation
failed. Diagnose in this order: artifact present and digest-valid; auth
policy JSON present and non-empty; issuer/audience/JWKS configured together;
Supabase URL and secret key configured together; allowed origins non-empty,
HTTPS, wildcard-free. The runtime never falls back to anonymous serving; a
misconfigured deployment serves errors, never partial content.
