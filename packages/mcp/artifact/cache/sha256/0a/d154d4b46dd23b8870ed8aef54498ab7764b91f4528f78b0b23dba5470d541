# Stack integration protocol

Detailed procedure for `integrate-pr-stack`. The SKILL.md gives the workflow; this file gives the mechanics and the judgment rules.

## 1. Discover the stack

Query the hosting platform for open PRs. Build the graph from base and head branch names and SHAs.

```text
for each open PR:
    record number, base branch, head branch, base SHA, head SHA, draft, state
order PRs so that pr[i].base_branch == pr[i-1].head_branch
```

The bottom PR targets the default branch. The top PR is not used as a base by any other. A branch used as a base by two PRs means a fork in the stack; stop and clarify.

## 2. Verify ancestry

For every adjacent pair, prove that the lower PR's head is an ancestor of the upper PR's base.

```text
is_ancestor(pr[i].head_sha, pr[i+1].base_sha) must be true
```

Also confirm each base branch resolves to the expected head SHA. A branch name match is not proof; the SHA is.

If ancestry fails, the stack is not a stack. Report the break and reconcile before merging anything.

## 3. Detect drift

```text
base moved    the base branch tip advanced beyond the recorded base SHA
head moved    the head branch tip advanced beyond the reviewed head SHA
diff changed  the diff from base to head differs from the reviewed diff
```

Any drift invalidates prior evidence for that PR. Re-certify with `certify-pr-head` after the drift is resolved.

## 4. Restack a descendant

When an ancestor changes, every descendant must be restacked so its diff contains only its own change.

1. Record the descendant's current diff as the source of intent.
2. Move or rebase the descendant onto the ancestor's new head.
3. Resolve conflicts by intent, not by side.
4. Confirm the descendant's diff now equals its original intent applied on the new base.
5. Re-run the descendant's validation at the new head.

Do not squash a descendant's commits into an ancestor, and do not rebase an ancestor onto its descendant.

## 5. Conflict resolution

A conflict means two changes touched the same region. Before editing:

- Read both sides and state what each intended.
- If the intents are independent, keep both.
- If they overlap but are compatible, merge them into one coherent change.
- If they are mutually exclusive, stop. Report the two intents and ask which wins. This is `INVESTIGATE` or `AUTHORITY_REQUIRED`, not a guess.

Never:

- resolve by deleting one side to make the conflict vanish;
- use a blanket ours or theirs strategy;
- accept a resolution without re-validating the affected PR.

## 6. Merge one PR

Merge exactly one PR per cycle, bottom first.

1. Confirm the bottom PR is certified at its exact head.
2. Confirm its base is the current default branch tip.
3. Merge with the repository's configured strategy.
4. Refresh: fetch the new default branch, restack the remaining stack onto it.
5. Return to ancestry verification. The stack changed, so re-prove it.

Merging more than one PR before refreshing risks landing a descendant whose diff included an ancestor that merged differently.

## 7. Finding ownership

Given a review finding, locate the PR whose diff introduced the offending line.

```text
run a blame or diff across the stack from bottom to top
the first PR whose base-to-head diff contains the line owns it
```

Repair in the owning PR. Then restack every descendant. Never edit a descendant to compensate for an ancestor defect; that hides the defect and breaks the stack invariant.

## 8. Revalidation after every change

Every restack, conflict resolution, or repair is a code change. It requires:

- the PR's validation suite at the new head;
- `certify-pr-head` for the new head;
- a refreshed diff compared to the intended change.

A green rebase is not evidence. Only validation at the exact head is.

## 9. Stop conditions

```text
ancestry broken and intent unclear        -> INVESTIGATE
conflict is mutually exclusive            -> AUTHORITY_REQUIRED
merge not authorized                      -> AUTHORITY_REQUIRED
force-push needed on a shared branch      -> AUTHORITY_REQUIRED
validation fails at a restacked head      -> FIX_FORWARD in the owning PR
```

Report the stack state and the exact blocker. Do not merge through a failure.
