# Delivery gates

Read this when preparing a PR/MR, taking a delivery action, recovering an
interrupted mutation, or reconciling worker output.

## Choose the finish gate

| Boundary | Evidence required | Accurate handoff |
| --- | --- | --- |
| Reviewable PR | Focused artifact, real PR/MR, stated acceptance evidence, required handoff checks | Ready for review; independent review may be pending unless explicitly required before handoff. No invented hosted prerequisite. |
| Merged | Reviewed candidate, required CI and independent review, protections/approvals satisfied, authorized target and effects, merge result and target ref read back | Merged into the actual named branch; no deployment implied. |
| Deployed and verified | Authorized deployment, identified target/revision/configuration, actual acceptance journey and relevant failure/refusal | Deployed and verified; identify any remaining owner acceptance. |
| Owner-accepted | Deployment/verification evidence plus acceptance by the reserved owner | Accepted; record who accepted and when. |

An issue can finish at an earlier gate than the product. Upstream metadata
merge, downstream adoption, release, and hosted routing are distinct events.
Preserve that distinction in the tracker.

## Check freshness and meaning

- Verify real artifacts and source state, not worker claims. Zero new commits is
  not itself failure if the requested change already exists; prove it at the
  authoritative revision.
- Record local versus CI results and the source head, base, and executed
  revision. A repository-approved merge-result pipeline is valid evidence for
  its inputs; a generic source-head preference does not justify rerunning it.
- Read conclusions and descriptions. Pending, failure, skipped, canceled, and
  review-skipped differ; a success wrapper does not turn skipped work into
  executed review/build evidence.
- New source, base, configuration, schema, or dependencies can invalidate the
  evidence they affect. Refresh that evidence before relying on it.
- Independent review identifies reviewer, examined revision, findings, and
  disposition. Agent review does not impersonate a required human approval or
  bypass branch protections.

## Worker handoff and integration

A completed worker message proves only that the worker stopped. It is not
evidence that a commit exists, that the commit is on the integration branch, or
that review and CI saw it.

Before cleaning or reusing a worker's checkout:

1. Inspect the worktree list, branch, status, and uncommitted diff. Treat
   uncommitted and unfamiliar files as work to preserve, not clutter.
2. If a cancelled or abandoned worker left a dirty tree, preserve it first. Put
   the changes on a named branch, export a patch, or commit them on the worker's
   branch without rewriting history or touching unrelated paths.
3. Identify the exact commit or artifact the worker claims to have produced.
   If there is no commit, the claimed work may exist only in the dirty tree.
4. Prove integration at the integration revision, using content evidence rather
   than a command's exit status:
   - the commit is an ancestor of the integration head;
   - or the same paths and hunks are present after a squash/rebase;
   - or the built artifact contains the expected change.
5. Inspect the actual integration candidate, not the worker's isolated branch.

An empty merge, a green test on the worker's branch, or a summary sentence is
not integration proof. If the change is absent, integrate it deliberately and
rerun the checks affected by the integration. If the change is already present
and correct, do not create a replacement commit.

## Solo execution and review gates

Solo implementation changes who does the work, not which gates apply.

- Required independent review remains required. Self-review is not independent
  review.
- Repository-required CI runs on the exact candidate. A skipped, cancelled,
  failed, or review-skipped result is not a passing result.
- Security checks, tenant/RLS checks, real database and migration tests,
  approvals, and branch protections still apply when the change touches them.
- A missing reviewer blocks the action that requires review, not every action.
  Continue unrelated authorized work, finish the candidate, and name the exact
  reviewer/approval needed.
- Never record approval on a reviewer's behalf, and never convert an unavailable
  gate into a waiver.

## Scope blockers by stage

| Stage | What it proves | What a blocker there does not block |
| --- | --- | --- |
| Local implementation | Code, artifact, or local contract works | A separately authorized hosted deployment task |
| Integration and review | Candidate is present, reviewed, and green as a whole | Local work that does not depend on the unmerged candidate |
| Hosted deployment | Authorized target received the identified revision | A valid local deliverable or a reviewable PR |
| Owner acceptance | The reserved owner accepted the deployed result | Preparation of the evidence the owner will inspect |

A hosted authentication or provider blocker must not erase a valid local
deliverable. Do not claim hosted acceptance from local test evidence. Preserve
credential isolation: use only authorized credentials, never reveal values, and
never substitute an interactive login or shared secret to force a hosted check.

## Execute once, verify the effect

Recheck head/base and bind a merge to the reviewed head where supported. Keep
the specified target branch; understand automatic production/release effects
before acting. Follow repository protections without changing them to make
delivery pass.

After an API timeout or interrupted run, read the PR/deployment/target ref or
operation record before retrying. If the action succeeded, verify its result and
continue; do not perform it twice.

For missing reserved authority, prepare the candidate and evidence before
naming the precise owner action. For 403/access failure, record operation,
account/team/project identity, response, dependent stage, and the access owner.
Try a supported authorized fallback when available; preserve the target and
credentials. Continue independent work instead of expanding the active queue.

## Finite authorized programs

A finite program is an explicit list of eligible outcomes, not a general license
to continue shipping.

- Give every outcome its own receipt: artifact, checks, review, runtime, and
  acceptance at the boundary actually reached.
- Complete outcomes in the authorized order, or in the authorized parallel
  grouping, without dropping one silently.
- Do not start an outcome outside the program because adjacent work is visible.
- Do not continue past an outcome whose next step needs a missing approval,
  credential, or owner decision; finish what is independent and name the
  dependency.
- A program does not merge, deploy, or publish beyond the authority granted for
  each outcome.
