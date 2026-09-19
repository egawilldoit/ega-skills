# EGA Skills V2 — Vercel MCP Deployment (private Node application)

Target: MCP Client → HTTPS → Vercel Node runtime (`/mcp`, `/healthz`,
`/readyz`) → existing hardened hosted MCP handler → Supabase
authentication/context → one immutable verified HubRelease.

The application remains read-only, authenticated, fail-closed, and
stateless from Vercel's point of view (safe under cold starts, safe across
multiple instances). No request depends on durable local mutation.

## Entrypoint

`packages/mcp/server.mts` is the Vercel Node server entrypoint. Vercel
detects `server.{js,cjs,mjs,ts,cts,mts}` at the Project Root Directory and
turns it into a Function via the `server.listen()` call. The `.mts`
extension forces ES-module semantics no matter which module system the
platform infers, so the entrypoint's `import` statements cannot be
miscompiled. Do not confuse it
with `packages/mcp/src/server.ts` (the local stdio MCP server — not
deployed). The Root Directory `server.mts` takes detector precedence; the
`src/server.ts` stdio module never calls `listen()` and is never deployed.

Shared construction lives in `packages/mcp/src/hosted-runtime.ts` and is
used by BOTH `bin/ega-mcp-hosted.mjs` (local smoke) and `server.mts`, so
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
- `GET /.well-known/oauth-protected-resource` and
  `GET /.well-known/oauth-protected-resource/mcp` → public OAuth Protected
  Resource Metadata (RFC 9728); unsupported methods → `405`
- unknown paths → controlled `404 {"error":{"code":"E_NOT_FOUND"}}`
- no debugging/configuration endpoints

## Vercel UI configuration (enter AFTER the deployment PR is merged)

Production Branch: `release/2.0`

Root Directory: `packages/mcp`

Application Preset: `Node` (Node.js server detected via `server.mts` +
`server.listen()`)

Install Command: `pnpm install --frozen-lockfile`

Build Command: `pnpm -w build`

Node version: 24 (repo pins `engines.node = 24`, `.nvmrc = 24`,
`packageManager = pnpm@10.0.0`; Vercel 24.x default)

Tick "Include source files outside of the Root Directory in the Build
Step" so workspace dependencies resolve.

Bundle contract (the actual committed `packages/mcp/vercel.json`):

- `builds` selects `server.mts` with `@vercel/node` and
  `config.includeFiles: "artifact/**/*"` because the immutable release files
  are never imported by code, so file tracing would otherwise omit them and
  every instance would fail closed at `/readyz`.
- `routes` sends every path to `server.mts`, which then applies the routing
  above. This is the working production configuration; no separate
  `functions` block or dashboard rewrite is used.
- `server.mts` deliberately contains NO static reference to the native
  `.node` binary: a bundle-relative path cannot resolve reliably and the
  require would throw at boot, failing every route. The binding resolves at
  runtime through the package's own relative path; if tracers omit it, the
  first Database construction fails inside the runtime try/catch and the
  server keeps serving fail-closed JSON instead of crashing
  (`tests/mcp/vercel-bundle.test.mjs` guards the absence).
- No install script is needed or allowed (prebuilds ship in the package).
- A relative `EGA_HOSTED_ARTIFACT_DIR` resolves against the process
  working directory first, then against `dist/../artifact`, so both local
  runs and function bundles find the same shipped files.
- Platforms own the socket surface: an invalid `PORT` or
  `EGA_HOSTED_MAX_CONNECTIONS` warns loudly and falls back instead of
  exiting and failing every route.

## Environment variables (NAMES only — never commit values)

Required:

- `EGA_HOSTED_ARTIFACT_DIR` — bundled immutable release directory,
  e.g. `./artifact` (see `packages/mcp/artifact/README.md`)
- `EGA_HOSTED_ISSUER`
- `EGA_HOSTED_AUDIENCE`
- `EGA_HOSTED_JWKS_URL`
- `EGA_HOSTED_RESOURCE_URL` — canonical MCP resource identifier
  (`https://ega-skills-mcp.vercel.app/mcp`). Required whenever JWKS
  authentication is configured; explicit trusted configuration, never
  derived from `Host`/`X-Forwarded-Host`.
- `EGA_HOSTED_ALLOWED_ORIGINS` — comma-separated allow-list of bare origins,
  non-empty (never `*`, never a path/query/fragment/credentials). A missing
  `Origin` (native MCP clients) proceeds to authentication; a present Origin
  must match exactly or the request is `403`.
- `EGA_HOSTED_AUTHZ_JSON` — authorization policy document as inline JSON
  (preferred on Vercel; deterministic precedence over FILE when both set)
- `EGA_HOSTED_SUPABASE_URL`
- `EGA_HOSTED_SUPABASE_SECRET_KEY` — server-side secret (never logged)

Optional:

- `EGA_HOSTED_AUTHORIZATION_SERVERS` — comma-separated OAuth authorization
  server issuers advertised in protected resource metadata; defaults to
  `EGA_HOSTED_ISSUER` (Supabase Auth's AS URL is the project issuer).
- `EGA_HOSTED_OAUTH_SCOPES_SUPPORTED` — optional advertised scopes
  (comma/space separated); omit until the provider's discovery metadata
  confirms the scopes it actually issues.
- `EGA_HOSTED_AUTHZ_FILE` — file path alternative for local/VM usage
  (JSON env wins when both are configured)
- `EGA_HOSTED_BEARER_TOKEN` — local smoke fallback ONLY, and only together
  with `EGA_HOSTED_ALLOW_STATIC_TOKEN=true`; never a production
  authentication mode
- `EGA_HOSTED_REQUIRED_SCOPE` — opt-in token scope check
- `EGA_HOSTED_JWKS_MAX_AGE_MS` — JWKS cache age override
- `EGA_HOSTED_JWKS_REFRESH_COOLDOWN_MS` — minimum interval between forced
  JWKS refreshes triggered by unknown `kid` values (default `30000`)
- `EGA_HOSTED_MAX_BODY_BYTES` (default `1048576`)
- `EGA_HOSTED_MAX_RESPONSE_BYTES` (default `4194304`)
- `EGA_HOSTED_REQUEST_TIMEOUT_MS` (default `30000`)
- `EGA_HOSTED_MAX_CONCURRENT_REQUESTS` (default `32`)
- `EGA_HOSTED_MAX_CONNECTIONS` (default `128`)
- `PORT` (default `3000`; local only — Vercel routes via internal port)

Partial JWT configuration (`EGA_HOSTED_ISSUER`/`AUDIENCE`/`JWKS_URL` set
in any combination other than all three) fails startup closed. Production
must never fall back to a static bearer token.

The authorization policy uses the SAME schema validation as hosted startup
(`workspace_id`, `visibility`, `owner_subject`, `memberships`, `denies`,
optional `authorized_subjects`/`denied_releases`/`denied_skills`/
`denied_sources`). Malformed JSON or an invalid policy fails startup
(`503`); full policy contents and secrets are never logged.

## OAuth 2.1 discovery and human onboarding

The MCP function is the OAuth **resource server**; Supabase Auth remains the
authorization server. The server never stores OAuth refresh tokens and never
runs a custom authorization endpoint.

Status: the resource-server discovery surface is deployed, but **production
OAuth login is still gated** — see "Resource binding" below. The MCP will
accept only the dedicated-resource JWT profile once that profile is enabled
and verified in Supabase.

Target onboarding once the gate is cleared:

```bash
codex mcp add ega-skills \
  --url "https://ega-skills-mcp.vercel.app/mcp" \
  --oauth-client-registration auto
codex mcp login ega-skills
```

No `EGA_ACCESS_TOKEN`, no manually copied JWT, no manual `Authorization` or
`Origin` header, and no Supabase key in the Codex config. The browser login
and consent UI is the separate `packages/oauth-ui` deployment; Supabase
redirects there for `/oauth/consent`.

Anonymous requests to `/mcp` stay `401 E_AUTH_REQUIRED` and now advertise:

```text
WWW-Authenticate: Bearer resource_metadata="https://ega-skills-mcp.vercel.app/.well-known/oauth-protected-resource"
```

Invalid/expired tokens stay `401 E_TOKEN_INVALID` with

```text
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"
```

### Resource binding (dedicated single-resource issuer)

The MCP authorization specification requires the resource server to reject
tokens that were not intended for it (RFC 8707 resource indicators). The
managed Supabase OAuth server accepts, validates, and stores the requested
`resource` for the authorization-code flow, but the current provider does not
forward that value into the signed access JWT:

- Pinned provider source: `supabase/auth` commit
  `2e9ce6c8e46532879ced1c6f9a7acdcde3815ea6` (2026-09-18). `resource` is
  stored on `auth.oauth_authorizations` and checked again at token exchange
  (`handlers.go`), but token generation uses `aud: "authenticated"` and does
  not add a resource claim (`internal/tokens/service.go`). Refresh carries the
  OAuth client identity, not the requested resource.
- The upstream change that would bind the token dynamically, supabase/auth PR
  #2526 ("set JWT aud to resource URI when RFC 8707 resource parameter is
  used"), was closed without merging. The current Custom Access Token Hook
  input has `user_id`, `claims` (including provider-supplied `client_id`), and
  `authentication_method`, but no authorized resource.

The safe design for this deployment is a dedicated single-resource issuer
profile, not a claim invented by the browser. The migration
`20260919090000_oauth_mcp_audience_hook.sql` installs a server-side custom
access-token hook that changes `aud` to the exact canonical resource
`https://ega-skills-mcp.vercel.app/mcp` only when Supabase supplies a non-empty
OAuth `client_id`. First-party sessions retain the provider's ordinary claims,
including `aud: "authenticated"`. The MCP accepts only the exact resource as
its configured JWT audience, while still enforcing issuer, signature, subject,
expiry, and `nbf`.

This is safe only as a dedicated-resource invariant: every delegated OAuth
client in this Supabase project is an EGA Skills MCP client, and no other
protected resource may trust these delegated tokens. DCR cannot choose a
different resource because the hook ignores frontend values and writes one
server-side audience. Refresh reuses the provider's OAuth client identity and
therefore re-enters the same hook. Direct Supabase control-plane access remains
blocked by the restrictive `delegated_oauth_containment` policies whenever
`client_id` is present. A future second resource requires a separate issuer or
a provider/broker that propagates and signs the requested resource.

Enablement is a separate operator action in Supabase Dashboard:
Authentication → Hooks → Custom Access Token → Postgres function,
`public.custom_access_token_hook` (URI
`pg-functions://postgres/public/custom_access_token_hook`). Verify the hook is
enabled before enabling the OAuth server. The provider's current hosted Auth
configuration has no Management API setting documented for this Postgres hook.

The OAuth server remains disabled until the hook is installed, enabled in
Supabase Auth, and verified with a real authorization-code + PKCE exchange and
refresh. The MCP does not advertise `ega:read` or any custom scope: EGA
permissions stay EGA permissions.

Headless/CI use (supported, stable contract):

- A direct first-party Supabase user access JWT retains `aud: "authenticated"`
  for Supabase APIs and is not a production MCP credential. The hosted MCP
  deliberately requires the exact dedicated resource audience, so headless
  clients must use the same OAuth flow (or a separately authorized test
  deployment) rather than bypassing resource binding with a copied JWT.
- The shared literal `EGA_HOSTED_BEARER_TOKEN` exists only for local
  development and deterministic smoke fixtures (`EGA_HOSTED_ALLOW_STATIC_TOKEN`).
  It is not a production authentication option and must never be configured
  on the Vercel project.

## Deployment assumptions (verified against official Vercel docs)

- Node server detection: `server.mts` at Root Directory + `server.listen()`
  during module startup; the passed port is local-only.
- Node 24 is GA for Vercel builds and functions; `engines.node` selects it.
- pnpm is detected via repo-root `pnpm-lock.yaml`; `packageManager`
  `pnpm@10.0.0` is honored via corepack; the frozen lockfile is kept.
- TypeScript: Vercel compiles `server.mts` itself; project references and
  path mappings are NOT supported by that compiler, so `server.mts` imports
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
  max connections, Origin allow-list (missing Origin proceeds to
  authentication; present Origins must match exactly), JWT/JWKS validation,
  deny policy (release/skill/source), context/release mismatch protection,
  fail-closed startup, no anonymous MCP execution, no wildcard CORS.
  `PORT` and `EGA_HOSTED_MAX_CONNECTIONS` are validated as positive safe
  integers; an invalid value logs one sanitized line and falls back to the
  platform-safe default instead of failing every route.

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
