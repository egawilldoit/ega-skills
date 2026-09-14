# EGA Skills V2 — Vercel MCP Deployment (private Node application)

Target: MCP Client → HTTPS → Vercel Node runtime (`/mcp`, `/healthz`,
`/readyz`) → existing hardened hosted MCP handler → Supabase
authentication/context → one immutable verified HubRelease.

The application remains read-only, authenticated, fail-closed, and
stateless from Vercel's point of view (safe under cold starts, safe across
multiple instances). No request depends on durable local mutation.

## Entrypoint

`packages/mcp/server.ts` is the Vercel Node server entrypoint. Vercel
detects `server.{js,cjs,mjs,ts,cts,mts}` at the Project Root Directory and
turns it into a Function via the `server.listen()` call. Do not confuse it
with `packages/mcp/src/server.ts` (the local stdio MCP server — not
deployed). The Root Directory `server.ts` takes detector precedence; the
`src/server.ts` stdio module never calls `listen()` and is never deployed.

Shared construction lives in `packages/mcp/src/hosted-runtime.ts` and is
used by BOTH `bin/ega-mcp-hosted.mjs` (local smoke) and `server.ts`, so
there is exactly one authorization implementation. HTTP plumbing is
intentionally NOT shared: the local smoke adapter keeps its exact
historical behavior (including `/healthz` returning 503 before readiness),
while the Vercel adapter implements the deployment contract below.

HTTP routing/bridging lives in `packages/mcp/src/vercel-adapter.ts`:

- `GET /healthz` → `200 {"status":"ok"}` whenever the process is alive
- `GET /readyz` → `200 {"status":"ready"}` only after artifact/auth/policy
  initialization succeeded, else `503`
- `/mcp` → existing authenticated MCP Streamable HTTP behavior (exactly
  `resolve`, `search`, `inspect`, `get_content`)
- unknown paths → controlled `404 {"error":{"code":"E_NOT_FOUND"}}`
- no debugging/configuration endpoints

## Vercel UI configuration (enter AFTER the deployment PR is merged)

Production Branch: `release/2.0`

Root Directory: `packages/mcp`

Application Preset: `Node` (Node.js server detected via `server.ts` +
`server.listen()`)

Install Command: `pnpm install --frozen-lockfile`

Build Command: `pnpm -w build`

Node version: 24 (repo pins `engines.node = 24`, `.nvmrc = 24`,
`packageManager = pnpm@10.0.0`; Vercel 24.x default)

Tick "Include source files outside of the Root Directory in the Build
Step" so workspace dependencies resolve.

No `vercel.json` rewrites are required.

## Environment variables (NAMES only — never commit values)

Required:

- `EGA_HOSTED_ARTIFACT_DIR` — bundled immutable release directory,
  e.g. `./artifact` (see `packages/mcp/artifact/README.md`)
- `EGA_HOSTED_ISSUER`
- `EGA_HOSTED_AUDIENCE`
- `EGA_HOSTED_JWKS_URL`
- `EGA_HOSTED_ALLOWED_ORIGINS` — comma-separated allow-list, non-empty
  (Origin policy stays fail-closed; never `*`)
- `EGA_HOSTED_AUTHZ_JSON` — authorization policy document as inline JSON
  (preferred on Vercel; deterministic precedence over FILE when both set)
- `EGA_HOSTED_SUPABASE_URL`
- `EGA_HOSTED_SUPABASE_SECRET_KEY` — server-side secret (never logged)

Optional:

- `EGA_HOSTED_AUTHZ_FILE` — file path alternative for local/VM usage
  (JSON env wins when both are configured)
- `EGA_HOSTED_BEARER_TOKEN` — local smoke fallback ONLY; do NOT set in the
  real Vercel setup when JWKS auth is configured
- `EGA_HOSTED_REQUIRED_SCOPE` — opt-in token scope check
- `EGA_HOSTED_JWKS_MAX_AGE_MS` — JWKS cache age override
- `EGA_HOSTED_MAX_BODY_BYTES` (default `1048576`)
- `EGA_HOSTED_MAX_RESPONSE_BYTES` (default `4194304`)
- `EGA_HOSTED_REQUEST_TIMEOUT_MS` (default `30000`)
- `EGA_HOSTED_MAX_CONCURRENT_REQUESTS` (default `32`)
- `EGA_HOSTED_MAX_CONNECTIONS` (default `128`)
- `PORT` (default `3000`; local only — Vercel routes via internal port)

The authorization policy uses the SAME schema validation as hosted startup
(`workspace_id`, `visibility`, `owner_subject`, `memberships`, `denies`,
optional `authorized_subjects`/`denied_releases`/`denied_skills`/
`denied_sources`). Malformed JSON or an invalid policy fails startup
(`503`); full policy contents and secrets are never logged.

## Deployment assumptions (verified against official Vercel docs)

- Node server detection: `server.ts` at Root Directory + `server.listen()`
  during module startup; the passed port is local-only.
- Node 24 is GA for Vercel builds and functions; `engines.node` selects it.
- pnpm is detected via repo-root `pnpm-lock.yaml`; `packageManager`
  `pnpm@10.0.0` is honored via corepack; the frozen lockfile is kept.
- TypeScript: Vercel compiles `server.ts` itself; project references and
  path mappings are NOT supported by that compiler, so `server.ts` imports
  only Node builtins plus the already-built `./dist/*.js` output. The
  workspace MUST be compiled first — hence Build Command `pnpm -w build`
  (root `tsc -b`), not Vercel's default.
- Fluid compute: instances are shared concurrently and ephemeral. The
  runtime keeps no request-specific globals, performs no durable local
  writes (startup opens the snapshot `readonly:true`; request reads go
  through `query_only`-locked handles), no runtime git, installs, or
  release generation.
- Streaming: Fluid supports streaming; the adapter pipes Web response
  streams chunk-by-chunk (never `await response.arrayBuffer()` first). The
  four MCP tools run with SDK `responseMode: "json"` (strictly
  non-streaming), so piping is also correct for them.
- Request cancellation is bridged via AbortSignal (client disconnect aborts
  downstream work).
- Limits preserved: max body, timeout, response size, max concurrency +
  max connections, Origin allow-list (fail-closed), JWT/JWKS validation,
  deny policy (release/skill/source), context/release mismatch protection,
  fail-closed startup, no anonymous MCP execution, no wildcard CORS.
  `PORT` and `EGA_HOSTED_MAX_CONNECTIONS` are validated as positive safe
  integers; an invalid value logs one sanitized line and exits non-zero
  instead of binding the wrong port or dropping the connection limit.

## Artifact provisioning

Provisioned and verified in this branch (`sha256:70a37c28…eb3f66`, hub
`personal`, 5 real reviewed upstream skills — no fixtures, no examples):

1. Built out-of-band with the existing Contract C build:
   `node scripts/hosted/build-deployment-artifact.mjs`
   (pins reviewed commits, cross-checks evidence digests, gates on the
   runtime loader; see `packages/mcp/artifact/PROVENANCE.md`).
2. Files live under `packages/mcp/artifact/` (`hub-release.json`,
   `release-package.json`, `registry.sqlite`, `cache/sha256/`), committed
   explicitly (`git add -f`; binary-pinned in `.gitattributes`).
3. Validated: `node scripts/hosted/validate-artifact.mjs
   packages/mcp/artifact` exits 0.

`/readyz` returns `200` only after this exact verification passes at
instance startup.
