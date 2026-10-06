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
   `cat <artifact-dir>/hub-release.json | jq -r '.digest'`
   The release digest is the top-level `digest` field of `hub-release.json`
   (top-level keys are `digest`, `object_type`, `payload`, `schema_version`).
   Do NOT use `.release_digest` or `.payload.release_digest`: neither exists
   here — `release_digest` is a field of the release *candidate* envelope
   (`candidate.json` / `release-diff.json`), not of the exported release.
   The digest must equal the digest recorded for the active catalog in
   `docs/evidence/catalog/<CATALOG_ID>/` and the value production selects
   (the served `effective_release_digest` reported by the `search` tool).
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

---

# Hard invariants

Learned the hard way during the 2.0.1 / `catalog-2026-09-29.2` cycle. Each of
these prevented or would have prevented a real failure. They are not
advisory.

## Vercel identity

**Never depend on the global CLI auth file for a multi-account VM.**

The Vercel CLI keeps one global credential store per user. A VM hosting more
than one tenant cannot authenticate to both at once; whichever account logged
in last silently becomes the identity every command runs as. That is how a
release stalled with unexplained `403`s from every team-scoped endpoint while
`whoami` reported a healthy, unrelated account.

- Pass an explicit per-project credential for the release: `VERCEL_TOKEN`, plus
  `--token` and `--scope` on every invocation.
- Leave the global store alone. Do not `vercel login` / `vercel logout` to
  switch tenants.
- Do not use `vercel switch` for a release workflow; it mutates global state.
- **Assert identity before acting, not after.** The first command of a session
  must be `whoami` and a scoped project read. If a scoped call returns `403`,
  check *who you are* before concluding the credential is expired — an expired
  token and a wrong-account token look identical from the endpoint.
- Gate every mutation on reading **both** the team and the project. Abort if the
  authenticated identity cannot read both. This makes it impossible to run an
  EGA release command against another tenant's account.

## Merge guard

**Guard activation is its own operation.**

The ignored-build step is consulted asynchronously by the build pipeline.
Setting it and merging in the same command does not take effect in time, and the
merge deploys to production.

1. Set the guard.
2. Read it back.
3. Allow it to propagate.
4. Only then merge.
5. Confirm the merge-window deployment is `CANCELED`/ignored and that the
   canonical alias did not move.
6. Restore the guard to its previous value.

Steps 1–3 in one shell invocation with a short wait is not sufficient. Observed:
~2 minutes plus an intervening command was reliable; immediately adjacent was
not, and cost two unintended production deploys.

## Production-connected branch

**No merge unless all of these hold:**

- expected Vercel identity verified
- expected project readable
- guard readable
- guard state known
- resulting deployment observable

A strict `required_status_checks` policy means every merge invalidates the next
PR's checks. That is correct — it prevents merging untested code against a moved
base. Budget for it: rebase, push, and wait for a full CI cycle per sequential
merge rather than fighting it.

## Preview acceptance

Real OAuth clients are **not** required on a protected preview when the issuer
is intentionally bound to the canonical production resource. A preview behind
deployment protection answers `302` and the application never sees the request,
and a token issuer bound to the production audience will refuse to mint for any
other resource.

- Pre-production: direct protocol acceptance against the artifact.
- Post-production: real Codex/OpenCode acceptance.

Do not distribute a project-wide protection-bypass secret to developer machines
to work around this — it unlocks every protected preview in the project.

## Catalog identity

`release_digest` proves **semantic** catalog identity. It is **not** a hash of
every artifact byte, and it does not cover provenance rows.

A provenance-affecting change can ship with an **unchanged** `release_digest`.
Never verify such a change with the digest alone. Prove it with all three:

1. the exact deployed source SHA
2. the **physical** artifact hash (`registry.sqlite`, and the artifact-tree
   digest — see below)
3. a **runtime invariant** observed through the API

Reproduce the artifact-tree digest from the repository root (path-relative, so
it is stable and not cwd-dependent):

```
find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum
```

`sqlite_artifact_digest` is **build-instance-scoped**, not reproducible: a
wall-clock observation timestamp in the registry makes rebuilds differ. Pin and
hash the exact artifact being promoted; do not present it as reproducible.

## Verifying provenance and content invariants

- Scan **decoded** values, never the JSON-serialized form. Serialization escapes
  newlines as `\n`, so a prose line ending `<letter>:` matches a naive
  `[A-Za-z]:[\\/]` host-path pattern and produces phantom findings. Anchor host
  detection to `/home/`, `/Users/`, `/tmp/`, `/var/task` only.
- Host-path detectors must detect POSIX, Windows drive **and** UNC forms, and
  must work on either CI host OS — a Linux runner must catch a Windows fixture.
  A `process.platform` guard that skips the test on Windows removes exactly the
  case the test exists to prove.
- `validate-artifact.mjs` verifies internal integrity, **not** path hygiene. A
  hand-edited artifact with a rewritten digest still passes. Assert path
  hygiene separately, against the committed artifact.

## Test determinism

- Never bound a wait by iteration count. `200 × 10 ms` is an unmeasured 2 s
  ceiling that fails on loaded hosts while passing on fast CI. Use a monotonic
  deadline sized from measurement, shared through a helper so the next call site
  cannot reintroduce a magic constant.
- Classify paths in diagnostics by **string shape**, not by `process.platform`
  or `path.isAbsolute`. The same test must report the same shape on every
  runner.
- Reproduce a local-only failure at the previous release commit before calling
  it a regression. It is only a regression if the earlier commit passes.

## Client credential handling

**Never persist an OAuth access token or bearer token directly inside an
OpenCode/Codex/MCP client configuration file — including a temporary one.**

A credential belongs in exactly one of:

- an approved credential store, or
- environment-variable injection at invocation time, or
- an isolated ephemeral secret file, mode `0600`, purged at end of cycle.

Client configuration is the worst of the available locations, because it is the
one a human or a template writes by hand, it is easy to leave behind, and it
outlives the round that created it.

> **Observed 2026-09-30, during end-of-cycle cleanup.** An OpenCode MCP config
> left over from an *earlier* round carried a live Supabase access token inline
> in its headers:
>
> ```json
> { "mcp": { "ega-skills": {
>     "headers": { "Authorization": "Bearer eyJhbGciOiJFUzI1NiIs…" } } } }
> ```
>
> It was still readable at cleanup time, weeks after the round that wrote it,
> and it survived a first purge pass that only checked a hand-written file list.
> A client config is evidence; treat it as credential-bearing by default.

Two corollaries that cost real time:

- Isolating a client by copying its auth directory also copies a **live**
  credential. The copy is a second secret with its own expiry obligation. Purge
  every isolated home at end of cycle, not just the credential you used.
- Writing a token into a config to "just test it" is how a token ends up in a
  file nobody remembers creating. Inject it from the environment instead.

## Purge completeness

**Never prove credential cleanup by checking only known filenames.**

The first purge pass in the 2.0.1 cycle enumerated the credentials it knew it
had created and verified each was gone. It reported complete. A follow-up
`find`-based sweep of the same scratch boundary then found **10 more live
credential files** — nine isolated OpenCode auth stores plus the hardcoded bearer
token above. Roughly half the exposure had been missed, and the miss was
invisible because every file on the hand-written list really was absent.

Cleanup proof is five steps, in order:

1. **Delete** the known release credentials — the ones deliberately created.
2. **Recursively scan** the entire release scratch boundary (`/tmp/opencode` and
   every worktree this cycle touched), by discovery rather than by name.
3. **Scan client-specific** auth and config locations: `CODEX_HOME`, XDG data
   and config homes, isolated client homes, `*.credentials.json`, `auth.json`,
   `mcp-auth.json`.
4. **Rescan with secret-shaped patterns** — `vcp_…`, `sb_secret_…`, `sbp_…`,
   `Bearer <40+>`, `access_token`/`refresh_token` assignments, and JWT-shaped
   `eyJ….….…` strings.
5. **Report zero remaining matches**, or an explicit classification of each one.

Candidate locations per sweep: bearer-token patterns; OAuth auth stores; client
config directories; temporary XDG/`CODEX_HOME` directories; `/tmp` release
workspaces; env snapshots; shell-generated credential files.

### Classify before deleting

A pattern match is a *candidate*, not a verdict. Two classes routinely match a
naive scan and must be **kept**, not shredded:

- **Upstream test fixtures.** A cloned repo's own `testdata/`, `hack/test.env`,
  or `example.env` files contain `service_role` keys and fixed JWT test vectors.
  Shredding them corrupts a repo checkout and destroys reproducibility for no
  security gain. Confirm the match is *not* EGA-specific before deleting.
- **Public API specs and docs**, which embed example tokens in schema
  descriptions.

Distinguish them with an EGA-specific probe (`ega-skills`, `ega-skills-mcp`,
the project or account id) rather than a generic `service_role` grep. A generic
grep produces a wall of false positives that trains you to ignore the output.

### On any discovered live credential

**classify → purge → determine revocation requirement → verify absence.**

Revocation is a separate decision from deletion, and the two are routinely
conflated. A deleted secret can still be valid.

- **Long-lived or privileged** (`service_role`, `vcp_…`, Supabase keys, any
  token whose blast radius is unknown): purging local copies is *containment,
  not remediation*. Revocation is mandatory, and where rotation is blocked,
  record it as an open security issue with the blocker named — do not let it
  close as "purged".
- **Expired short-lived user access tokens**: may be documented as
  purged/no-revoke, but **only after expiry is independently established** — read
  the `exp` claim and compare it to the current time. Do not infer expiry from
  the token's nominal TTL, and do not infer it from the fact that the issuing
  session was closed.
- **Scoped, revocable, single-service** tokens: record the issuing authority and
  the revocation path in the evidence document, so a later reader can act
  without re-deriving it.

### Cleanup is not a claim, it is a scan

"Credentials purged" is a statement about the state of a filesystem, and
filesystem state is exactly the thing a list cannot establish. If the proof is a
list, it is not a proof. Re-run the sweep rather than trusting the earlier pass,
and keep the sweep's output as part of the release evidence.
