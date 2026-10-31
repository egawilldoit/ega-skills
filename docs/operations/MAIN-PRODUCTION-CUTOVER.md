# MCP production branch cutover: release/2.0 to main

Status: **NOT AUTHORIZED FOR PRODUCTION**. This checklist is a proposed migration; existing `docs/operations/RELEASE-2.0-HANDOFF.md` remains authoritative for the 117-skill baseline until the owner approves a replacement flow.

## Verified starting facts (2026-10-31)

- Project `ega-skills-mcp`: `prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG`, team `team_e2x4kf12yL43qmBIs2t2YaD2`.
- Canonical production alias `ega-skills-mcp.vercel.app` still targets READY 117-skill deployment `dpl_MGiFbFtwcibpc9wY7BiK7gXkH3zH`, sourced from `release/2.0` at `3b3cc96804747e7a5abf11aa15436b8e41ccfbb4`. Re-read all live values at execution time.
- The deployment has **three** live aliases. Additional automatic names: `ega-skills-mcp-git-release-20-egas-projects-4fb87621.vercel.app` and `ega-skills-mcp-egas-projects-4fb87621.vercel.app`.
- The authenticated project read through the available connector omits `git.deploymentEnabled` and linked production-branch details. No valid read-back of Git auto-deploy suppression has been obtained.
- The current deployment inspection does not expose a successful `checksConclusion`. Missing is **not** proof of success.
- Release PR #176 is draft and **must not be merged** to the old release branch.

## Code changes in this PR

- `packages/mcp/vercel.json` explicitly sets `git.deploymentEnabled: false`, per Vercel's documented configuration. This controls Git auto-builds **when the project consumes this configuration**; merging this PR into `main` does not prove that the existing `release/2.0` live project already applied it.
- The publisher binds the approved source commit ancestry and CLI `githubCommitRef` to the explicitly supplied `--production-branch`, allowing `main` without silently accepting a branch mismatch.
- The live Vercel observer rejects branch mismatches, redirected canonical/assigned aliases, duplicate/incomplete alias inventories, and missing successful check conclusions. It **never ignores** the two extra existing aliases.

## Required execution order — no shortcuts

1. **Lock down automatic deployment and read it back.** Before any merge into a currently tracked production branch, use a verified Vercel control that disables production Git deployments. Read back `git.deploymentEnabled === false` for the actual project, or the exact production branch mapped to `false` with no enabling rules. An ignored build step, `autoAssignCustomDomains: false`, GitHub deployment status notifications, and the planned `vercel.json` commit are not sufficient read-back proof. Preserve current deployment and aliases.
2. **Review the code PR and run exact-head CI** including `tests/hosted/vercel-observations.test.mjs`, `tests/hosted/baseline-migration.test.mjs`, `tests/hosted/production-publication.test.mjs`. The PR must not cause an automatic production deployment.
3. **Resolve alias and check blockers, not silence them.** Determine whether Vercel's two additional automatic aliases can be removed without an automatic re-creation or bypass. Validate complete deployment alias inventory after every change. Arrange genuine successful Vercel deployment checks for the staged baseline and 126-skill deployment; no fabricated `succeeded` state. If impossible on current plan/configuration, stop and revisit the single-alias/check policy with an independent security review.
4. **Certify single writer and owner authorization.** Independently confirm only the intended publisher has production write ability, preserve an outside-repo review record and unexpired authorizations, and record residual last-write-wins alias risk. Never create attestations on the owner's behalf.
5. **Migrate the retained 117-skill runtime first** using the exact reviewed `M1` commit from `release/2.0`, the existing handoff baseline authorization and immutable source/artifact verification. Run dry-run, then stage with `--prod --skip-domain`, verify exact retained 117 digest, successful deployment checks, then promote via the governed publisher. Keep receipt and a tested rollback. If the live runtime is already migrated, reconcile; do not rerun baseline.
6. **Cut over only after retaining the baseline:** set the Vercel Production environment's Branch Tracking to `main` while Git auto-deploy remains disabled. Read back the new branch and auto-deploy switch from the live project. The repository already defaults to `main`. Do not merge draft PR #176 into `release/2.0`.
7. **Publish 126 from an approved exact `main` SHA.** Re-approve the candidate after branch transition with `--production-branch main` and `--expect-source-commit <exact-main-sha>`. Run tests, stage only, inspect source metadata, verify 126 artifact, all 117 existing versions unchanged and nine `t3dotgg/*` pinned versions, successful checks and real four-tool OAuth smoke. Promote only with a valid approval and receipt.
8. **Post-release:** confirm canonical alias exact deployment and `/readyz` digest; verify all nine TStack skills through the hosted interface, observe errors, and retain an explicit rollback command and receipt. Leave `release/2.0` unmerged/archived until owner policy decides its disposition.

## Stop conditions

Do not proceed if the Git auto-deploy switch cannot be read back, the live alias is not exact, there is more than one production alias, deployment checks are absent/failed/pending for a newly staged build, source metadata mismatches, the reviewed host is not Linux, the publisher/owner approval is missing, or a rollback cannot restore the retained 117 deployment.

**Vercel official references:** https://vercel.com/docs/project-configuration/git-configuration , https://vercel.com/docs/git , https://vercel.com/docs/deployment-checks , https://vercel.com/docs/deployments/promoting-a-deployment .
