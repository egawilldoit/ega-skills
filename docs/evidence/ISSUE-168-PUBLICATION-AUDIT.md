# Issue 168 — publication security follow-up (2026-10-28)

Scope: merged implementation PR #172 (`a86603fb12caffbb6acdb1a2c1eec9db4cd57bae`),
frozen I1, its source/version/routing evidence, and the actual production
publication runner. This follow-up does not adopt a source or authorize a
release. Exact-head independent re-review and CI are recorded in the follow-up
PR; earlier approval of PR #172 does not certify these fixes.

## Findings and remediation

The first independent audit returned **REVISE**. No CRITICAL finding was
identified. The following findings are addressed in this patch:

| Severity | Finding | Remediation |
| --- | --- | --- |
| HIGH | Rollback bypassed live publisher/project/alias/platform validation. | Bind the current revision/deployment/release and receipt actor to the live target; re-read before mutation and verify exact retained deployment afterward. |
| HIGH | Receipt chains could cross Hub, alias or publisher boundaries. | Reject boundary changes in the domain verifier and rollback path. |
| HIGH | Expiry could reclaim a lease while its original writer was still running. | Never reclaim an existing lease automatically; check ownership and expiry before each mutation, bound CLI execution, and require stopped-writer reconciliation for manual recovery. |
| HIGH | The first governed release could not restore the original 117-skill production release. | Accept its independently verified retained R1 predecessor candidate, bound to the first receipt; never invent a revision-zero receipt. |
| MEDIUM | A receipt was created after alias mutation and after lease release. | Reserve/fsync intent first; fsync the successful receipt under the lease; preserve interrupted intent for reconciliation. |
| HIGH | Recovery could either certify an unhealthy retained target or refuse to escape an unhealthy current deployment. | Recover using authenticated API identity for the exact current deployment even when `/readyz` returns 503; require READY, successful checks and the exact served digest on the restored target. |
| MEDIUM | Windows readiness fixture was not a native absolute path; the CLI used an unsupported command-script spawning path. | Use the native temporary directory and explicitly reject applying publication on non-Linux hosts. Windows domain CI does not certify live publication. |
| MEDIUM | Preview staging used the wrong environment; retained releases used the forward-promotion command. | Stage with production environment and `--skip-domain`, verify the alias stayed on the predecessor, and use `vercel rollback` for retained deployments. |

The second independent pass confirmed the original five fixes and identified
the recovery-health and Windows corrections. A further pass reproduced the
unhealthy-current outage case; its HTTP-503 and failed-check regressions are
included. A final exact-head review remains
mandatory after the complete patch. No test receipt or synthetic approval is
production authority.

## Platform boundary and release prerequisites

A filesystem lease coordinates supported writers using that same filesystem.
It cannot constrain another Vercel operator, dashboard, Git integration or
independent API client. Repeated live reads do not provide alias compare-and-swap.
The runner therefore requires a fresh, exact-target external publication-readiness
record for every applying command. Its booleans are review attestations, not
Vercel ACL enforcement or proof of authorship. The genuine linked review and
actual account controls must be verified before execution. Residual alias races
require explicit release-owner acceptance. An unverified readiness record is a
release blocker.

The supported staged build and retained recovery follow the
[Vercel CLI deployment workflow](https://vercel.com/docs/cli/deploying-from-cli)
and [promotion/rollback semantics](https://vercel.com/docs/deployments/promoting-a-deployment).
[Vercel access roles](https://vercel.com/docs/rbac/access-roles) document other
production-capable principals; this wrapper does not revoke their permissions.

Host-side no-delegation, read-only, merge and deployment restrictions remain
outside the four read-only MCP tools. No real external executing host has been
certified in this audit. Original Full Send/Full Stop instructions concerning
testing permissions and project-file overrides remain untrusted advice and
cannot grant actual authorization. Missing providers must be reported honestly.

## Local validation and independent review

The independent reviewer returned **APPROVE** for the scoped remediation after
reproducing the final focused tests. This certifies the reviewed code, not live
platform controls or authority to publish. Final committed-head review and CI
must still match the PR head.

| Gate | Result on 2026-10-28 |
| --- | --- |
| Domain build | PASS |
| Typecheck | PASS |
| Broad bounded suite in the audit worktree | 2,126 passed, 0 failed, 7 skipped |
| Focused publication suite after outage-recovery correction | 23 passed, 0 failed, 0 skipped; independently repeated |
| Final focused suite including legacy-readiness refusal | 24 passed, 0 failed, 0 skipped |
| Frozen specifications and Contracts A/B/C/G | PASS |
| Current generated catalog | PASS; original 117-skill release preserved |
| Frozen I1 document against `d6e527af503444a1e45abb237554d427d00b9204` | Unchanged |

The broad suite ran while the audit was being completed; the final focused
publication suite covers the subsequent recovery correction. Required Linux and
Windows CI must execute the complete final commit before merge. Local results
do not replace that gate.

The committed discovery harness was also rerun against the unchanged baseline.
It returned exit 1 for its known quality failures: 22 wrong automatic selections,
41/81 top-1 and 70/81 top-3. That is a reproduced baseline failure, not a clean
evaluation or a newly introduced integration regression.

## Evidence and remaining gate

The final local checks and fresh semantic reproduction are recorded in the
follow-up PR and approval packet. No new governed 126-skill candidate, physical
SQLite certification, canonical adoption or production promotion is asserted.

Fresh source reacquisition, read-only CLI projection and independent semantic
assembly reproduced `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`.
All nine versions and 117 existing versions matched. The integrated resolver
passed 27 positive alternatives, nine explicit references, 11 negative cases
and all 82 automatic-selection comparisons. Discovery rates were corrected
to 41/81 top-1 unchanged and 70/81 → 71/81 top-3, excluding the one pending
intent as the committed harness requires. All 19 candidate-list changes remain
individually disclosed. These evidence corrections change no approved input
or proposed semantic identity.

The authenticated production search on 2026-10-28 still returned the baseline
`sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`
and no `t3dotgg/*` results. The canonical alias was observed at
`dpl_MGiFbFtwcibpc9wY7BiK7gXkH3zH`. No hosted mutation was performed.

Public readiness returned HTTP 200 with only `{"status":"ready"}`; anonymous
MCP returned HTTP 401. The legacy readiness response has no release identity
and is correctly rejected by the publisher. This is an additional production
blocker: a separately reviewed predecessor-verification/recovery migration
or separately authorized certified baseline-runtime migration is required.
No readiness, rollback or production-exclusivity certification is claimed.

The issue and isolated Hub intake records contained no exact nine-version
release-owner approval. The approval packet remains awaiting a genuine owner
decision including publisher identity. Contract or implementation approval must
not substitute for it.

`babysit-pr/scripts/pr-wait` remains unavailable through hosted executable
content delivery. Its original pinned bytes hash to
`90393f85b95b78bff1b039744bdfb09dc88ff2b430e1c3df687ee6f449c97214`.
Retrieve from the pinned upstream and verify separately only when the executing
host authorizes that operation; import does not install or execute the script.
