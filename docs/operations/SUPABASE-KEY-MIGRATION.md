# Supabase key migration runbook (EGA hosted MCP)

Refs #121.

The EGA hosted MCP currently authenticates to Supabase with a **legacy
`service_role` JWT**. A copy of that credential was found in operator scratch
space and purged. The credential must be made unusable before #121 can close.
This runbook is the ordered procedure for the credential owner to do that.
Nothing here is executed by the code change that accompanies it.

Never print, echo, or log a key value. Verify by behavior (HTTP status codes,
which key class is present) rather than by reading a value into a terminal.

## Scope

| Item | Value |
| --- | --- |
| Supabase project ref | `divriwexbijtojjulqtu` |
| Vercel project | `ega-skills-mcp` (`prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG`) |
| Vercel team scope | `team_e2x4kf12yL43qmBIs2t2YaD2` |
| Supabase URL env var | `EGA_HOSTED_SUPABASE_URL` |
| Supabase secret env var | `EGA_HOSTED_SUPABASE_SECRET_KEY` |

The migration target for the secret key is a modern `sb_secret_...` key. The
legacy `service_role` key is revoked as the final step, not the first.

## Why EGA needs a code change first

`packages/mcp/src/hosted-supabase.ts` sends the secret key on two headers. The
gateway treats them differently by key class, verified against this project:

- Legacy `service_role` JWT: `apikey` alone returns **401**. The key must also
  be on `Authorization: Bearer <key>`.
- Modern `sb_secret_` key: it is an opaque string, not a JWT. Sending it as
  `Authorization: Bearer` makes the gateway parse a non-JWT as a JWT and return
  **401**. It authenticates on `apikey` alone.

The resolver therefore sends `Authorization: Bearer` only when the key is
JWT-shaped, and always sends `apikey`. This preserves current production
behavior exactly and makes the modern key work without a second code change.
Coverage: `tests/mcp/hosted-supabase-key-class.test.mjs`.

## Preconditions checklist

Do not start until every line is true.

- [ ] `READY_FOR_CRYPTOGRAPHIC_REVOCATION` criteria below are satisfied.
- [ ] The consumer matrix in `docs/evidence/121-consumer-matrix.md` has **zero**
      entries with `verified: false`. An unknown consumer blocks revocation.
- [ ] A Supabase personal access token (`sbp_...`) is available to the operator.
      Creating, disabling, and rotating keys all require the Dashboard or the
      Management API. No project-scoped key can perform these operations.
- [ ] You have the Supabase Dashboard open for project `divriwexbijtojjulqtu`.
- [ ] The previous known-good Vercel deployment is recorded
      (`vercel ls ega-skills-mcp --scope team_e2x4kf12yL43qmBIs2t2YaD2`).
- [ ] CI is green on `release/2.0` and this branch's readiness change is merged.
- [ ] The staged signing-key migration (step 9) is scheduled separately and
      does **not** run in the same maintenance window as step 7.

## Step 1 — Create the modern secret key

Dashboard → Settings → API Keys → **Publishable and secret API keys**.

1. If the **Create new API keys** button is present, the project is legacy-only.
   Click it. This adds a publishable and a secret key named `default`. Legacy
   keys keep working; nothing is revoked by this step.
2. Create a **named** secret key for EGA, not `default`, so EGA can be rotated
   independently later. Name it `ega-hosted-mcp`.
3. Record it in a mode-0600 file. Do not paste it into a terminal, a ticket, or
   a commit.

Confirm the key class without printing the value:

```bash
umask 077
# reads the value into the shell but never echoes it
set -a; . /path/to/ega-secret.env; set +a
case "$EGA_NEW_SECRET_KEY" in sb_secret_*) echo "class: modern sb_secret" ;; \
  eyJ*) echo "class: LEGACY JWT - stop" ;; *) echo "class: unrecognized - stop" ;; esac
```

## Step 2 — Update the EGA preview environment

`EGA_HOSTED_SUPABASE_SECRET_KEY` is currently set on the **production target
only**. Preview has no Supabase configuration, so preview cannot verify this
migration until one is added. Add it for preview deliberately:

```bash
vercel env add EGA_HOSTED_SUPABASE_SECRET_KEY preview --scope team_e2x4kf12yL43qmBIs2t2YaD2 < /path/to/ega-secret.env
```

Also confirm `EGA_HOSTED_SUPABASE_URL` exists on preview, and that preview
`EGA_HOSTED_ISSUER` / `EGA_HOSTED_AUDIENCE` / `EGA_HOSTED_JWKS_URL` are set.
Without the full JWT triple the runtime refuses to start, by design.

## Step 3 — Verify on preview

Deploy a preview build and confirm the resolver authenticates. A 401 means the
key or the header path is wrong; a 200 means it is right.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$EGA_HOSTED_SUPABASE_URL/rest/v1/project_contexts?select=id&limit=1" \
  -H "apikey: $EGA_NEW_SECRET_KEY"
# expect 200. Do NOT add an Authorization header.
```

Then exercise the MCP over the preview URL and confirm context resolution works
end to end. A context resolve that returns `E_CONTEXT_UNAVAILABLE` for a
membership you know is active means the key is authenticating but the request
is wrong.

## Step 4 — Production cutover

```bash
vercel env rm EGA_HOSTED_SUPABASE_SECRET_KEY production --yes --scope team_e2x4kf12yL43qmBIs2t2YaD2
vercel env add EGA_HOSTED_SUPABASE_SECRET_KEY production --scope team_e2x4kf12yL43qmBIs2t2YaD2 < /path/to/ega-secret.env
```

Trigger a production redeploy. Removing the variable before adding the new one
avoids ever holding two privileged keys in the same environment. Keep the
legacy key value retrievable until step 7 passes, so the rollback path exists.

Verify production immediately after the deploy with the same curl as step 3,
plus one real MCP request.

## Step 5 — Consumer verification

Re-verify every row of the consumer matrix against the new key. Anything that
cannot be confirmed moves to `verified: false` and **stops** the runbook here.

Also check the consumers the matrix cannot see from this machine:

- Supabase **Edge Functions**: Dashboard → Edge Functions → Secrets. Look for
  `SUPABASE_SECRET_KEYS` / `SUPABASE_PUBLISHABLE_KEYS`. EGA declares no Edge
  Functions, but the project may host others.
- **Database Webhooks and `pg_net`**: these send `Authorization: Bearer` and
  reject non-JWT keys outright. Any webhook calling an EGA-hosted function must
  be edited to send `apikey` instead.
- Any mobile or desktop build already shipped to users.

## Step 6 — Disable legacy API keys (reversible)

Dashboard → Settings → API Keys → **Legacy API Keys** → Disable.

This is reversible: re-enable restores service immediately. That reversibility
is the point — disable, observe for a full business cycle, and only then
continue. Watch hosted MCP error rates and the Supabase logs API for 401s from
an unexpected caller.

## Step 7 — Verify old-key rejection

Only after step 6 has been clean for a full business cycle. Confirm the old
`service_role` JWT no longer authenticates:

```bash
# old key retained in a 0600 file
set -a; . /path/to/legacy-key.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' \
  "$EGA_HOSTED_SUPABASE_URL/rest/v1/project_contexts?select=id&limit=1" \
  -H "apikey: $EGA_OLD_SERVICE_ROLE" -H "authorization: Bearer $EGA_OLD_SERVICE_ROLE"
# expect 401
```

A 200 here means the disable did not take effect. Do not proceed.

Then delete the old key value from every machine and file, and shred the
temporary file.

## Step 8 — Migrate to asymmetric signing keys

Separate, independent migration. The API keys above are not JWTs and never
touched the JWT secret; the access tokens Supabase Auth issues to end users are
still signed with the shared symmetric secret.

Dashboard → Settings → API Keys → **JWT Signing Keys** → Migrate to signing
keys. Supabase performs a zero-downtime staged migration: it issues new keys,
waits for the maximum token lifetime plus clock skew, then retires the old
symmetric key. Do not interrupt it.

EGA verifies end-user tokens against `EGA_HOSTED_JWKS_URL`, which continues to
work across the migration. Confirm after it completes that the JWKS document
contains asymmetric keys (`kty` of `RSA` or `EC`) and that a fresh MCP
authorization still succeeds.

## Step 9 — Final old-signing-key revocation gate

Revoke the old symmetric signing key only after **all** of these hold. This is
the last irreversible step; there is no rollback.

- [ ] Step 7 shows the old `service_role` key returning 401.
- [ ] Step 6 has been clean for a full business cycle with no unexplained 401s.
- [ ] All consumer-matrix rows are `verified: true`.
- [ ] No `pg_net` call or Database Webhook depends on a legacy JWT.
- [ ] No shipped client build holds a legacy `anon` key.
- [ ] The asymmetric signing keys in step 8 are active and verified.
- [ ] The credential owner has explicitly signed off in writing.

## Rollback procedure

Steps 1 through 6 are reversible. Steps 7 through 9 are not, which is why they
come last and are individually gated.

**Rollback at or before step 6** — re-enable legacy API keys in the Dashboard.
Service returns immediately. Then restore the previous value:

```bash
vercel env rm EGA_HOSTED_SUPABASE_SECRET_KEY production --yes --scope team_e2x4kf12yL43qmBIs2t2YaD2
vercel env add EGA_HOSTED_SUPABASE_SECRET_KEY production --scope team_e2x4kf12yL43qmBIs2t2YaD2 < /path/to/legacy-key.env
```

Redeploy and confirm with the apikey+Bearer curl, which must return 200.

**Rollback after step 7** — the old key is unusable, so the only path is to
issue a *new* legacy key in the Dashboard and repeat step 4 with it. Treat the
new key as exposed-by-contact and schedule a fresh rotation.

**Rollback of step 8** — the signing-key migration is managed by Supabase and
cannot be reversed from the project side. Do not start it without a maintenance
window and a verified JWKS read path.

**Rollback of step 9** — not possible. Revoke the old symmetric signing key only
when every checkbox above is true.

## READY_FOR_CRYPTOGRAPHIC_REVOCATION

Revocation of the exposed legacy `service_role` key may proceed only when all of
the following are true. This is the gate #121 is waiting on.

1. The modern `sb_secret_...` key is live on EGA production
   (`EGA_HOSTED_SUPABASE_SECRET_KEY`) and verified by a 200 on the REST probe.
2. Legacy API keys are disabled and have been for a full business cycle.
3. The old `service_role` key is empirically rejected (401), verified with the
   probe in step 7.
4. The consumer matrix has zero unverified entries. No consumer's owner is
   unknown. **Any unknown consumer means revocation does not proceed.**
5. No `pg_net` call, Database Webhook, Edge Function, CI job, or shipped client
   holds a legacy key.
6. Operator-machine sweeps report zero remaining copies of the exposed key.
7. The credential owner has recorded explicit sign-off naming the date, the key
   class revoked, and the verification evidence.

Conditions 4 and 6 are currently **not** met. Condition 4 is blocked by four
Vercel projects whose Supabase key class cannot be determined from this
machine, because the Vercel API returns encrypted envelopes rather than
plaintext. Condition 6 requires a purge and rescan after this branch merges.

## Evidence trail

- Resolver behavior and its tests:
  `packages/mcp/src/hosted-supabase.ts`, `tests/mcp/hosted-supabase-key-class.test.mjs`
- Consumer inventory: `docs/evidence/121-consumer-matrix.md`
- Deployment architecture: `packages/mcp/VERCEL.md`
- Release procedure: `docs/operations/RELEASE-2.0-RUNBOOK.md`

---

## Observed state (2026-09-29)

Recorded so the next operator does not have to re-derive it. **No secret values
appear here.**

### Credential class

The exposed credential is **LEGACY_KEY_A**: a legacy `service_role` JWT
(`HS256`, no `kid`, `iss=supabase`, long-lived expiry). It is **not** a modern
individually-revocable secret key.

### Key-management capability

| Capability | Result |
|---|---|
| Project `/auth/v1/keys` | 404 |
| Project `/auth/v1/apikeys` | 404 |
| Project `/v1/keys` | 404 (`requested path is invalid`) |
| `api.supabase.com` without a personal access token | 401 |
| Personal access token (`sbp_…`) present on this machine | **none found** (searched by name/metadata only) |

**Conclusion:** creating a modern secret key, disabling legacy API keys, and
migrating/revoking signing keys are **Supabase Management API / Dashboard**
operations. They are not reachable from the deployment environment, and no
Supabase personal access token is available here.

### Consumer matrix — the reason revocation is blocked

Supabase privileged keys are configured in **5 Vercel projects**:

| Project | Privileged variable(s) | Same Supabase project? |
|---|---|---|
| `ega-skills-mcp` | `EGA_HOSTED_SUPABASE_SECRET_KEY` | yes (this is the leaked credential) |
| `ega-house-platform` | `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | **unknown** |
| `token-observatory` | `SUPABASE_SECRET_KEY` | **unknown** |
| `glow-content-os` | `SUPABASE_SECRET_KEY` | **unknown** |
| `ai-quota-pool-tracker` | `SUPABASE_SERVICE_ROLE_KEY` | **unknown** |

Additionally, 3 projects hold a Supabase **anon** key (`doittimer`, `dt-v2`,
`ai-quota-pool-tracker`) and 2 hold **publishable** keys only
(`ega-house-platform-server`, `ega-skills-auth`).

Whether the unknown projects point at the **same** Supabase project could not be
established: the Vercel API returns values encrypted, and unrelated projects'
secrets were deliberately **not** decrypted.

That "unknown" is decisive. A legacy `service_role` key is signed by the
project's HS256 JWT signing secret, which also signs the `anon` key. Rotating it
to revoke the exposed JWT would therefore invalidate credentials for **every
consumer of that Supabase project**, and we cannot prove which projects share
it. Under the rule *unknown consumer ⇒ do not revoke globally*, the signing key
must not be rotated.

`READY_FOR_CRYPTOGRAPHIC_REVOCATION` is **not** met. The missing dependency is a
Supabase Management-API personal access token (or Dashboard access) **plus**
positive confirmation of the Supabase project ref for the 4 unknown consumers.

### Code compatibility

`packages/mcp/src/hosted-supabase.ts` previously sent the key on **both**
`apikey` and `Authorization: Bearer`. That is correct for a legacy JWT key but
**wrong for a modern `sb_secret_` key**: the gateway parses whatever arrives on
`Authorization` as a JWT, so an opaque secret key would be rejected with 401.

The resolver is now key-class aware. It tests only the **segment structure**
(three dot-separated base64url segments) and extracts **no claim**, then:

- JWT-shaped key → `apikey` + `Authorization: Bearer` (unchanged legacy behaviour)
- opaque key → `apikey` only

No claim is ever read from the key, so a modern key cannot influence
authorization. Regression tests cover both classes.
