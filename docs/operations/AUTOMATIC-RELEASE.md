# Automatic production release

Status: **ACTIVE**. This is the only supported production release path for
`ega-skills-mcp`. There is no manual publisher, staging/promote command,
approval envelope, owner attestation, readiness waiver, or publication receipt.
Do not reintroduce a local release script or move the canonical alias by hand.

Architecture reference: `packages/mcp/VERCEL.md`. Verification and recovery
entrypoints: `.github/workflows/verify-release.yml`,
`scripts/release/verify-live.mjs`, `scripts/release/recover-production.mjs`.

## Flow

1. **Reviewed PR.** One PR carries the code, the regenerated catalog/artifact,
   and its checks. Reviewers approve the exact diff; CI must be green on the PR
   head.
2. **Merge to `main`.** Merging is the release decision. Do not merge a PR whose
   artifact or catalog is not the reviewed one.
3. **GitHub CI `ci-gate`.** `.github/workflows/ci.yml` runs the blocking jobs on
   the merge commit and publishes the required `ci-gate` status.
4. **Vercel Git production build.** Vercel builds `main` at that commit with the
   project's Production Branch, Root Directory `packages/mcp`, and workspace
   build settings. The deployment is created but does not receive the canonical
   alias yet.
5. **Vercel Deployment Check.** A Deployment Check named `ci-gate` gates the
   deployment. Vercel holds the canonical alias (`ega-skills-mcp.vercel.app`)
   until the check reports success for the same commit.
6. **Automatic alias.** When the check succeeds, Vercel promotes the deployment
   and the canonical alias moves to it. No operator command runs here.
7. **Release verification.** `.github/workflows/verify-release.yml` runs on the
   Vercel GitHub `deployment_status` event with `state: success` (and on
   demand). It verifies the canonical alias: readiness, the exact release
   digest, 126-skill membership, the 9 TStack skills, and the
   deployment-specific origin. It reports a failure as a failed workflow run.

`READY` is not live. A deployment can be `READY` while the canonical alias still
points at an older deployment, including while `ci-gate` is pending or after a
failed check. CLI builds (`vercel build` / `vercel deploy`) do not move the
canonical alias; only a Vercel Git production deployment that passes its
Deployment Check does.

## Verification configuration

Names only; values live in the GitHub environment/secret store and the Vercel
project. Never print or commit them.

Workflow secrets consumed by `verify-release.yml`:

- `VERCEL_TOKEN`
- `VERCEL_TEAM_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_CANONICAL_ALIAS`
- `VERCEL_BYPASS_TOKEN` (optional Vercel protection bypass; mapped to
  `EGA_VERIFY_BYPASS`)
- `EGA_VERIFY_SUPABASE_URL`
- `EGA_VERIFY_SUPABASE_SECRET_KEY`
- `EGA_VERIFY_USER_EMAIL`
- `EGA_VERIFY_SUBJECT`

The workflow mints a short-lived delegated MCP token with
`scripts/oauth/staging-user-token.mjs` and
`scripts/oauth/mint-delegated-token.mjs`, writes it to a `0600` file under the
runner temp directory, and exports `EGA_VERIFY_TOKEN_FILE`. It never writes a
token to the repository or the log.

The verifier also reads `EGA_VERIFY_ORIGIN`,
`EGA_VERIFY_DEPLOYMENT_URL`, `EGA_VERIFY_TARGET_DEPLOYMENT_ID`,
`EGA_VERIFY_SOURCE_SHA`, `EGA_VERIFY_EXPECTED_MANIFEST`,
`EGA_VERIFY_EXPECTED_PACKAGE`, `EGA_VERIFY_TSTACK_PREFIX`,
`EGA_VERIFY_TIMEOUT_MS`, `EGA_VERIFY_POLL_MS`, and `VERCEL_API_BASE`.
`scripts/release/recover-production.mjs` reads the same Vercel values plus
`EGA_VERIFY_BYPASS`.

## Verification and recovery

`verify-live.mjs` exit codes:

| Exit | Meaning |
| ---: | --- |
| `0` | Canonical alias serves the expected release and all invariants passed. |
| `2` | Configuration or authentication problem; nothing was promoted. |
| `3` | The target is not the canonical deployment, or `ci-gate` is not successful. No recovery is attempted. |
| `4` | Live verification failed after promotion; recovery is required. |

On exit `4`, the verify workflow promotes the previous healthy deployment back
to the canonical alias and then re-reads the project to confirm Git
auto-publication is still enabled for `main` with `ci-gate` still required. The
recovery summary records the failed deployment, the restored deployment, and the
observed alias. If recovery cannot certify the previous deployment as healthy,
the run fails and the incident is treated as a production outage.

**Superseded release.** If a newer deployment has already become the canonical
deployment, do not move the alias backwards. Recovery treats the failed
deployment as superseded, exits without mutation, and records the newer
deployment/alias. The same rule applies when the failed deployment is no longer
the alias target: verify, report, and stop.

## Inspecting the live release

Use read-only Vercel and HTTP checks; do not mutate the alias to answer a
question.

- Alias target: `vercel alias ls --scope <team>` and `vercel inspect
  ega-skills-mcp.vercel.app`.
- Deployment ID, source SHA, and state: `vercel inspect <deployment-url>` or
  `vercel ls ega-skills-mcp --scope <team> --meta githubCommitSha=<sha>`.
- Project configuration: `vercel project inspect ega-skills-mcp --scope <team>`;
  confirm Production Branch `main`, Root Directory `packages/mcp`, Git
  auto-deployment enabled, and the `ci-gate` Deployment Check.
- Live identity: `GET https://ega-skills-mcp.vercel.app/healthz` and
  `GET /readyz`; `/readyz` reports the exact `release_digest`. The authenticated
  four-tool probe (`scripts/oauth/mcp-probe.mjs`) proves catalog identity.

Compare the live source SHA with the merge commit on `main`; a mismatch, a
`READY` deployment that is not the alias target, or a missing `ci-gate` check
conclusion is a release failure, not a reason to promote manually.

## Security invariants

- Never print, commit, paste, screenshot, or ticket a token, bypass secret,
  service-role key, or database URL. Load credentials from environment values or
  short-lived `0600` files and purge them at the end of the cycle.
- Verify Vercel identity (`whoami`) and both team and project reads before
  diagnosing a release. A `403` may mean the wrong account, not an expired
  token.
- Keep the token in a `0600` file injected only as `VERCEL_TOKEN`; do not depend
  on a global CLI credential store on a shared VM.
- Treat an unexplained alias move as a security incident. Dashboard promotion
  rights remain a residual risk that Vercel cannot make atomic.
- Do not distribute project-wide protection-bypass secrets to developer
  machines.

## Related

- `docs/operations/RELEASE-2.0-RUNBOOK.md` — pre-deployment checks, smoke tests,
  catalog bootstrap, and invariant reference.
- `docs/INTAKE-TO-PUBLICATION.md` — reviewed catalog intake and preflight.
- `packages/mcp/VERCEL.md` — Vercel project/build configuration.
