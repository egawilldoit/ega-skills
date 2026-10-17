---
name: certify-pr-head
description: "Verify that acceptance evidence belongs to the exact current head of a pull request. Use before declaring a PR merge-ready, after pushing fixes to a reviewed PR, after a rebase or restack, or whenever review, test, or CI evidence may refer to an older commit. Checks the current PR head SHA against the reviewed, tested, and CI SHAs, distinguishing the CI-associated head SHA from the SHA the CI job actually executed, and confirms the branch has not moved afterward. Returns EXACT_HEAD_CERTIFIED, STALE_EVIDENCE, HEAD_MOVED, or INCOMPLETE. For source-to-artifact lineage use trace-artifact-provenance; for a full release gate use certify-release."
---

# Certify PR head

Successful evidence is worthless if it belongs to an older commit. This skill proves that review, test, and CI evidence all attach to the exact current head of a pull request, and that the head has not moved since.

The rule is absolute: a green check on SHA `A` says nothing about SHA `B`. Never accept evidence pinned to an ancestor.

Vocabulary comes from `references/operating-contract.md`. This skill runs at `L0 READ` and reports at the evidence level actually reached.

## When to use

- Before declaring a PR merge-ready.
- After pushing fixes to a PR that was already reviewed or tested.
- After a rebase, force-push, or restack.
- When a check passed earlier and you are unsure whether the head changed.
- When several evidence sources disagree about which commit they cover.

Do not use it to decide whether the code is good (`adversarial-review`) or to prove an artifact came from a commit (`trace-artifact-provenance`).

## Evidence sources to reconcile

For each source, capture the SHA it actually covers, not the SHA you hope it covers.

```text
current PR head      the head SHA the hosting platform reports right now
reviewed SHA         the commit the approving review was submitted against
tested SHA           the commit the test run executed
CI associated SHA    the head/check-suite SHA the platform associates the check with
CI executed SHA      the exact commit checked out and executed inside the CI job
branch tip           the local and remote branch tip SHA
```

The CI associated SHA and the CI executed SHA are different facts and can differ. A check attached to the head that executed a synthetic merge commit is merge-result evidence: it proves the proposed head validates when merged with the current base, not that the head itself was validated. Exact-head certification requires associated SHA == executed SHA == current head with a successful conclusion.

Then confirm the head has not moved after the evidence was produced: compare the current head to each evidence SHA and check the timestamps of evidence against the head commit time.

## Workflow

1. Resolve the current PR head SHA from the hosting platform. This is the reference SHA.
2. For each evidence source, record the SHA it covers and where that SHA came from.
3. Compare every evidence SHA to the reference SHA with an exact string match. Abbreviated SHAs must be expanded before comparison.
4. Confirm the branch tip and the PR head agree, and that neither moved after the evidence was produced.
5. Run `scripts/certify_pr_head.py` to do the SHA comparison deterministically.
6. Return exactly one verdict.

## Verdicts

```text
EXACT_HEAD_CERTIFIED   every required evidence source matches the current head, CI executed on that exact head successfully, and the head did not move
STALE_EVIDENCE         one or more evidence sources cover an older commit while the head is unchanged
HEAD_MOVED             the head changed after evidence was produced, so the evidence is invalidated
INCOMPLETE             a required SHA or evidence source is missing, unresolved, or only proves a merge result
```

Rules:

- `STALE_EVIDENCE` and `HEAD_MOVED` both block merge. They differ in cause: stale evidence means the evidence was never for this head; head moved means it was, then the head changed.
- Never downgrade `HEAD_MOVED` to a pass because the diff is small.
- Abbreviated SHAs are not acceptable evidence unless expanded and matched exactly.
- CI evidence alone is not enough: the check must have executed the exact head (associated == executed == head, conclusion success). Merge-result CI is reported separately and never substitutes for exact-head execution.
- A re-run of CI on the current head can clear stale evidence. Re-certify after it completes.

## Distinguishing the two failures

```text
head unchanged, evidence SHA is an ancestor of head   -> STALE_EVIDENCE
head changed after evidence completed                 -> HEAD_MOVED
```

If both are true, report `HEAD_MOVED` as the primary cause and list the stale sources.

## Hard rules

- Compare full SHAs. Never compare short prefixes.
- The reference SHA is the platform's current PR head, not a local branch you assume is pushed.
- Do not treat a passing check with no resolvable SHA as certified.
- Do not accept "the diff did not change" as a substitute for a SHA match.
- Read only. Do not push, rebase, or re-run CI as part of certification unless separately authorized.

## Output contract

```text
VERDICT: EXACT_HEAD_CERTIFIED | STALE_EVIDENCE | HEAD_MOVED | INCOMPLETE
EVIDENCE: E0..E6
PR: <number>
REFERENCE HEAD: <full sha>
REVIEWED: <full sha or unknown> -> <match|stale|missing>
TESTED: <full sha or unknown> -> <match|stale|missing>
CI ASSOCIATED HEAD: <full sha or unknown> -> <match|stale|missing>
CI EXECUTED SHA: <full sha or unknown> -> <match|stale|missing>
CI EXECUTION MODE: HEAD | MERGE_RESULT | UNKNOWN
CI CONCLUSION: <success|failure|unknown>
BRANCH MOVED AFTER EVIDENCE: <yes|no|unknown>
BLOCKING SOURCES: <list, or none>
NEXT: <the single next action, or AUTHORITY_REQUIRED>
```

The deterministic script output feeds this verdict. It does not replace the judgment about which sources are required for the task.
