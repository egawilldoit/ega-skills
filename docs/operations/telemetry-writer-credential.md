# Dedicated telemetry writer

CONTRACT-T1 §5 requires a server-only writer authority distinct from runtime-read
credentials. Telemetry failure must not affect tools or readiness (§6).

## Provisioning

Apply the repository migration chain through
`202609200005_telemetry_writer_provisioning.sql` using the authorized migration
operator, first in a disposable or authorized isolated preview database. This
forward migration is reproducible and idempotent. It creates
`ega_telemetry_writer` as NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB, NOCREATEROLE, NOREPLICATION, with no inherited role memberships.
It grants only public-schema USAGE, telemetry-table INSERT and generated-id
sequence USAGE. The INSERT RLS policy applies specifically to this role.
No default table or sequence grants are required.

The trusted server derives workspace and subject from verified execution context,
sanitizes the closed event projection and bounds writes. The database validates
field checks and the workspace foreign key. The INSERT policy trusts possession
of the signed writer-role authority; it does not authenticate browser-supplied
subjects. No browser endpoint accepts event rows or issues writer credentials.

If `authenticator` exists, provisioning requires it to be NOINHERIT and grants
writer-role membership so PostgREST can SET ROLE. Authenticator's ability to
select other legitimate roles is separate from the privileges of the selected
writer role. Neither anon nor authenticated may assume the writer role. The
migration refuses pre-existing writer inheritance, unrelated public-table access,
or broad telemetry privileges, including inherited PUBLIC grants. Resolve such
existing grants explicitly before provisioning; do not add BYPASSRLS.

## Gateway authentication

Supabase distinguishes application authentication from database-role authorization:

- `apikey`: project publishable application key (or a legacy anon key).
- `Authorization: Bearer <DEDICATED_WRITER_JWT>`: a project-trusted signed JWT
  whose `role` is exactly `ega_telemetry_writer`, without a delegated `client_id`.

A minted custom-role JWT is **not** a Supabase API key. See the official
[API key guide](https://supabase.com/docs/guides/getting-started/api-keys) and
[signing-key guide](https://supabase.com/docs/guides/auth/signing-keys).
Provision an existing project-trusted signing mechanism under operator control;
use `supabase gen bearer-jwt --role ega_telemetry_writer` with the required
signing-key setup documented by Supabase. Set a short expiration and rotate
before it expires. Never ship the signing private key or JWT signing secret to
the MCP runtime. The runtime receives only the restricted signed token.

Server-only configuration (placeholders only):

```dotenv
EGA_HOSTED_TELEMETRY_ENABLED=true
EGA_HOSTED_SUPABASE_URL=https://<ISOLATED_PROJECT>.supabase.co
EGA_HOSTED_TELEMETRY_API_KEY=<PROJECT_PUBLISHABLE_KEY_OR_LEGACY_ANON_KEY>
EGA_HOSTED_TELEMETRY_WRITER_KEY=<SIGNED_DEDICATED_WRITER_ROLE_JWT>
EGA_HOSTED_SUPABASE_SECRET_KEY=<SEPARATE_RUNTIME_READ_CREDENTIAL>
```

There is no fallback between writer and runtime-read credentials. Missing or
invalid telemetry configuration disables telemetry with a sanitized diagnostic;
the runtime still starts. Broad `sb_secret_` and service-role writer credentials
are rejected. Local claim inspection catches configuration mistakes; only the
REST gateway's signature validation authenticates a token. The caller's
AbortSignal and the maximum 250 ms write deadline remain enforced.

Plain INSERT with `Prefer: return=minimal` requires no SELECT authority. Do not
use PostgREST conflict-resolution upserts: the isolated integration showed those
require read privilege. A 23505 duplicate-key response is absorbed; other 409
conflicts are failures. Response parsing remains bounded by the write deadline.

## Rotation and verification

Issue a fresh short-lived writer token through the operator-controlled signer,
install it in the isolated server environment, and observe persistence and live
writer diagnostics. Replace the runtime token before its expiry; allow the old
token to expire, or use the signing system's supported revocation procedure.
Project-wide signing-key rotation affects other clients and needs separate
operator authorization. Do not give runtime the signer or a broad service key.

Use the actual writer role to insert a valid synthetic event without supplying
`id`, then confirm it through a separately authorized observer. Verify malformed
fields and invalid workspace references fail. Verify SELECT, UPDATE, DELETE,
TRUNCATE, unrelated control-plane reads and purge execution fail. Verify ordinary
and delegated authenticated sessions cannot insert. Exercise authenticator role
switching separately from role inheritance.

A real isolated hosted REST request must then demonstrate valid persistence,
invalid-key/token rejection and denial of reads/mutations, with observed runtime
diagnostics. Record deployment SHA, project identity and sanitized scenario
results. Do not print tokens or raw response bodies.

## Evidence scope

Executed SQL and request-boundary tests are local evidence. A self-hosted gateway
integration, if executed, is distinct from Supabase hosted acceptance. Hosted
writer authority, hosted persistence and the complete MCP → event → analytics
path remain unproven until tested in an identified isolated preview. See
[implementation map](../web-console-implementation-map.md).

Reproduce isolated REST acceptance after provisioning a disposable loopback
database using `EGA_PGCRON_DATABASE_URL=<disposable-loopback-url> node
scripts/testing/telemetry-gateway.mjs`. It creates temporary Kong/PostgREST
containers and ephemeral credentials, tests signed role switching and denials,
and removes them. It temporarily enables LOGIN on the disposable authenticator
and restores NOLOGIN; never point this harness at an existing application DB.
This verifies the self-hosted protocol path, not hosted Supabase acceptance.
