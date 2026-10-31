# Web Console production promotion, rollback and acceptance plan (EGA-731)

Status: **PREPARATION ONLY — not executed.** This document is an
owner-executable plan. No deployment, promotion, alias change, secret change,
database change, or production action was performed while preparing it.

Issue: [EGA-731](https://linear.app/egawilldoit/issue/EGA-731/owner-can-open-the-certified-web-console-from-its-production-domain)
— "Owner can open the certified Web Console from its production domain".

Delivery boundary: **production deployed and owner-verified.** The owner
reserves merge, production secrets, database changes and promotion. This plan
does not move that boundary and does not claim acceptance.

## Scope and non-scope

In scope: promote the already-reviewed console candidate as **one** production
Web Console deployment, verify its exact SHA and release digest, and repeat the
owner login → one governed skill journey.

Not in scope (per EGA-731): new UI, new database schema, MCP upgrades, charts,
extra workspace management, and any change to the existing MCP or OAuth UI
deployments.

Companion documents (reused, not replaced):

- [RELEASE-2.0-RUNBOOK.md](./RELEASE-2.0-RUNBOOK.md) — MCP pre-deploy/smoke/
  rollback conventions and hard invariants.
- [packages/mcp/VERCEL.md](../../packages/mcp/VERCEL.md) — authoritative
  deployment architecture and rollback (immutable deployments).
- Console-candidate evidence, which lives only on the console branch
  (`prepare/ega-741-integrated-review`), not on `release/2.0`: the console's
  executed local/CI acceptance record
  `docs/operations/web-console-pr137-acceptance.md` and the baseline gate
  results `docs/evidence/web-console/BASELINE.md`. Neither path exists on this
  base, so they would 404 as relative links from this document; read them at the
  candidate SHA instead.

This plan follows the same shape as the MCP runbook: verify identity and the
release identity first, capture the previous known-good deployment, deploy,
smoke, accept, and only then record. It introduces no second deployment
framework.

## 1. Promotion candidate (verified revision and identity)

| Item | Value |
| --- | --- |
| Candidate commit SHA | `00cc95660519c5b21e60fbb7085b58c102527bd5` |
| Candidate branch | `prepare/ega-741-integrated-review` |
| Integration base (production branch) | `release/2.0` |
| Production branch SHA at plan time | `7bf0d5a2310ffddbdb4055166be67d56916d8ac6` |
| Hub release digest (`hub-release.json` `.digest`) | `sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3` |
| SQLite artifact digest | `sha256:de3ab40cfb13adf05f420cae72d5f7d18add82331d593ff3bf6e5f5f468f6e1d` |
| Snapshot rows | `116` |
| Immutable artifact source | `packages/mcp/artifact` → staged to `apps/web/artifact` by `scripts/web/stage-artifact.mjs` |

The digest is the top-level `digest` field of `packages/mcp/artifact/hub-release.json`
and equals `hub_release_digest` in `packages/mcp/artifact/release-package.json`.
Do not use `.release_digest`; that field belongs to the release-candidate
envelope, not the exported release (see RELEASE-2.0-RUNBOOK.md § Pre-deployment).

### Candidate reconciliation (must be closed before promotion)

PR [#137](https://github.com/egawilldoit/ega-skills/pull/137) `feat/web-console`
is **OPEN / DRAFT** with head `850b83d7eb70128ff668d5adccf830d40f081c96`. That
head is an **ancestor** of the candidate `00cc9566…`. The candidate therefore
contains PR #137 plus the later merges `#140`, `#141`, `#142` and the reviewed
console authorization/cancellation/telemetry stack consolidated on
`prepare/ega-741-integrated-review`.

Consequence: PR #137's recorded head is **not** the promotion candidate. Before
promoting, the owner must confirm which revision is the certified console
candidate and reconcile it with PR #137:

- If the certified candidate is `00cc95660519c5b21e60fbb7085b58c102527bd5`, the
  owner must first land or explicitly authorize a PR that carries this exact
  revision onto `release/2.0` (merge is owner-reserved; EGA-741 covers the
  final-head review/merge of the console PR).
- If PR #137 is promoted as-is, record its then-current head SHA here and
  re-verify its digest — the SHA and digest in this table are for `00cc9566…`
  only.

The promotion is valid only against a single recorded full SHA whose CI is green
at that exact SHA. At plan time the candidate is a clean descendant of
`release/2.0` (0 commits behind, 116 ahead), so it needs no rebase before
promotion.

### Pre-promotion identity verification (planned commands)

```bash
# Branch/commit identity (run in a clean worktree; no uncommitted changes)
git fetch origin
git rev-parse HEAD                     # must equal the promotion SHA
git status --short                     # must be empty

# CI at the exact SHA
gh run list --repo egawilldoit/ega-skills --branch release/2.0 --limit 5
gh run view <run-id> --repo egawilldoit/ega-skills
# Required green at that SHA: foundation (ubuntu-latest), foundation (windows-2022),
# contract-f rls (ubuntu-latest), web console (ubuntu-latest),
# web console (windows-2022), web isolation (real PostgreSQL 16).
# Verify both hashing traversal test files ran and passed in each foundation
# job, as required by RELEASE-2.0-RUNBOOK.md § Pre-deployment.

# Release identity (immutable artifact)
node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
node scripts/web/stage-artifact.mjs --check-only
jq -r '.digest' packages/mcp/artifact/hub-release.json
# Expected: sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3
```

`stage-artifact.mjs` copies and verifies committed bytes; it never regenerates
the artifact, so a digest mismatch fails the build rather than serving a
different release.

## 2. Required Vercel project, domain and environment (names only)

No verified dedicated production `apps/web` project or alias exists today. The
Vercel checks observed on this repository expose only the `ega-skills-auth` and
`ega-skills-mcp` projects. The production MCP alias `ega-skills-mcp.vercel.app`
serves deployment
`dpl_BJNrmsRuTEN1cbDJHBtnANUrre6G` at `release/2.0` SHA `7bf0d5a…` and is a
**different application**; it is not the console target and must not be changed.
The Auth/OAuth UI alias is likewise a separate project.

### New/chosen project settings

- Project: a dedicated Web Console project (e.g. `ega-skills-web`); team scope
  `team_e2x4kf12yL43qmBIs2t2YaD2` or the owner-designated team.
- Root Directory: `apps/web`
- Production Branch: `release/2.0`
- Framework: Node server detected via `apps/web/server.mts` (`server.listen()`).
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: from the committed `apps/web/vercel.json`
  (`stage-artifact.mjs` then `pnpm --filter @ega-skills/web build`).
- Node version: 24. Tick "Include source files outside of the Root Directory in
  the Build Step" so workspace dependencies and the staged artifact resolve.
- Bundle contract: committed `apps/web/vercel.json` (`builds` on `server.mts`
  with `@vercel/node`, `routes` to `server.mts`, security headers). Do not add a
  separate functions block or dashboard rewrites.

### Domain

Owner must designate the production hostname (custom domain or the project's
`*.vercel.app` alias). Record the exact hostname here at promotion time. The
hostname is a promotion input, not something this plan may invent.

### Environment variable NAMES (never commit values)

Browser-visible (bundled; safe to expose, never prefix a server secret with `VITE_`):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Server-side (`apps/web/server.mts`; never exposed to the browser):

- `EGA_WEB_ARTIFACT_DIR` — set to `artifact` (the staged immutable release).
- `EGA_WEB_EXPECTED_RELEASE_DIGEST` — `sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3`.
- `EGA_SUPABASE_URL`
- `EGA_SUPABASE_PUBLISHABLE_KEY` (fallback `EGA_SUPABASE_ANON_KEY`)
- `EGA_SUPABASE_SECRET_KEY` — server-side secret only; the BFF never uses it to
  bypass RLS.
- `EGA_WEB_PUBLIC_POLICY` — leave unset (must NOT be `public`).
- `EGA_WEB_ALLOW_ANONYMOUS` — leave unset (must NOT be `true`).
- `EGA_HOSTED_TELEMETRY_ENABLED` — `false` for this promotion (no telemetry
  writes). If telemetry is ever enabled, use the certified INSERT-only writer
  configuration (`EGA_HOSTED_TELEMETRY_API_KEY`,
  `EGA_HOSTED_TELEMETRY_WRITER_KEY`).
- Optional: `EGA_WEB_RETAINED_MANIFEST`.

With `EGA_WEB_PUBLIC_POLICY`/`EGA_WEB_ALLOW_ANONYMOUS` unset, artifact routes
require an authenticated caller, which is what makes the signed-out refusal in
the acceptance checklist meaningful.

## 3. Deploy and alias (planned commands — not executed)

Follow RELEASE-2.0-RUNBOOK.md hard invariants: assert Vercel identity **before**
acting, pass an explicit per-project `VERCEL_TOKEN`, `--token` and `--scope` on
every call, and never depend on the global CLI auth store.

```bash
# 0. Identity gate — abort if either read fails
vercel whoami            --token "$VERCEL_TOKEN"
vercel project ls        --scope <team> --token "$VERCEL_TOKEN"
vercel projects inspect <project> --scope <team> --token "$VERCEL_TOKEN"

# 1. Select (or create) the dedicated apps/web project and link the working copy
#    Run every project-scoped command below from the repository root with
#    `--cwd apps/web`: the project Root Directory is apps/web and the committed
#    apps/web/vercel.json expects that cwd (its buildCommand resolves
#    ../../scripts/web/stage-artifact.mjs).
#    If the project does not exist yet: `vercel project add <project> --scope <team>`
#    (or create it in the dashboard) and set Root Directory to apps/web first.
vercel link --yes --cwd apps/web --project <project> \
  --scope <team> --token "$VERCEL_TOKEN"

# 2. Capture the previous known-good console deployment (see § 4)
vercel ls <project> --scope <team> --token "$VERCEL_TOKEN"
#    Record: deployment URL + ID, source SHA, release digest served.

# 3. Build and deploy the exact candidate at the promotion SHA
vercel pull --yes --environment=production --cwd apps/web \
  --scope <team> --token "$VERCEL_TOKEN"
vercel build --prod --cwd apps/web --scope <team> --token "$VERCEL_TOKEN"
vercel deploy --prebuilt --prod --cwd apps/web \
  --scope <team> --token "$VERCEL_TOKEN"
#    Record the returned deployment URL + deployment ID.

# 4. Bind the owner-approved production hostname (if not the project default)
vercel alias set <deployment-url> <owner-approved-hostname> \
  --scope <team> --token "$VERCEL_TOKEN"

# 5. Read back what is actually served
vercel inspect <deployment-url> --scope <team> --token "$VERCEL_TOKEN"
curl -fsS https://<owner-approved-hostname>/  # SPA shell
```

Then run the acceptance checklist in § 5 against the production hostname before
recording success.

## 4. Rollback

Rollback is an alias/deployment operation only. It **must not** run migrations,
change secrets, or touch the MCP or OAuth UI projects.

Recorded rollback reference (separate application, for awareness only):

- MCP production deployment `dpl_BJNrmsRuTEN1cbDJHBtnANUrre6G` at `release/2.0`
  SHA `7bf0d5a…` (alias `ega-skills-mcp.vercel.app`). This is **not** the console
  rollback target.

Console rollback target (captured in step 2 above): the previous known-good
console deployment URL/ID and the release digest it served. If no prior console
deployment exists, the rollback is "remove/retire the console alias" and the
target is recorded as `NONE (first deployment)`.

```bash
# Re-point production back to the previous known-good console deployment
vercel rollback <previous-deployment-url-or-id> --scope <team> --token "$VERCEL_TOKEN"
# or, when the alias was set manually:
vercel alias set <previous-deployment-url> <owner-approved-hostname> \
  --scope <team> --token "$VERCEL_TOKEN"

# Re-run the signed-in read against the production hostname and confirm the
# previous revision's SHA/digest is served.
```

Restore-to-new (re-promote the candidate) is the same as § 3 step 3–5 and
re-runs the checklist.

## 5. Acceptance checklist (owner-run)

Prerequisite: the isolated Preview first checkpoint (EGA-717) has passed and the
owner has authorized production promotion.

- [ ] **P1 — Exact revision.** The deployed source SHA equals the recorded
      promotion SHA (`00cc95660519c5b21e60fbb7085b58c102527bd5`, unless
      re-reconciled per § 1), and the deployment serves release digest
      `sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3`.
- [ ] **P2 — Owner sign-in.** Owner signs in at the owner-approved production
      hostname (Supabase Auth) and reaches the console.
- [ ] **P3 — One authorized skill.** The owner opens **one** authorized governed
      skill; the reader shows the skill/version and the immutable release digest
      from P1 (no `mismatch`/`unpinned` state).
- [ ] **P4 — Signed-out refusal.** A signed-out session cannot read the same
      skill: `/api` returns `401`/redirect and no skill content is served (this
      is meaningful only because public/anonymous policy is disabled, § 2).
- [ ] **P5 — Rollback validated.** Re-point to the previous known-good console
      deployment (§ 4), confirm the served revision changes, re-read the same
      skill (or observe explicit denial), then restore. No new database
      mutations are introduced by the rollback.
- [ ] **P6 — Evidence.** Sanitized browser network evidence (DevTools/HAR with
      no `Authorization` header, cookies, tokens, or API keys) and owner
      sign-off attached to EGA-731.

## 6. DB non-mutation assurance

- The `apps/web` deployment has **no migration step**: Vercel installs, stages
  the committed artifact, and builds the SPA; the CI `web` job never applies
  migrations.
- The BFF is read-oriented. It executes control-plane queries under caller
  session tokens with RLS enforced and never uses `EGA_SUPABASE_SECRET_KEY` to
  bypass RLS.
- Telemetry is the only write surface in the console stack; it is an INSERT-only,
  dedicated-role path and is **disabled** for this promotion
  (`EGA_HOSTED_TELEMETRY_ENABLED=false`).
- Promotion, alias and rollback are Vercel deployment/alias operations. This plan
  runs no `supabase db push`, no migration, and no secret mutation.
- Acceptance reads (skill detail, signed-out refusal, rollback re-read) are
  SELECTs. Recorded rollback validation must show no new mutations.
- **Registration is separate from deployment, and this plan does not perform
  it.** The console's artifact routes require the deployed release digest to be
  readable in `public.hub_releases`; the deployment itself writes nothing, so the
  first registration is an explicit, separately authorized
  trusted-publisher operation. See RELEASE-2.0-RUNBOOK.md § "Hosted catalog
  bootstrap (registering the release)" for the exact transaction, its
  idempotency and conflict behaviour, and its dependency-aware rollback. Until it
  runs, `/readyz` reports ready while the artifact routes answer `403
  E_WEB_CONTROL_PLANE_FORBIDDEN`.

## 7. Blockers, owner and next action

| Blocker | Why it gates | Owner | Single next action |
| --- | --- | --- | --- |
| **EGA-717 first checkpoint not met** | The exact candidate must be deployed in isolated Preview with the owner login → one skill journey working *before* promotion is requested. EGA-717 is Backlog, blocked by EGA-716 (usable Preview URL + owner test session). | Owner/operator | Provide/authorize the isolated console Preview (EGA-716) and run the EGA-717 journey against this candidate SHA. |
| **Owner approval for production** | Production promotion, secrets and merge are owner-reserved. Owner must designate the Vercel project and production hostname. | Owner | Approve the target project, hostname and promotion of the recorded SHA. |
| **DB environment certification** | The console needs the certified Supabase target and a decision on telemetry (`EGA_HOSTED_TELEMETRY_ENABLED=false` recommended). | Owner | Certify the Supabase URL/keys for the production console and confirm telemetry-off. |
| **Candidate reconciliation** | PR #137 head (`850b83d…`) ≠ candidate (`00cc9566…`); a single certified full SHA must be recorded. | Owner (merge reserved) | Decide whether the certified candidate is `00cc9566…` (land it on `release/2.0`) or a new PR #137 head, then freeze that SHA. |
| **Independent final-head review** | EGA-741 requires real-browser acceptance and independent review before merge. | Reviewers | Review the frozen full SHA; self-review is not independent approval. |

No production action, merge, secret change, database change or promotion was
performed in preparing this document. This document is the recorded plan and
evidence, not acceptance.
