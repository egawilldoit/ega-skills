# EGA Skills 2.0 operator runbook

Deployment architecture: `packages/mcp/VERCEL.md` (authoritative). This
runbook does not define a second deployment path; it lists the exact
pre-deployment, deployment, smoke, and rollback checks for the hosted MCP.

Never print or commit secrets. All values below come from the Vercel project
environment (`ega-skills-mcp`, scope `team_e2x4kf12yL43qmBIs2t2YaD2`) or from
short-lived token files with mode 0600.

For an I1 policy release, independently verify the currently published release
identity from the authenticated production service and retained deployment
before previewing a forward release. Supply that verified digest as
`EGA_SKILLS_TRUSTED_PUBLISHED_RELEASE`; preview rejects a different `--against`
release. This value is an operator-supplied trust anchor, not proof that a
digest is current. Local I1 launchers must set `EGA_SKILLS_TRUSTED_RELEASE` to
their separately trusted expected release digest; a SQLite marker alone cannot
resist replacement of the entire artifact.

## Production publication boundary

The supported production writer is
`scripts/hosted/publish-production.mjs`. Contract R2's revisioned retained
manifest protects the durable promotion path; this script connects that
decision to the Vercel alias, which is a separate last-write-wins surface.
Production publication is supported only on the reviewed Linux host; applying
commands reject other operating systems. Windows CI certifies portable domain
behavior, not execution of the Vercel publication CLI.

Before any alias mutation the gate requires, from live reads:

1. the exact R1/I1 candidate, owner approval, candidate envelope, policy digest,
   skill-version map and source snapshot are digest-bound to each other;
2. the live production alias and the release served by that deployment are the
   exact predecessor recorded in the candidate and approval;
3. Vercel Git production auto-deploy is disabled, the canonical alias is
   present with only recognized direct Vercel-managed aliases on that same
   deployment, and every deployment check has succeeded;
4. the executing Vercel user, team and project equal the approved publisher; and
5. the owner approval is no older than 24 hours.

Staging builds the detached worktree with `vercel build --prod`, then uses
`vercel deploy --prebuilt --prod --skip-domain` to publish that verified output
with the production environment without assigning the public domain. It proves the staged `/readyz`
release digest and rechecks the live predecessor before returning. Retained
deployments are restored using `vercel rollback`, not a second promotion. See
[Vercel staged production deployment](https://vercel.com/docs/cli/deploying-from-cli)
and [promotion and rollback semantics](https://vercel.com/docs/deployments/promoting-a-deployment).
Promotion re-reads the live predecessor
immediately before the write, promotes without `--force`, then polls both the
alias target and `/readyz` until the exact candidate digest is served. A
mismatch restores the recorded predecessor only if this promotion is still the
current alias; an unhealthy current deployment may be restored, but the restored
predecessor must be READY with successful checks before recovery is certified.
If another publication won, the script refuses to clobber it.
Every completed promotion or rollback writes a write-once final receipt bounded
to the approval, candidate, predecessor, deployment and monotonic publication
revision. The reserved `<receipt>.pending` intent is fsynced before mutation and
retained as immutable evidence; it is never truncated into the final receipt.
A handled failure that restored the predecessor writes a separate `FAILED` side
receipt (`<receipt>.failed.json`) at the same revision; it records the attempt
but does not enter or advance the successful receipt chain. A dry-run attempt
performs no mutation and writes no receipt. A blocked applying attempt can
leave a reserved PENDING intent; preserve it. If the publishing process is
killed after the alias moves, run `reconcile` to record the already-live exact
candidate without moving the alias. Receipt files must live outside the
repository and outside any synced source tree.

All applying commands additionally require `--readiness <record.json>`. This is
an external operator certification. The script validates its shape, target
binding and freshness, including that `review_record` is an HTTPS URL, but it
does not fetch or authenticate that record: the release operator must verify
the linked independent review and the actual Vercel access controls. A locally
hashable JSON file does not prove authorship.
The schema is `schema_version: 1`, `verified_at`, `expires_at` (at most 24 hours
apart), `certified_by`, `review_record`, `publisher_vercel_user_id`, `team_id`,
`project_id`, `canonical_alias`, `production_branch`, and the absolute shared
`state_dir`. It also requires `access_controls_reviewed: true`,
`single_writer_controls_reviewed: true`, and `residual_alias_race_accepted: true`.
These flags record the external review; the Vercel API does not establish or
enforce principal exclusivity. Keep this record with the approval and receipts.

All supported publishers must use the same `EGA_PUBLICATION_STATE_DIR` on a
single coordinated filesystem. An existing lease is never reclaimed just
because its timestamp expired. Before manual recovery, prove that the former
process and any Vercel CLI child have stopped, inspect the actual alias and
reconcile any completed publication. Never remove a live writer's lease.
Mutations stop after lease expiry. Restart from fresh observations and valid
approval/readiness records after recovering the stopped operation.

Applying promote, reconcile and rollback reserve and fsync a `PENDING` intent
at `<receipt>.pending` before executing. The final receipt is written to
`--receipt` with `O_EXCL`, fsynced under the lease, and the pending intent is
left untouched. An existing evidence path blocks mutation. Keep incomplete
intent files as evidence; use a new receipt path for reconciliation after
inspecting live state. An interrupted rollback requires manual live-state
reconciliation before retry.

For the first governed promotion, retain and certify the original 117-skill R1
candidate and deployment before staging. There is no fabricated revision-zero
receipt. To restore that original release, use rollback with `--chain` and
`--current` pointing to the first successful promotion receipt, replace
`--target` with `--predecessor-candidate <retained-original-candidate-dir>`, and
supply all normal target flags: `--team`, `--project`, `--publisher`, `--alias`,
`--production-branch`, `--expect-release`, `--expect-deployment`, and
`--expect-revision` (the current receipt's revision). The verified candidate
must match the receipt's exact predecessor release and Hub. Later rollbacks use
an earlier receipt in the contiguous successful chain. Both paths check the
live deployment and platform controls immediately before mutation, and verify
the exact retained deployment and release afterward. Recovery permits an
unhealthy current deployment: the authenticated Vercel API must still identify
the exact deployment bound by the receipt (or this operation's staged ID).
An unavailable readiness endpoint is not represented as a successful probe.
The restored target must pass readiness and deployment checks before a receipt
is certified. Cross-project, cross-Hub,
cross-alias and publisher-rotation receipt chains are rejected; publisher
rotation requires separate reviewed migration support.

The new runtime's `/readyz` reports the exact `release_digest`. This is a public semantic identity,
not a secret; it makes the live promotion verifiable without an OAuth token.
Authenticated MCP verification is still required after promotion.

**Legacy predecessor blocker:** on 2026-10-28, current production returned
HTTP 200 with only `{"status":"ready"}`. That response cannot pass the
publisher's predecessor or restored-target identity probe. An authenticated
MCP digest alone does not satisfy this probe. The supported resolution is the
separately authorized and certified baseline-runtime migration below. Do not
assume the new endpoint already exists, substitute a configured digest for a
live observation, or bypass the publisher.

### Baseline runtime migration (first governed release)

The legacy runtime predates `/readyz` release identity. The migration deploys
the reviewed runtime with the **unchanged retained 117-skill artifact**, so the
new endpoint reports a real digest before any semantic release change. It is a
runtime-only operation, not a publication and not a rollback receipt. The
original legacy deployment and artifact are retained.

The supported migration command is `baseline` in
`scripts/hosted/publish-production.mjs`. It refuses unless all of the following
are live and exact:

- the owner authorization binds the 117 release, the retained candidate, the
  physical artifact-tree digest, the legacy deployment, the legacy deployment's
  immutable source commit, the reviewed implementation commit, the reviewed
  migration source commit, the legacy check policy, the publisher, team,
  project, canonical alias and production branch;
- the live canonical alias targets that exact legacy deployment;
- that deployment is `READY`, its immutable source commit is the authorized
  predecessor commit, Git production auto-deploy is disabled, and every
  production alias is either the canonical alias or a recognized direct
  Vercel-managed automatic alias on that same deployment;
- the legacy deployment's check policy is either `succeeded` (a real successful
  conclusion) or `absent-accepted` (the owner explicitly accepts the pre-check
  immutable deployment). `absent-accepted` is valid only when the deployment
  reports `none`, never `failed` or `pending`;
- `/readyz` is the exact legacy shape: HTTP 200, `status: "ready"`, and **no**
  `release_digest` property. An unavailable probe, a present-but-malformed
  digest, or a response that already carries a digest is not accepted. A 200
  alone is never predecessor proof;
- the migration runtime worktree is clean at the exact authorized commit and
  that commit is reachable from `origin/<production branch>` (`main` for the
  live cutover), and its `packages/mcp/artifact` is the untouched 126 candidate
  tree; the predecessor worktree is clean at the live deployment's commit and
  its `packages/mcp/artifact` is the retained 117 tree. The two artifacts are
  bound separately: only the predecessor artifact is copied into the deployment;
- the two readiness files must be byte-identical to the reviewed implementation
  commit, read from Git objects rather than a working tree;
- the Vercel upload is a fresh detached worktree at the exact runtime commit
  with no untracked or ignored files outside the deliberately replaced artifact
  directory, not the operator's mutable worktree, and the staged deployment must
  report the exact runtime source commit in `meta.githubCommitSha`;
- the staged deployment is `READY` with a successful check conclusion. The
  legacy predecessor may use `absent-accepted` only under its separate rule;
  the new migration deployment always requires `succeeded`.

Prepare the two clean worktrees after the main-branch publication PR is merged.
The readiness files are already present on `main`; the exact reviewed runtime
commit is a commit reachable from `origin/main`. Read the live predecessor
deployment first. If the merge-window build already deployed and serves the
exact 117 digest from the authorized runtime commit, verify it, record it, and
use `baseline-reconcile` instead of running `baseline` again.

```
PRE_COMMIT=$(git -C <repo> rev-parse <live-deployment-source-commit>)
RUNTIME_COMMIT=<exact reviewed commit reachable from origin/main>
REVIEWED_COMMIT="$RUNTIME_COMMIT"

git -C <repo> fetch origin main
git -C <repo> worktree add --detach /secure/predecessor-source "$PRE_COMMIT"
git -C <repo> worktree add --detach /secure/runtime-source "$RUNTIME_COMMIT"
git -C <repo> cat-file -e "$RUNTIME_COMMIT^{commit}"
git -C <repo> merge-base --is-ancestor "$RUNTIME_COMMIT" origin/main
```

Do not use `origin/main` as the commit itself: a branch tip can move after the
owner authorizes it. Do not require the runtime commit to descend from the live
predecessor commit. That cannot hold after the production branch moved to
`main`: `main` carries the 126 candidate while the live 117 deployment was built
from `release/2.0`. The publisher instead binds:

- the **runtime source** `RUNTIME_COMMIT`, which must be reachable from
  `origin/main` and whose artifact tree must be the untouched 126 candidate;
- the **artifact source** `PRE_COMMIT`, the live deployment's immutable commit,
  whose artifact tree must be the retained 117 baseline.

Record the retained identities from both worktrees:

```
node scripts/hosted/validate-artifact.mjs /secure/predecessor-source/packages/mcp/artifact
node scripts/hosted/validate-artifact.mjs /secure/runtime-source/packages/mcp/artifact
(cd /secure/predecessor-source && find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum)
(cd /secure/runtime-source && find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum)
```

The predecessor run must report release
`sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`
and tree digest
`sha256:ad9f0cfa1c68a1531c964d921dfc4e6acf94357447517138aa7d69187f88276a`.
The runtime run must report the unchanged 126 candidate tree
`sha256:08e086198728b8eeb2dd4dfa8284c0b08ec109f16f4702c724d773a34b3fc13a`.
The candidate envelope digest is
`sha256:5c441c3f0d7f5acf0cbdf005e6b4db8d05105783c38f37b4939b3b0ae54a45bc`.
The publisher refuses either tree when it does not match its separate binding.

Create the authorization envelope from the owner-approved payload. The
`baseline-authorize` command validates and canonicalizes; it does not grant or
authenticate approval, and the script never records an owner decision on its
own. The operator must verify the decision at `approval_record`:

```
node scripts/hosted/publish-production.mjs baseline-authorize \
  --payload /secure/outside-repo/baseline-authorization-payload.json \
  --out /secure/outside-repo/baseline-authorization.json
```

The authorization envelope is `schema_version: 3`. The payload fields are
exactly:

```json
{
  "approval_record": "https://github.com/egawilldoit/ega-skills/issues/168#issuecomment-<id>",
  "approved_at": "<RFC3339 UTC>",
  "approved_by": "<release owner>",
  "baseline_artifact_tree_digest": "sha256:ad9f…",
  "baseline_candidate_digest": "sha256:5c44…",
  "baseline_release_digest": "sha256:3c08…",
  "canonical_alias": "ega-skills-mcp.vercel.app",
  "candidate_artifact_tree_digest": "sha256:08e0…",
  "candidate_release_digest": "sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266",
  "runtime_vercel_config_digest": "sha256:<digest of packages/mcp/vercel.json at the runtime commit>",
  "hub_id": "personal",
  "legacy_deployment_checks": "absent-accepted",
  "migration_source_commit": "<exact main-reachable runtime commit>",
  "predecessor_deployment_id": "<live legacy deployment>",
  "predecessor_source_commit": "<live deployment meta.githubCommitSha>",
  "production_branch": "main",
  "publisher": {
    "owner_subject": "<owner>",
    "project_id": "prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG",
    "team_id": "team_e2x4kf12yL43qmBIs2t2YaD2",
    "vercel_user_id": "Dc0U1Ov3Zh5zeFKeic10bVWj"
  },
  "reviewed_runtime_commit": "<same exact main-reachable runtime commit>",
  "scope": "runtime-readiness-only"
}
```

Dry-run (no mutation, no receipt):

```
EGA_VERCEL_TOKEN_FILE=/secure/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs baseline \
  --authorization /secure/outside-repo/baseline-authorization.json \
  --predecessor-source /secure/predecessor-source \
  --migration-source /secure/runtime-source \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG \
  --publisher Dc0U1Ov3Zh5zeFKeic10bVWj \
  --production-branch main \
  --alias ega-skills-mcp.vercel.app \
  --expect-deployment <live legacy deployment> \
  --expect-release sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297 \
  --staging-out /secure/outside-repo/baseline-staging.json \
  --receipt /secure/outside-repo/baseline-receipt.json
```

Apply the same command with `--readiness /secure/outside-repo/readiness.json
--apply`. The command creates a fresh detached worktree at the exact runtime
commit, requires it to contain no untracked or ignored files, replaces only
`packages/mcp/artifact` with the retained 117 artifact from the predecessor
worktree, re-verifies the assembled tree, builds it with `vercel build --prod`,
and stages the verified output with `vercel deploy --prebuilt --prod
--skip-domain --project <id> --meta githubCommitSha=<runtime commit>
--meta githubCommitRef=main`. It requires the staged deployment to be `READY`
with a successful check conclusion, to report the exact runtime source commit,
and to serve the exact 117 digest. It then fsyncs the immutable staging record,
promotes without `--force`, re-reads the alias, deployment, source commit and
`/readyz`, and writes the final migration receipt to a new file (the reserved
`<receipt>.pending` intent is never overwritten). It never deploys the 126
artifact and never changes the semantic release.

Success is all of:

- `/readyz` returns HTTP 200 with
  `release_digest: sha256:3c08…`, `status: "ready"`;
- the alias targets the staged deployment, which is `READY` with successful
  checks;
- authenticated MCP still reports the 117 release and no `t3dotgg/*` skills;
- the staging record, authorization, readiness record and receipt are retained
  outside the repository.

If the process dies after the alias moved, use `baseline-reconcile` with the
same authorization, sources, target flags, `--staging
/secure/outside-repo/baseline-staging.json` and a **new** receipt path. It never
moves the alias; it accepts only the exact staged deployment and exact
`meta.githubCommitSha` serving the exact 117 digest, and it re-reads the live
identity before writing the receipt. If the migration fails after promotion,
the command restores the original legacy deployment and verifies the legacy
readiness shape again; if recovery returns evidence, the FAILED receipt is
written as `<receipt>.failed.json`. If recovery itself fails, the PENDING intent
and staging record remain and manual reconciliation is mandatory — do not claim
a successful restore without a re-observed legacy readiness shape. A bare
`vercel rollback` to the original legacy deployment after a successful migration
is containment only (the normal publisher cannot verify its legacy readiness);
record it as an audit gap and re-run the migration before the governed
promotion.

The subsequent 126-skill promotion remains a normal `stage`/`promote
--genesis` operation with `--expect-deployment <migration deployment>` and
`--expect-release sha256:3c08…`. The migration deployment, not the original
legacy deployment, is the governed rollback predecessor; the original remains
retained as the emergency containment target.

### What is and is not atomic

Vercel exposes no compare-and-swap operation for an alias, no project-scoped
deploy token ACL, and no way for a repository process to revoke a team
principal's dashboard promotion right. The boundary therefore does **not**
claim alias-level atomicity. It makes EGA's publication decision serialized and
reviewable, and it refuses to run when an observable bypass path exists.

Residual risk is explicit: a Vercel principal that can independently promote or
assign the production alias can still move it. The release owner must, before
the first governed promotion:

- disable Vercel Git deployments for the production branch (`main`) and
  verify the setting is read back;
- make the publisher token the only production-capable credential, and remove
  deployment/promotion rights from every other principal that does not need
  them;
- keep the token in a `0600` file and inject it only as `VERCEL_TOKEN` to the
  child process (`EGA_VERCEL_TOKEN_FILE`);
- re-check the project after any team membership change; and
- treat an unexplained alias move as a security incident, not a release
  retry.

If these platform controls cannot be established, do not promote. The
independent review of this boundary must reject any claim of an atomic
guarantee that the platform cannot enforce.

### Vercel observation compatibility (issue #168)

`gitProviderOptions.createDeployments` controls GitHub `deployment_status`
notifications; disabling it does **not** disable Vercel Git builds. See the
[Vercel provider's authoritative field documentation](https://github.com/vercel/terraform-provider-vercel/blob/main/vercel/resource_project.go)
and [Git configuration](https://vercel.com/docs/project-configuration/git-configuration).
An ignored build command is also not a production publication ACL. The
publisher accepts an observable `git.deploymentEnabled: false` or an exact
production-branch false rule with exclusively false rules. If the project API
reports the field, that value is authoritative. Only when it omits the field
(absent or `null`) may the publisher verify the exact reviewed runtime commit's
`packages/mcp/vercel.json` with a matching Root Directory of `packages/mcp`: the file is read from Git objects, must contain
`git.deploymentEnabled: false` (or the exact-branch all-false rule), and its
SHA-256 digest and source commit are bound by the baseline authorization, or by
the exact `--expect-source-commit` and staging source commit for a normal
release. Other shapes, including deployment-policy allowlists, remain blocked. A missing
field is never interpreted as disabled; only the exact runtime-config fallback
above may supply the control.

The publisher resolves the canonical alias with `GET /v4/aliases/{alias}`,
retrieves its full immutable deployment and complete deployment alias inventory,
re-reads every non-canonical alias, and checks the alias again after probing
readiness. A recent deployment list does not contain the necessary alias or
check fields and may list an unpromoted staged build first. Alias movement
during the observation is a failure. These bracketing reads detect observed
movement; they do not provide compare-and-swap or eliminate a
change-and-restore race. Absent deployment checks remain `none`. Additional
automatic aliases are accepted only when they are direct, non-redirected,
recognized Vercel-managed aliases on the same project and deployment; unknown,
duplicate, redirected or foreign aliases still block.

Live read-only inspection on 2026-11-01 found three direct production aliases
(the canonical alias and two Vercel-generated aliases). At earlier reads the
effective Git deployment switch and deployment check conclusion were not
observable. Re-read them; do not treat a previous observation, `git: null`, or a
READY state as a passed gate. Do not disable notification events or invent
successful checks to make the gate pass.

## Pre-deployment

1. Verify the exact release SHA is green in CI:
   `gh run list --repo egawilldoit/ega-skills --branch main --limit 5`
   `gh run view <run-id> --repo egawilldoit/ega-skills`
   Require `foundation (ubuntu-latest)`, `foundation (windows-2022)`, and
   `contract-f rls (ubuntu-latest)` to pass. Inspect both foundation logs to
   confirm `tests/hashing-traversal.test.mjs` and
   `tests/hashing-traversal-toctou.test.mjs` executed and passed. Hashing is
   part of foundation; no separate hashing workflow check is emitted.
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

- Production Branch `main`, Root Directory `packages/mcp`,
  Install `pnpm install --frozen-lockfile`, Build `pnpm -w build`,
  Node 24, include files outside root.
- Production deployment is a release-owner action performed only through
  `publish-production.mjs`. Preview/staging verification uses the same project
  with preview-scoped environment values and must never change the production
  alias.

Record the exact current deployment and release before staging:

```
node scripts/hosted/publish-production.mjs verify \
  --alias ega-skills-mcp.vercel.app
```

Run every command from a **clean checkout at the exact tested commit**. The CLI
refuses a dirty worktree, requires the checkout's `packages/mcp/artifact` to be
the exact `--candidate`, and deploys a fresh detached worktree at `HEAD` with
`--meta githubCommitSha=<HEAD>`. `--expect-source-commit` must name that exact
commit, and the commit must be reachable from `origin/main` (fetch it
first; `EGA_RELEASE_REF` is an explicit override for a reviewed release ref).
The staging record binds that source commit; `promote` and `reconcile` refuse a
staging record or deployment identity whose source commit does not match.

Stage, then promote, using the approval packet and the independently verified
predecessor (all values are required; `stage`/`promote` refuse a mismatch):

```
EGA_VERCEL_TOKEN_FILE=/path/to/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs stage \
  --candidate /path/to/candidate \
  --approval /path/to/approval.json \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_… --publisher <vercel-user-id> \
  --production-branch main \
  --alias ega-skills-mcp.vercel.app \
  --expect-release sha256:… --expect-deployment dpl_… \
  --expect-revision <n> --expect-source-commit <exact merged release SHA> \
  --staging-out /secure/outside-repo/staging-<n>.json \
  --readiness /secure/outside-repo/readiness.json --apply

EGA_VERCEL_TOKEN_FILE=/path/to/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs promote \
  --candidate /path/to/candidate \
  --approval /path/to/approval.json \
  --staging /secure/outside-repo/staging-<n>.json \
  --team team_e2x4kf12yL43qmBIs2t2YaD2 \
  --project prj_… --publisher <vercel-user-id> \
  --production-branch main \
  --alias ega-skills-mcp.vercel.app \
  --expect-release sha256:… --expect-deployment dpl_… \
  --expect-revision <n> --expect-source-commit <exact merged release SHA> \
  --staged-deployment dpl_… \
  --genesis \
  --receipt /secure/outside-repo/receipt-<n>.json \
  --readiness /secure/outside-repo/readiness.json --apply
```

Promotion requires the staging record (`--staging`); `--staged-deployment` alone
is not accepted. If the process is killed after the alias moved, do not re-run
`promote`. Reconcile the observed result:

```
EGA_VERCEL_TOKEN_FILE=/path/to/vercel.token \
EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
node scripts/hosted/publish-production.mjs reconcile \
  --candidate /path/to/candidate --approval /path/to/approval.json \
  --staging /secure/outside-repo/staging-<n>.json \
  --team … --project … --publisher … --production-branch main \
  --alias ega-skills-mcp.vercel.app \
  --expect-release sha256:… --expect-deployment dpl_… \
  --expect-revision <n> --expect-source-commit <exact merged release SHA> \
  --staged-deployment dpl_… --genesis \
  --receipt /secure/outside-repo/receipt-<n>.json \
  --readiness /secure/outside-repo/readiness.json --apply
```

`reconcile` refuses unless the live alias and served release are exactly the
staged deployment and candidate. It never moves the alias.

Use `--genesis` only for the first governed release (revision 0). Every later
promotion must pass `--previous-receipt <the last receipt>` instead, and the
script refuses a receipt/revision/predecessor mismatch.

`--staging-out` writes the exact staging record that `--staging` consumes; it
requires `--apply`, because a dry-run stage creates no deployment. The stage
command's stdout also contains the record under `.staging`; the CLI accepts that
wrapper for convenience, but the file written by `--staging-out` is the
supported handoff. `EGA_PUBLICATION_STATE_DIR` must be on storage
shared by every publisher; a per-machine directory narrows but does not remove
the race. Both the final receipt and its `.pending` intent are created with
`O_EXCL`; a retry must use a new receipt name so the previous evidence is never
overwritten.

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
   release digest (recorded in pre-deployment step 5 and in the publication
   receipt chain).
2. Re-point production through the boundary, not a bare `vercel` command. The
   target must be an earlier receipt in the contiguous chain:

   ```
   EGA_VERCEL_TOKEN_FILE=/path/to/vercel.token \
   EGA_PUBLICATION_STATE_DIR=/shared/ega-publication \
   node scripts/hosted/publish-production.mjs rollback \
     --chain /secure/receipt-3.json,/secure/receipt-2.json,/secure/receipt-1.json \
     --current /secure/receipt-3.json \
     --target /secure/receipt-2.json \
     --team team_e2x4kf12yL43qmBIs2t2YaD2 \
     --project prj_… --publisher <vercel-user-id> \
     --production-branch main \
     --runtime-source-commit <clean reviewed commit for the runtime-config control> \
     --alias ega-skills-mcp.vercel.app \
     --expect-revision 3 --expect-deployment <current-dpl-id> \
     --expect-release <current-release-digest> \
     --receipt /secure/receipt-4.json \
     --readiness /secure/outside-repo/readiness.json --apply
   ```

   `--runtime-source-commit` is optional. When the project API omits
   `git.deploymentEnabled`, a rollback must supply a clean, reviewed commit whose
   `packages/mcp/vercel.json` contains the exact false rule; otherwise the
   publisher refuses rather than guessing.

   A bare `vercel rollback`/`vercel promote` is an emergency containment
   action only. Record it, re-run the boundary verification immediately, and
   treat the missing receipt as an audit gap.
3. Re-run the post-deployment smoke against the production origin and confirm
   `/readyz` 200 and the expected `release_digest`.
4. To restore the new release, roll back to its earlier receipt using the
   advanced current receipt and complete chain, then repeat the smoke. Vercel
   requires `rollback` for deployments that have previously served production.
   Every successful restoration advances the revision; it never decrements it.

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

## Hosted catalog bootstrap (registering the release)

Deploying the console does **not** make its catalog readable. Every artifact
route is gated by `authorizeArtifactRequest`, which reads `public.hub_releases`
under the **caller's own** RLS and refuses with `403
E_WEB_CONTROL_PLANE_FORBIDDEN` when the deployed digest is not readable. That
gate is intended (EGA-719); it is satisfied by a registration, not by the
deployment.

Nothing in `packages/` or `apps/` writes `hubs` or `hub_releases`, and the
migrations grant `authenticated` **SELECT only**, so the first registration is by
definition a trusted-publisher (service-role / database-owner) operation. Use:

```
node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid>
```

Without `--apply` this contacts no database: it verifies the committed artifact
through `loadHostedReleaseSnapshot` (the same loader the deployment stages with)
and prints the **exact transaction** for review. Applying it needs a receipt
path — the receipt is what makes a later rollback safe:

```
EGA_BOOTSTRAP_DATABASE_URL=<service-role-or-owner-dsn> \
  node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> \
    --receipt ./bootstrap-receipt.json --apply

EGA_BOOTSTRAP_DATABASE_URL=<service-role-or-owner-dsn> \
  node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> \
    --receipt ./bootstrap-receipt.json --rollback
```

The connection string is read from the environment only, is decomposed into
libpq's own `PG*` environment variables on the child process, and never appears
in an argument, a log line or a reported error. Do not paste it into a ticket, a
commit, or a shared terminal.

What it writes, and nothing else:

| Table | Row |
| --- | --- |
| `public.hubs` | `id` = `--hub`, `workspace_id` = `--workspace`, `visibility = 'private'` |
| `public.hub_releases` | `hub_id` = `--hub`, `release_digest` = the verified `hub_release_digest`, `sqlite_artifact_digest` = the verified `sqlite_artifact_digest` |

`visibility` is fixed to `private`: it is readable by the owning subject under
the original control-plane policy **and** under Contract F, and it grants nothing
to anyone else. Widening it is a separate authorization decision.

**The hub UUID is an operator input, not a derivation.** The artifact declares
`payload.hub_id = "personal"`, which is not a UUID, and `public.hubs` has no
name or slug column, so there is no deterministic mapping to invent. Record the
chosen UUID out of band (it is the handle the rollback needs).

Guarantees:

- **Idempotent.** A second `--apply` writes nothing and does not fail. It also
  leaves the original receipt byte-for-byte intact: a rerun never claims
  ownership of rows the first run created.
- **Never overwrites.** Both writes are `on conflict … do nothing`, and the
  authoritative identity check runs **inside the same transaction, after the
  inserts, under `row locks`** — so a conflicting *concurrent* writer makes our
  insert a no-op and then fails the check, aborting every write from this
  operation. A hub in another workspace, a release registered with a different
  SQLite digest, or an explicit `security_denies` record covering either raises.
  The forward transaction contains no `UPDATE` and no `DELETE` statement.
- **Stale receipt checks happen before commit.** If an apply would create a row
  the existing receipt records as reused, the complete transaction aborts and
  leaves the original receipt unchanged.
- **A release-only rollback validates its parent.** A reused hub is locked and
  checked against the recorded workspace and visibility before its release can
  be deleted; a changed parent aborts the rollback.
- **The execution receipt decides the rollback.** `--apply` records the exact
  workspace, hub, release and SQLite identities plus **which of the two rows this
  execution actually inserted** (a `hub_releases` row is reported as inserted
  only when the insert affected a row). `--rollback` renders its deletes from
  that receipt, so a row the bootstrap merely reused is never a deletion
  candidate, and every delete is bound to the recorded identity — a row that has
  since changed aborts the rollback and is left alone. A missing, malformed,
  mismatched or tampered receipt refuses. A completed rollback consumes the
  receipt; a second rollback then refuses rather than silently doing nothing.
- **Dependency-aware.** It deletes the release before the hub and refuses
  (removing nothing) when a stable pointer, artifact inventory, public
  publication, project context, another release on the same hub, or a changed
  owning workspace now depends on what it would remove. It never cascades.

Run `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact` and
`node scripts/web/stage-artifact.mjs --check-only` first if you want the same
verification the deployment performs reported separately.

This step does not touch `hub_stable_pointers`, `immutable_objects`,
`hub_release_artifacts`, `public_hub_publications` or `audit_events`, and it
changes no schema, policy, grant or role. Those tables have no writer anywhere in
this repository; the rollback treats any row in them as a dependency and refuses
rather than cascading.

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
