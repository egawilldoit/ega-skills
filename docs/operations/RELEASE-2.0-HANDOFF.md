# EGA Skills 2.0 — production release handoff

Status: **ENGINEERING READY / EXTERNAL RELEASE GATES REMAINING**.
This document is the executable handoff for the connected release operator. It
contains no secrets and does not itself authorize a production mutation.

The repository work is complete only at the merge commits recorded in issue
#168. Re-read the live state before every applying command; deployment ids,
alias inventories and checks are observations, not constants.

## 1. Release record

| Item | Value |
| --- | --- |
| Repository | `egawilldoit/ega-skills` |
| Tracking issue | https://github.com/egawilldoit/ega-skills/issues/168 |
| Release target branch | `release/2.0` |
| Release PR (draft) | https://github.com/egawilldoit/ega-skills/pull/176 |
| Main preparation merge | `6b9b2a8623e22eada4feb66b5c48b2f198a3ceac` (PR #175) |
| Baseline readiness PR | https://github.com/egawilldoit/ega-skills/pull/177 |
| Baseline migration implementation PR | https://github.com/egawilldoit/ega-skills/pull/178 |
| Vercel team | `team_e2x4kf12yL43qmBIs2t2YaD2` |
| Vercel project | `prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG` (`ega-skills-mcp`) |
| Canonical alias | `ega-skills-mcp.vercel.app` |
| Approved publisher | Vercel user `Dc0U1Ov3Zh5zeFKeic10bVWj` (`MORTAKI0` / `mortaki0`) |
| Production branch | `release/2.0` |

Merge commit SHAs are recorded in issue #168 when each PR is merged. The
operator must use the exact merge commit, not a branch tip that may have moved.

## 2. Immutable identities

### Candidate 126-skill release (the release being promoted)

| Item | Value |
| --- | --- |
| Semantic HubRelease | `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266` |
| Candidate envelope | `sha256:bcc1f72e30f36deaa16fbaee5af00ab19ebf1022029a77207244d0794e902775` |
| Invocation policy | `sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6` |
| Source snapshot | `sha256:baee615c166889a7a6743cbff0eb4cf24e9f37cbe621d1fd69723de4ce599360` |
| Skills | exactly 126: 117 unchanged, nine approved `t3dotgg/*` additions |
| SQLite artifact | `sha256:dfe974301b67cd36aa53208c24e2bc3b2bfca3d3d306488dc0aa772e141b6896` |
| Physical artifact tree | `sha256:08e086198728b8eeb2dd4dfa8284c0b08ec109f16f4702c724d773a34b3fc13a` |

The nine TStack bytes were not modified. The original upstream commit is
`7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd`; the source is MIT-licensed and the
provenance file is `LICENSE`.

### Retained 117-skill release (the predecessor and rollback baseline)

| Item | Value |
| --- | --- |
| Semantic HubRelease | `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297` |
| Candidate envelope | `sha256:5c441c3f0d7f5acf0cbdf005e6b4db8d05105783c38f37b4939b3b0ae54a45bc` |
| Physical artifact tree | `sha256:ad9f0cfa1c68a1531c964d921dfc4e6acf94357447517138aa7d69187f88276a` |
| Last observed production deployment | `dpl_MGiFbFtwcibpc9wY7BiK7gXkH3zH` (revalidate; not a constant) |

Reproduce the tree digests from a clean checkout:

```
find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum
node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
```

## 3. What is verified locally

These are repository facts, not Vercel or OAuth facts:

- `pnpm build`, `pnpm typecheck`, `pnpm catalog:check`, `pnpm specs:check` pass.
- The focused publication suites pass, including 20 new baseline-migration
  tests covering missing, mismatched, stale, substituted and unavailable
  predecessor evidence, failed-promotion restore, no-move promotion failure,
  supersession, interrupted reconciliation and lease exclusion.
- The 126 artifact validates and reports exactly
  `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`,
  126 skills, and the SQLite digest above.
- The 117 artifact validates and reports exactly
  `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`,
  117 skills.
- The 27/27 positive alternatives, 9/9 explicit references, 11/11 negative
  cases, 82/82 unchanged automatic-selection lists and the known discovery
  baseline failures are recorded in the release evidence and CI.
- The publisher's Vercel HTTP behavior is tested against mocked responses. This
  proves code behavior only, not live Vercel configuration.

**Not verified locally:** live alias ownership, Git auto-deploy suppression,
deployment checks, single-writer access control, Vercel quota, OAuth login, and
production MCP availability. Do not claim LIVE until section 11 succeeds.

## 4. External gates before any applying command

All five must be true and read back from the live APIs immediately before the
migration or promotion. Missing fields block; absence is never success.

### 4.1 Git production auto-deploy is disabled

Read `GET /v9/projects/prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG?teamId=team_e2x4kf12yL43qmBIs2t2YaD2`.

Accept only one of:

- `git.deploymentEnabled === false`; or
- `git.deploymentEnabled` is an object with the exact production branch
  (`"release/2.0"`) mapped to `false` and **every** value in the object is
  `false`.

`gitProviderOptions.createDeployments` is a GitHub deployment_status
notification switch, not a build switch. `commandForIgnoringBuildStep` is not a
publisher ACL. `deploymentPolicy.gitSources` is an allowlist with different
semantics. None of these are accepted as proof.

Required read-back evidence: the exact response body (redact nothing except
credentials) showing the accepted shape, the timestamp, and the authenticated
publisher identity. Save it outside the repository.

### 4.2 One canonical production alias

Read `GET /v4/aliases/ega-skills-mcp.vercel.app?teamId=…`, then
`GET /v2/deployments/<deploymentId>/aliases?teamId=…`.

Accept only when the alias resolves directly to the approved project's
production deployment, `redirect` is absent, the inventory is complete
(`pagination.next` absent), and the inventory contains exactly
`ega-skills-mcp.vercel.app`.

The current production observation on 2026-10-28 had two additional automatic
aliases. Remove them or obtain an independently reviewed adapter that proves
they cannot serve production. Do not treat "only the canonical alias is
documented" as inventory proof.

### 4.3 Deployment checks concluded successfully

Read the immutable deployment `GET /v13/deployments/<deploymentId>`.

For the **legacy 117 predecessor**, the deployment predates deployment checks.
Use `legacy_deployment_checks: "absent-accepted"` only when the deployment is
`READY`, `/readyz` is the exact legacy shape, the artifact/source binding is
exact, and the owner explicitly accepts the absence. `failed` and `pending`
always block. If the legacy deployment already has a successful conclusion, use
`"succeeded"` instead.

For the **migration deployment and the 126 predecessor**, accept only
`readyState === "READY"` and `checksConclusion === "succeeded"`. If the project
does not attach checks to CLI deployments, configure a real deployment check
before the migration; do not force-promote. The migration will restore the
predecessor if the promoted deployment has no successful check.

### 4.4 Genuine external single-writer / access-control certification

Create a readiness record outside the repository with exactly these fields:

```json
{
  "schema_version": 1,
  "verified_at": "<RFC3339 UTC>",
  "expires_at": "<RFC3339 UTC, at most 24h after verified_at>",
  "certified_by": "<independent reviewer>",
  "review_record": "https://<HTTPS review record>",
  "publisher_vercel_user_id": "Dc0U1Ov3Zh5zeFKeic10bVWj",
  "team_id": "team_e2x4kf12yL43qmBIs2t2YaD2",
  "project_id": "prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG",
  "canonical_alias": "ega-skills-mcp.vercel.app",
  "production_branch": "release/2.0",
  "state_dir": "<absolute shared publication state dir>",
  "access_controls_reviewed": true,
  "single_writer_controls_reviewed": true,
  "residual_alias_race_accepted": true
}
```

The flags are review attestations, not Vercel ACL enforcement. The script
validates the record's shape, target binding, freshness and HTTPS URL, but it
does not fetch or authenticate the linked review. The release operator must
actually verify that the publisher token is the only production-capable
credential and that every other principal's deployment/promotion rights are
removed. Record the residual risk explicitly: Vercel aliases have no
compare-and-swap, so a principal with dashboard rights can still move the alias
outside the lease. If that risk is not accepted by the owner, do not apply.

### 4.5 Approved publisher identity and credential

The executing token must belong to `Dc0U1Ov3Zh5zeFKeic10bVWj`. Read
`GET /v2/user` with the release token before any mutation. The token must be in
a `0600` file and injected only as `EGA_VERCEL_TOKEN_FILE`; never pass `--token`,
never use the global CLI login, and never paste it into a command line or log.

Also verify the team and project reads with the same token. A `403` on either
is a stop condition, not a retry.

## 5. Baseline runtime migration (first governed release only)

The legacy deployment predates `/readyz` release identity. Do not bypass the
publisher and do not substitute a configured digest. The supported operation
deploys the reviewed runtime with the **unchanged retained 117 artifact**, then
the new runtime reports the real 117 digest.

### 5.1 Merge the readiness PR

Merge https://github.com/egawilldoit/ega-skills/pull/177 into `release/2.0`
with the merge guard active (see section 4 and section 10). Record the exact
merge commit `M1`; do not use the branch tip. Confirm the merge-window
deployment is `CANCELED`/ignored and the canonical alias did not move.

### 5.2 Prepare clean sources

```
PRE_COMMIT=$(git -C <repo> rev-parse <live-deployment-meta.githubCommitSha>)
MIGRATION_COMMIT=<exact M1 merge commit>
REVIEWED_COMMIT=<exact baseline-migration implementation merge commit>

git -C <repo> worktree add --detach /secure/predecessor-source "$PRE_COMMIT"
git -C <repo> worktree add --detach /secure/migration-source "$MIGRATION_COMMIT"
git -C <repo> merge-base --is-ancestor "$PRE_COMMIT" "$MIGRATION_COMMIT"
git -C <repo> diff --name-status "$PRE_COMMIT" "$MIGRATION_COMMIT"
```

The diff must contain exactly `packages/mcp/server.mts`,
`packages/mcp/src/vercel-adapter.ts` and
`tests/mcp/vercel-adapter.test.mjs`. Any other path means the migration is not
the reviewed readiness change and must not run. If the release branch tip
contains unrelated commits after the live deployment's source commit, create a
dedicated commit from `PRE_COMMIT` that applies only those three reviewed paths,
review it, and authorize that exact commit instead. The two readiness files are
pinned by code constants in the publisher and compared from Git objects, not
the working tree.

Both worktrees must be clean. Do not run `pnpm install` in them; the Vercel
build runs from a fresh detached worktree at `MIGRATION_COMMIT` with no
untracked or ignored files. Verify both artifacts:

```
(cd /secure/predecessor-source && node <repo>/scripts/hosted/validate-artifact.mjs packages/mcp/artifact)
(cd /secure/migration-source && node <repo>/scripts/hosted/validate-artifact.mjs packages/mcp/artifact)
(cd /secure/predecessor-source && find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum)
(cd /secure/migration-source && find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum)
```

Both must show release `sha256:3c08…` and tree
`sha256:ad9f0cfa1c68a1531c964d921dfc4e6acf94357447517138aa7d69187f88276a`.

### 5.3 Authorize the exact migration

Prepare the payload from the owner decision and canonicalize it with:

```
node scripts/hosted/publish-production.mjs baseline-authorize \
  --payload /secure/outside-repo/baseline-authorization-payload.json \
  --out /secure/outside-repo/baseline-authorization.json
```

The payload is exactly the schema in the runbook section
"Baseline runtime migration". It must bind:

- `baseline_release_digest = sha256:3c08…`
- `baseline_candidate_digest = sha256:5c44…`
- `baseline_artifact_tree_digest = sha256:ad9f…`
- `predecessor_deployment_id = <live alias target>`
- `predecessor_source_commit = <live deployment meta.githubCommitSha>`
- `reviewed_runtime_commit = <exact implementation merge commit>`
- `migration_source_commit = M1`
- `legacy_deployment_checks = "absent-accepted"` (or `"succeeded"` if the
  legacy deployment has a real successful check)
- `canonical_alias = ega-skills-mcp.vercel.app`
- `production_branch = release/2.0`
- publisher team/project/user as in section 1
- `approved_by`, `approved_at`, `approval_record` (a concrete GitHub issue or
  pull request URL in `egawilldoit/ega-skills`), `scope:
  "runtime-readiness-only"`

`baseline-authorize` validates and writes the envelope; it does not grant or
authenticate approval. The operator must verify the owner decision at
`approval_record` before using the envelope. The script treats the envelope as
a transcription of that decision, exactly like the normal publication approval.

### 5.4 Dry-run, then apply

Dry-run (no mutation, no receipt):

```
EGA_VERCEL_TOKEN_FILE=/secure/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs baseline \
  --authorization /secure/outside-repo/baseline-authorization.json \
  --predecessor-source /secure/predecessor-source \
  --migration-source /secure/migration-source \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG \
  --publisher Dc0U1Ov3Zh5zeFKeic10bVWj \
  --production-branch release/2.0 \
  --alias ega-skills-mcp.vercel.app \
  --expect-deployment <live legacy deployment> \
  --expect-release sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297 \
  --staging-out /secure/outside-repo/baseline-staging.json \
  --receipt /secure/outside-repo/baseline-receipt.json
```

Apply by adding:

```
  --readiness /secure/outside-repo/readiness.json --apply
```

The command:

1. requires the legacy `/readyz` shape, exact alias target, immutable source
   commit, artifact tree, reviewed delta/runtime files and platform controls;
2. creates a fresh detached worktree at the exact migration commit, requires
   no untracked or ignored files, and stages it with `vercel deploy --prod
   --skip-domain --project <id> --meta githubCommitSha=<M1>`;
3. requires the staged `/readyz` to report the exact 117 digest and the staged
   deployment API document to report the exact migration source commit;
4. fsyncs the immutable staging record;
5. promotes without `--force`;
6. polls the alias, deployment source commit and `/readyz` until the exact 117
   digest is served by the authorized commit;
7. writes a write-once migration receipt bound to the authorization, candidate,
   artifact tree, source commits and deployments. The reserved
   `<receipt>.pending` intent is retained.

If the process dies after the alias moves, run `baseline-reconcile` with the
same authorization/sources/target flags, `--staging
/secure/outside-repo/baseline-staging.json` and a **new** receipt path. It
never moves the alias, requires the live deployment to report the exact
migration source commit, and re-reads the live identity before writing the
receipt. If the migration fails after promotion, the command restores the
original legacy deployment and verifies its legacy readiness shape; if recovery
returns evidence, the FAILED receipt is written as `<receipt>.failed.json`. If
recovery itself fails, preserve the pending intent and staging record and
reconcile manually — do not claim a successful restore.

### 5.5 Expected result

- `GET https://ega-skills-mcp.vercel.app/readyz` → HTTP 200
  `{"status":"ready","release_digest":"sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297"}`
- alias targets the new migration deployment, which is `READY` with successful
  checks
- authenticated MCP still reports the 117 release and no `t3dotgg/*` skills
- original deployment `dpl_MGiF…` and its artifact remain retained
- migration authorization, staging record, readiness record and receipt are
  retained outside the repository

Do not proceed to the 126 promotion if any of these is false.

## 6. 126-skill governed promotion

The normal publisher remains the only supported path. Stage and promote from
the exact merged implementation/release commit, with the candidate and approval
recorded in issue #168. The CLI now refuses a dirty checkout, requires the
checkout's `packages/mcp/artifact` to be the exact `--candidate`, and deploys a
fresh detached worktree at `HEAD` with `--meta githubCommitSha=<HEAD>`. The
`--expect-source-commit` flag must name that exact commit, and the commit must
be reachable from `origin/release/2.0` (fetch first; `EGA_RELEASE_REF` is an
explicit override for a reviewed release ref). The staging record binds that
source commit; `promote`/`reconcile` refuse a staging record or deployment whose
identity/source does not match. Run the commands from a clean checkout of the
tested commit.

```
EGA_VERCEL_TOKEN_FILE=/secure/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs stage \
  --candidate /path/to/candidate \
  --approval /secure/outside-repo/approval.json \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG \
  --publisher Dc0U1Ov3Zh5zeFKeic10bVWj \
  --production-branch release/2.0 \
  --alias ega-skills-mcp.vercel.app \
  --expect-release sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297 \
  --expect-deployment <migration deployment> \
  --expect-revision 0 \
  --expect-source-commit <exact merged release SHA> \
  --staging-out /secure/outside-repo/staging-0.json \
  --readiness /secure/outside-repo/readiness.json --apply
```

Then:

```
EGA_VERCEL_TOKEN_FILE=/secure/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs promote \
  --candidate /path/to/candidate \
  --approval /secure/outside-repo/approval.json \
  --staging /secure/outside-repo/staging-0.json \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG \
  --publisher Dc0U1Ov3Zh5zeFKeic10bVWj \
  --production-branch release/2.0 \
  --alias ega-skills-mcp.vercel.app \
  --expect-release sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297 \
  --expect-deployment <migration deployment> \
  --expect-revision 0 \
  --expect-source-commit <exact merged release SHA> \
  --staged-deployment <staged deployment> \
  --genesis \
  --receipt /secure/outside-repo/receipt-1.json \
  --readiness /secure/outside-repo/readiness.json --apply
```

Expected `/readyz` after promotion:

```json
{"status":"ready","release_digest":"sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266"}
```

The receipt is the rollback authority. Do not merge PR #176 merely because CI is
green; see section 10.

## 7. Authenticated production acceptance

Use a real OAuth client, not a stored client-config token.

```
EGA_SMOKE_URL=https://ega-skills-mcp.vercel.app \
EGA_SMOKE_TOKEN_FILE=/secure/oauth-token.json \
node scripts/oauth/hosted-smoke.mjs

EGA_MCP_TOKEN_FILE=/secure/oauth-token.json \
EGA_MCP_URL=https://ega-skills-mcp.vercel.app/mcp \
node scripts/oauth/mcp-probe.mjs
```

Accept only when:

- `/healthz` is 200; `/readyz` is 200 with the 126 digest above
- anonymous `/mcp` is 401 with a Bearer challenge
- authenticated `/mcp` lists exactly `search`, `resolve`, `inspect`,
  `get_content`
- `search` reports `effective_release_digest` equal to the 126 digest
- `resolve` and `inspect` return an approved `t3dotgg/*` version hash from the
  approval packet
- `get_content` returns text whose recomputed SHA-256 matches the probe result
- Codex and OpenCode each complete one explicit call per tool and observe the
  same skill id, version hash and content digest as the direct probe
- `babysit-pr` scripts are not claimed as hosted executable content; document
  the pinned upstream/checksum fallback

Do not claim LIVE until the nine new skills are actually searchable and
retrievable through an authenticated production MCP session.

## 8. Rollback and reconciliation

### 8.1 Failed 126 promotion

The publisher automatically restores the migration deployment only if this
promotion is still the current alias. It verifies the restored deployment is
READY with successful checks and serves the exact 117 digest. It writes a
`FAILED` side receipt. Do not re-run `promote`; inspect and reconcile.

### 8.2 Interrupted 126 promotion

If the alias already moved to the exact staged 126 deployment and `/readyz`
serves the 126 digest, use `reconcile` with the staging record and a new receipt
path. It never moves the alias. If another publication won, refuse and
investigate; do not clobber it.

### 8.3 Successful 126 release → rollback to 117

Use the contiguous receipt chain and the retained 117 candidate:

```
EGA_VERCEL_TOKEN_FILE=/secure/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs rollback \
  --chain /secure/outside-repo/receipt-1.json \
  --current /secure/outside-repo/receipt-1.json \
  --predecessor-candidate /path/to/retained-117-candidate \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG \
  --publisher Dc0U1Ov3Zh5zeFKeic10bVWj \
  --production-branch release/2.0 \
  --alias ega-skills-mcp.vercel.app \
  --expect-revision 1 \
  --expect-deployment <126 deployment> \
  --expect-release sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266 \
  --receipt /secure/outside-repo/receipt-2.json \
  --readiness /secure/outside-repo/readiness.json --apply
```

The governed rollback target is the **migration deployment** serving the 117
digest, not the original legacy deployment. The original legacy deployment
remains retained for emergency containment. A bare `vercel rollback` to it is
not a governed rollback: the normal publisher cannot verify its legacy
readiness. Record the audit gap and re-run the baseline migration before the
next governed promotion.

## 9. Interrupted migration / lease recovery

The publication lease is a shared-filesystem directory. An expired lease is
never reclaimed automatically because expiry cannot prove the former process
stopped.

Before manual recovery:

1. prove the former publisher and any Vercel CLI child have stopped;
2. read the live alias, deployment and `/readyz`;
3. run the appropriate `reconcile` / `baseline-reconcile` if the alias already
   moved;
4. keep incomplete `PENDING` intent files as evidence;
5. use a new receipt path for the recovery attempt;
6. remove the lease only after the exact live state is recorded.

## 10. PR #176 merge guard

Do **not** merge https://github.com/egawilldoit/ega-skills/pull/176 until all of
the following are true:

1. The baseline migration succeeded and `/readyz` reports the 117 digest.
2. Git production auto-deploy is disabled and read back on the live project.
3. The canonical alias is the only production alias.
4. The deployment checks are successful.
5. A fresh external single-writer/access-control certification exists and the
   residual alias race is accepted.
6. The exact merge-result CI and release-branch CI are green on the exact head.
7. The candidate and approval identities match section 2.
8. The operator has a retained 117 candidate, migration receipt and rollback
   plan.

Guard activation is its own operation: set the guard, read it back, allow it to
propagate (observed ~2 minutes), merge, confirm the merge-window deployment is
ignored/canceled and the alias did not move, then restore the previous guard.

After merging PR #176, do not assume production changed. Stage and promote only
through `publish-production.mjs`, and verify the exact `/readyz` digest and
authenticated four-tool identity. A PR merge is not a production release.

## 11. Definition of LIVE (must be observed, not inferred)

LIVE requires all of:

- the production alias targets the exact 126 deployment;
- `/readyz` returns the exact 126 digest;
- deployment checks succeeded and Git auto-deploy is disabled;
- authenticated `search` reports the 126 digest and finds all nine
  `t3dotgg/*` skills;
- authenticated `resolve`, `inspect` and `get_content` return the approved
  version hashes and byte digests;
- Codex and OpenCode both complete the four-tool smoke;
- the publication receipt and rollback evidence are retained.

Until then, the correct status is **ENGINEERING READY / EXTERNAL RELEASE GATES
REMAINING**, not LIVE.
