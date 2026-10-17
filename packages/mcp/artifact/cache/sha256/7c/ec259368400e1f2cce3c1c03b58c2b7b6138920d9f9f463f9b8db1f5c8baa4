# Evidence mapping for PR head certification

For each acceptance source, capture the SHA it actually covers. The source of the SHA matters: a check attached to a merge commit or a synthetic ref is not the same as a check attached to the head.

## Sources and where the SHA comes from

```text
current PR head
  hosting platform PR object, head commit field

reviewed SHA
  the commit the approving review was submitted against; many platforms
  record this per review, not per PR

tested SHA
  the commit the test run checked out; CI logs or the workflow run's head SHA

CI associated head SHA
  the head/check-suite SHA the platform associates the check with

CI executed SHA
  the exact commit checked out and executed inside the validation job,
  from the job's checkout step or a proven executed-SHA assertion

branch tip
  local branch HEAD and its remote tracking ref, compared for equality
```

`associated_head_sha` and `executed_sha` are two separate facts and can differ:

```text
associated_head_sha = PR HEAD, executed_sha = synthetic PR merge SHA
  -> merge-result validation only; never exact-head certification

associated_head_sha == executed_sha == current head, conclusion success
  -> exact-head certification possible
```

A check attached to the head but executing a synthetic merge commit is reported as MERGE_RESULT evidence; it can never satisfy EXACT_HEAD_CERTIFIED.

## Common traps

- The platform runs checks against a synthetic merge ref. The check is green for the merge result, not for the head alone. Record both and report the distinction.
- An approval is often carried forward after a new commit. The platform may still show "approved" while the review SHA is an ancestor. That is `STALE_EVIDENCE`.
- A force-push rewrites history. An old SHA may no longer be an ancestor of the head. It is still `STALE_EVIDENCE` or `HEAD_MOVED`, never a pass.
- Abbreviated SHAs in chat or logs are ambiguous. Expand before comparing. If a SHA cannot be expanded, treat it as missing.
- A check that is still running has no verdict yet. That is `INCOMPLETE`, not a pass.

## Distinguishing stale from moved

```text
evidence SHA is an ancestor of current head, head unchanged since evidence
  -> STALE_EVIDENCE

head SHA at evidence time differs from current head, evidence matched old head
  -> HEAD_MOVED
```

Both block merge. `HEAD_MOVED` means the evidence was valid once and was invalidated by a new commit, rebase, or restack. `STALE_EVIDENCE` means the evidence never covered the current head.

## Clearing a failure

- `HEAD_MOVED`: re-run the required checks and review on the new head, then re-certify. Do not reuse old results.
- `STALE_EVIDENCE`: obtain evidence on the current head. Re-running CI on the head and re-approving at the head both clear it.
- `INCOMPLETE`: resolve the missing SHA from the platform. Do not certify on partial evidence.

## What to record

For every certification, record: the reference head, each evidence SHA and its source, whether the head moved after evidence, the verdict, and the evidence level reached. Store this alongside the PR so a reviewer can re-run the check.
