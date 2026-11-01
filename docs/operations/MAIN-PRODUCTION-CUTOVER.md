# MCP production branch cutover: `release/2.0` to `main`

Status: **IMPLEMENTATION READY / EXECUTION GATED ON LIVE READBACK**. The live
Vercel project already tracks `main`; the retained 117-skill deployment was
built from `release/2.0`. This document describes the supported migration of
that retained 117 runtime. It does not authorize the 126-skill promotion and it
does not make `release/2.0` a production branch again.

## Live facts to re-read before acting

- Project `ega-skills-mcp`: `prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG`, team
  `team_e2x4kf12yL43qmBIs2t2YaD2`.
- Canonical production alias `ega-skills-mcp.vercel.app` targets the READY
  117-skill deployment. Re-read the deployment id; the last observed id was
  `dpl_MGiFbFtwcibpc9wY7BiK7gXkH3zH`, built from `release/2.0` at
  `3b3cc96804747e7a5abf11aa15436b8e41ccfbb4`.
- The live alias inventory has three direct aliases: the canonical alias,
  `ega-skills-mcp-git-release-20-egas-projects-4fb87621.vercel.app`, and
  `ega-skills-mcp-egas-projects-4fb87621.vercel.app`. Each must resolve directly
  to the same project and deployment. Do not delete aliases.
- `/readyz` still returns the legacy `{"status":"ready"}` shape without a
  release digest until the migration succeeds.
- `git.deploymentEnabled` in the live project readback has been absent or
  `null`. Repository config is not live evidence: `packages/mcp/vercel.json`
  sets `git.deploymentEnabled: false`, but that only applies when the live
  project consumes that configuration. A missing or unreadable live setting is
  a blocker, not success.
- The last live readback did not expose a successful `checksConclusion` for the
  retained deployment. Missing is not success. The legacy predecessor may only
  use the explicit `absent-accepted` owner path when it is `READY`, serves the
  exact 117 artifact, and `/readyz` is the legacy shape. The new migration
  deployment always requires `checksConclusion: "succeeded"`.
- PR #176 is a draft from `main` to `release/2.0`. Do not merge, update, or use
  it as authority for the `main` production branch.

## What the code now binds

The publisher and its domain gate implement two independent source bindings:

1. **Runtime source** — `migration_source_commit` must be the clean checkout
   HEAD, must be reachable from `origin/main` (`origin/<production branch>`),
   and must contain the untouched 126-skill candidate artifact tree. Its
   readiness files must match the pinned reviewed implementation.
2. **Artifact source** — the live predecessor deployment's immutable commit
   supplies only `packages/mcp/artifact`. Its tree must reproduce the exact 117
   tree `sha256:ad9f0cfa1c68a1531c964d921dfc4e6acf94357447517138aa7d69187f88276a`.

The deployment is assembled from the reviewed runtime plus the retained 117
artifact. The runtime worktree's 126 artifact is verified and then replaced in
the staged copy; it is never deployed. This is why the old
`predecessor → migration` "three-file delta" rule no longer applies: it was
valid only while the live deployment and the migration commit were on the same
release branch.

Authorization binds `production_branch: main`, the exact runtime commit, the
exact predecessor commit, the 117 release/candidate/tree digests, and the
approved 126 release plus its untouched tree digest. The staging record binds
the runtime commit, the 117 release/candidate/tree and the authorization
digest; the receipt additionally binds the predecessor commit and both
deployments. The 126 approval/tree bindings travel with that digest.

Production aliases are fail-closed but no longer pretend only one exists. The
gate accepts the canonical alias and narrowly recognized direct Vercel-managed
automatic aliases (`<project>-<vercel-team-slug>-<8hex>.vercel.app` and
`<project>-git-<branch>-<vercel-team-slug>-<8hex>.vercel.app`, where `<branch>`
is the authorized production branch or the deployment's own Git ref). It
combines the deployment inventory with project-level production aliases,
re-reads every non-canonical name, and requires the same project and
deployment. It rejects unknown names, custom domains, redirects, duplicate
names in either view, incomplete pages, and aliases targeting another
deployment. It never deletes an alias.

## Required execution order

1. **Read the live gates.** Canonical alias target, complete alias inventory,
   deployment state, source commit/ref, effective Git auto-deploy setting,
   publisher identity, and deployment checks. A 403, missing field, `git: null`,
   or absent check conclusion is a stop condition.
2. **Review and merge the implementation PR into `main`.** Run exact-head CI,
   including `tests/hosted/baseline-migration.test.mjs`,
   `tests/hosted/vercel-observations.test.mjs`, and
   `tests/hosted/production-publication.test.mjs`. Record the merge SHA; that
   exact commit is the candidate runtime source. Disable live automatic Git
   deployments through a verified Vercel control and read it back.
3. **Certify the retained predecessor.** Verify the live deployment is READY,
   serves the legacy `/readyz` shape, its immutable source commit is the
   authorized predecessor, and its artifact tree is the exact 117 tree. Use
   `absent-accepted` only under the documented owner acceptance; otherwise
   require a real successful check.
4. **Prepare both clean worktrees.** Predecessor at the live source commit;
   runtime at the exact main-reachable reviewed commit. Verify the 117 tree and
   the untouched 126 tree separately. Do not install dependencies in either.
5. **Authorize and dry-run.** Bind `production_branch: main`, both commits,
   both trees, the candidate, publisher, alias, and predecessor. Run `baseline`
   without `--apply`; it must report READY and perform no mutation.
6. **Apply the baseline migration only.** Stage with `--prod --skip-domain`,
   verify the staged deployment is READY with successful checks, source
   metadata equals the runtime commit, and `/readyz` serves the exact 117
   digest. Promote without `--force`; keep the staging record and write-once
   receipt outside the repository. Preserve the original deployment and all
   aliases.
7. **Verify production.** Canonical `/readyz` reports the exact 117 digest; the
   alias inventory is complete and direct; authenticated MCP still reports 117
   skills and no `t3dotgg/*` skills; the 126 candidate was not deployed.
8. **Rollback path.** Restore the retained 117 deployment from the recorded
   predecessor/receipt using the governed rollback path, or use
   `baseline-reconcile` for an interrupted migration. A bare `vercel rollback`
   to the original legacy deployment is containment only and must be recorded
   as an audit gap.

## Stop conditions

Do not proceed if the canonical alias is not exact, any alias is unknown or
redirected, the inventory is incomplete, Git auto-deploy is not observably
disabled for `main`, the publisher token is not the approved user, the legacy
check policy is not explicitly satisfied, the reviewed runtime is not reachable
from `origin/main`, either artifact tree mismatches, the staged deployment is
not READY with successful checks, or a verified rollback is unavailable.

## Vercel references

- https://vercel.com/docs/project-configuration/git-configuration
- https://vercel.com/docs/git
- https://vercel.com/docs/deployment-checks
- https://vercel.com/docs/deployments/promoting-a-deployment
