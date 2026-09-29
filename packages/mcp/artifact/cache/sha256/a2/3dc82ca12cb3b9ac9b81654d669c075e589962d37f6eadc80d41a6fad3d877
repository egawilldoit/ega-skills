---
name: integrate-pr-stack
description: "Safely land stacked pull requests one at a time. Use for a stack or chain of dependent PRs, when a finding must be fixed in the PR that introduced it, or when descendants need restacking after a base branch changes. Discovers the stack, verifies ancestry, maps each PR base and head, detects drift, repairs findings in the owning PR, restacks descendants by semantic intent rather than ours or theirs, recalculates diffs, revalidates, merges exactly one PR, then refreshes the remainder against the updated base branch. Parallel preparation is allowed; parallel integration is not. For a single ordinary PR use review-and-ship."
---

# Integrate PR stack

A stack is a chain of PRs where each base is the previous PR's head. Merging them all at once, or resolving conflicts by picking a side, corrupts history and loses intent. This skill lands one PR at a time and keeps the rest valid.

The core invariant is the whole point:

```text
parallel preparation is allowed
parallel integration is not
```

Vocabulary comes from `references/operating-contract.md`. Integration is `L3 REMOTE / PR` by default. Merge and production authority are separate and must be granted.

## When to use

- A set of PRs forms a dependency chain.
- A review finding belongs to an earlier PR, not the top of the stack.
- A base branch changed and descendants must be restacked.
- You need to merge one PR and keep the remaining stack buildable.

Do not use it for a single independent PR (`review-and-ship`). Do not use it to review code quality (`adversarial-review`).

## Stack model

```text
<base branch>
  ^ base of PR 1
PR 1 head  <- base of PR 2
PR 2 head  <- base of PR 3
PR 3 head
```

Each PR's base is the previous PR's head. Ancestry must hold: the base SHA is an ancestor of the head SHA for every PR, and each PR's head descends from the one below it.

## Workflow

1. Discover the stack. Find the open PRs whose bases chain to one another. Run `scripts/discover_stack.py`. The default branch is resolved from the repository's actual default (GitHub or the remote HEAD symref), not assumed to be `main`; pass `--default-branch` only as an explicit override, and expect a clear error if it cannot be resolved.
2. Verify ancestry for every link. If ancestry fails, stop and reconcile before any merge.
3. Map each PR's base and head, the SHA each check ran on, and the current diff.
4. Detect drift: a base moved, a head moved, or a diff changed since review.
5. For a finding, identify the owning PR, the one whose diff introduced it, and repair there. Never patch a descendant to mask an ancestor defect.
6. Restack descendants after an ancestor changes. Rebase or re-target them so their diffs contain only their own change. Preserve semantic intent; do not resolve conflicts with a blanket ours or theirs.
7. Recalculate diffs and revalidate each affected PR at its new head. Re-run `certify-pr-head` per PR.
8. Merge exactly one PR. Never merge two at once.
9. Refresh the remaining stack against the updated base branch and repeat from step 2.

## Conflict policy

When a restack conflicts:

- Understand what each side changed and why before touching the file.
- Preserve both intents where they are independent. A conflict is often two real changes in the same region.
- If the intents genuinely conflict, stop and report. Do not pick a side to make the conflict disappear.
- Never use a blanket `ours` or `theirs` resolution. It silently drops one side's change.
- After resolving, re-run the owning PR's validation. A clean rebase is not proof of correctness.

## Drift and findings

```text
base moved          the PR's base branch advanced; restack the PR
head moved          a commit was added after review; re-certify
diff changed        the effective change differs from what was reviewed; re-review
finding in ancestor repair in the owning PR, then restack descendants
```

## Hard rules

- Merge one PR per cycle. Re-verify the stack after each merge.
- Repair findings in the PR that owns them. Do not forward-fix a descendant to hide an ancestor defect.
- Verify ancestry with real SHAs. Never assume a base branch equals the previous head because it is named similarly.
- Do not force-push a shared branch without explicit authorization.
- Do not merge without explicit merge authority. Merging is `AUTHORITY_REQUIRED` by default.
- Revalidate after every restack. A conflict resolution is a code change and needs evidence.

## Output contract

```text
STACK: <ordered list of PR numbers, bottom to top>
ANCESTRY: <verified | broken at PR n>
DRIFT: <per PR: base moved, head moved, diff changed, none>
OWNING PR FOR FINDING: <pr or n/a>
RESTACKED: <list>
MERGED: <exactly one PR, or none>
REMAINING STACK: <state after merge>
EVIDENCE: E0..E6 per claim
BLOCKERS: <type and detail, or none>
NEXT: <the single next action, or AUTHORITY_REQUIRED>
```

Detailed restack and conflict procedures live in `references/stack-protocol.md`.
