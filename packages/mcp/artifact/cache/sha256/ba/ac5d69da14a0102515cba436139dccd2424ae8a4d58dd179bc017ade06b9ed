---
name: ship-one-outcome
description: "Coordinate one bounded software delivery from an authorized outcome to its stated finish boundary: recovery, thin-path proof, integration, verification, and authorized merge, deployment, or acceptance. Use when a mission spans implementation through delivery evidence, or when a worker's completion claim must be proven integrated. Not for a single small edit, standalone PR review, CI repair, or investigation; use the narrower specialist skill."
---

# Ship One Outcome

Own one bounded outcome through its authorized finish boundary. Perform the
authorized work; return a plan only when planning is the request. A completion
message is a claim to verify, not evidence.

## Start at the first unmet checkpoint

Read the current issue, repository instructions, and existing task record.
Establish:

- the observable result, acceptance criteria, and exclusions;
- repository, intended integration branch, and target environment;
- finish boundary: reviewable PR, merged, deployed/verified, or owner-accepted;
- actions already authorized in this task/session and actions still reserved;
- for an explicitly authorized finite program, the eligible outcomes and the
  program boundary.

One outcome is one observable result with its own evidence and stopping
boundary. A finite program is a sequence of such outcomes, not permission to
absorb unrelated backlog. Complete eligible outcomes sequentially, or in
authorized parallel execution, and keep a separate receipt for each. Stop after
the first outcome only when it blocks the next one or the program boundary is
reached.

Reuse an adequate brief and valid evidence. Recheck changeable remote facts,
then enter the first unfinished checkpoint. Existing implementation does not
need another implementation pass. Ask only when a missing decision changes the
next action; prepare independent authorized work while waiting.

Keep one primary outcome and at most one fallback during an external block.
Give shared migrations, auth, contracts, and app composition one integration
owner. Parallel work needs authorization, disjoint ownership, and integration
capacity; dependent workers start from a committed base.

## 1. Prove deliverability

Recover prior work before mutating anything. Inspect uncommitted changes,
stashes, branches, worktrees, abandoned or cancelled worker output, and prior
artifacts. Preserve unfamiliar work; never reset, clean, or overwrite it to
simplify the checkout.

Verify repository/base/head, worktree ownership, startup/build/test commands,
environment identity, relevant account/access, and CI/deployment visibility.
Check push/merge publication and deployment effects before those actions;
authority must cover their consequences.

Classify each dependency by the stage it blocks: local implementation,
integration/review, hosted deployment, or owner acceptance. A hosted provider
or authentication blocker blocks only that stage; continue an independently
valid, authorized local deliverable. Record each dependency as operation,
target, evidence, owner, and dependent stage.

**Ready:** a known baseline, a runnable verification path, preserved prior work,
and dependencies scoped to the stage they actually block.

## 2. Prove the thin journey

Build the smallest complete path before expanding states or styling.
Reproduce defects through their real entrypoint; prove an important regression
detects unfixed behavior when practical. Exercise real app composition, using
controlled dependencies where appropriate and disclosing what they cannot
establish. For a non-product change, use its actual artifact or consumer
contract rather than inventing a hosted journey.

Exercise the smallest actual authenticated/provider path early, in the required
target environment. If access is missing, name the exact provisioning step and
owner while the slice is still small. Never substitute interactive or shared
credentials, reveal secret values, or claim hosted acceptance from local
evidence. Keep local and hosted observations distinct.

Reuse existing harnesses. Run focused checks while editing, repository-required
final checks on the candidate, and the intended build path for affected
runtime/UI behavior. Serialize heavy suites on constrained machines. Diagnose
actual requests, logs, and persisted outcomes; keep repairs in scope and put
optional ideas in follow-ups.

**Ready:** the acceptance-relevant journey and a meaningful failure/permission
case work through the required path, with identifiable inputs and limitations.
Local-only evidence is labeled local.

## 3. Prepare, integrate, and review the candidate

Read [delivery-gates.md](references/delivery-gates.md) when preparing a PR/MR,
merging/deploying, recovering an interrupted mutation, or reconciling worker
output. It defines the evidence and authority needed at each boundary.

A worker's completion message does not prove its work was integrated. Identify
the actual commit or artifact, preserve dirty and cancelled worktrees, and
confirm the intended changes exist in the integration revision. An empty merge,
an isolated green test, or a worker summary is not delivery proof. Do not
manufacture a new commit when the expected change is already correctly present.

Changing to solo implementation does not waive independent review,
repository-required CI, security verification, tenant/RLS checks, real
PostgreSQL or applicable migration tests, or approvals. A failed, cancelled,
or skipped review is not a successful review; self-review is not independent
review. Block only the action that needs the missing gate, and continue
unrelated authorized work.

Verify the actual diff/artifact, PR/MR, intended base/head, required
template/citations, and attached check results. Cite applicable rules only. For
a reviewable-PR task, hand over ready for review with review accurately pending.
For a merge task, obtain independent review against requirements and repository
standards, plus required platform approvals. One reviewer may cover both axes
unless policy calls for more.

Fix blocking findings and refresh evidence affected by changes. Retain valid
passing evidence; repeated full audits and duplicate suites are not progress.

**Ready:** the requested handoff is verifiable, or one specific required gate
remains. Add no prerequisite beyond the brief, repository rules, and necessary
authorization.

## 4. Deliver and read back

Execute the already-authorized next action on the named target when its gates
pass. A remote default branch is not a substitute integration target. Read back
the result; before retrying an unknown side effect, reconcile whether it already
happened.

Keep implementation, integration, merge, deployment, and owner acceptance as
distinct states. Do not promote one to the next without its own evidence. For
deployed acceptance, identify the actual deployed revision and relevant
configuration/schema state, then drive the real user journey and refusal/failure
case. Health alone does not prove usability. If owner acceptance is reserved,
report deployed and verified with acceptance pending until that owner accepts.

For an authorized finite program, continue to the next eligible outcome only
after the current outcome has a receipt. Stop at the program boundary; do not
pick up unrelated backlog.

**Ready:** authoritative remote state and observations establish the requested
boundary, or one exact external action/owner blocks it. Access denied means
access is blocked; it does not cancel authorization already granted.

## 5. Record and close

Update the existing task record when tracker writes are authorized. Use
[records.md](references/records.md) for the compact record and per-outcome
receipt. Correct stale statuses and earlier overclaims from source evidence.
Mark Done only for the agreed boundary and its acceptance; a bounded
reviewable-PR issue can be Done while its PR still awaits review.

Keep a release blocker, a defect in the delivered slice, and an unrelated
improvement distinct. Fix blockers required for the journey; give unrelated
improvements their own issue. Freeze optional scope once acceptance passes.
Continue authorized steps without repeated confirmation until the boundary or a
named blocker.

Use narrow existing implementation, debugging, verification, CI, and review
skills as needed. This skill grants no service access, merge authority,
production permission, or exception to repository protections.
