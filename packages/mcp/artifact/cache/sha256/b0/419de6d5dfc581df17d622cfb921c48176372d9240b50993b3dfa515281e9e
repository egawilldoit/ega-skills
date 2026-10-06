---
name: preflight-repository
description: "Establish the exact current reality of a repository before substantial work: identity, root, default and current branch, HEAD SHA, merge base, dirty state, ahead/behind, worktree, remote parity, associated PR, PR base/head, and CI or deployment identity when relevant. Use at the start of serious repo work, when resuming on an unfamiliar checkout, or before branching, pushing, or merging. Returns READY, READY_WITH_NOTES, BLOCKED, WRONG_REPOSITORY, or INSUFFICIENT_EVIDENCE. For freshness of PR evidence against an exact head use certify-pr-head; for stacked PRs use integrate-pr-stack."
---

# Preflight repository

Before substantial repository work, replace assumptions with proven facts. A wrong repository, a stale base, or an uncommitted file turns correct work into damage.

This skill collects the facts, computes `desired state - proven existing state = required delta`, and returns one verdict. It reads only. It never mutates.

Vocabulary comes from `references/operating-contract.md`. This skill runs at `L0 READ` and reports at the evidence level actually reached.

## When to use

- Starting a task in a checkout you did not create.
- Resuming work after time away, or after another agent or human touched the repo.
- Before creating a branch, committing, pushing, opening a PR, or merging.
- When the working directory may be a worktree, a submodule, or nested inside another repository.
- When two sources disagree about the branch, SHA, or PR state.

Do not use it for a single read-only file inspection. Do not use it to certify PR head evidence (`certify-pr-head`) or artifact lineage (`trace-artifact-provenance`).

## Facts to collect

Collect only what the task needs, but never skip repository identity or HEAD.

```text
repository identity      host, owner, name, from the resolved remote URL
root path                worktree top level, and git dir
default branch           from the remote (ls-remote symref) when reachable; the source is recorded
current branch           or detached HEAD
HEAD SHA                 full commit id
merge base               HEAD against the default branch and against the PR base
dirty state              clean, dirty, or unknown/error; when git status fails, clean is null and the verdict is INSUFFICIENT_EVIDENCE
tracking parity          HEAD versus the local @{upstream} tracking ref
remote parity            HEAD versus the live remote branch SHA (read-only ls-remote)
worktree                 is THIS checkout the main worktree, a linked worktree, or a submodule
remote                   fetch and push URLs, and whether they match
associated PR            open PR whose head is this branch, if any
PR base/head             the PR's base branch and head SHA
CI state                 checks for the exact head SHA, when relevant
deployment identity      environment, project, and version, when relevant
```

Worktree facts are classified from git's own paths (`--git-dir` versus `--git-common-dir`, and the superproject working tree), not from worktree counts and not from `.git`-file sniffing: having another worktree in the repository does not make this checkout linked, and both linked worktrees and submodules may use gitfiles. Tracking parity and remote parity are separate facts: the tracking ref is only the last fetched value, and it is never substituted for live remote truth. A local `main` or `master` branch existing is not proof that it is the remote default branch.

Mark each fact `PROVEN`, `SUPPORTED`, `ASSUMED`, or `UNRESOLVED`. `INSUFFICIENT_EVIDENCE` is the verdict when identity, root, or HEAD cannot be proven.

## Workflow

1. Resolve the root and identity first. Refuse to proceed on identity you cannot prove.
2. Run `scripts/preflight.py` to gather deterministic facts as JSON. It shells out to git and uses `gh` only when present.
3. Fill gaps the script marks unknown by reading the repo and the hosting UI.
4. Compute the required delta from the stated desired state and the proven existing state.
5. Return exactly one verdict with the delta and the next action.

## Verdicts

```text
READY               identity proven, tree clean, base known, no blocking drift
READY_WITH_NOTES    work can proceed; named notes affect hygiene, not correctness
BLOCKED             a precondition is false: dirty tree, diverged base, failed checks
WRONG_REPOSITORY    identity or root does not match the intended target
INSUFFICIENT_EVIDENCE  a required fact could not be proven, including repository tree state when git status fails
```

`WRONG_REPOSITORY` and `BLOCKED` are hard stops for mutation. Report them instead of acting. `READY_WITH_NOTES` lists each note and its impact.

## Required delta

State it as a subtraction, not a plan:

```text
desired state            <what the task needs to be true>
- proven existing state  <what the facts show>
= required delta         <the exact steps to close the gap>
```

Example: desired is "branch off current main with a clean tree"; proven is "on a feature branch, two unstaged files, base 30 commits behind"; delta is "stash or commit the two files, fetch, rebase onto main".

## Hard rules

- Never report a fact as `PROVEN` unless a command or file shows it.
- Never run a mutating git command during preflight. Read only.
- Never assume the current directory is the repository root. Prove it.
- Never treat a remote tracking SHA as the remote's current truth. It is only the last fetched value. Compare live remote parity with a read-only `git ls-remote origin refs/heads/<branch>`.
- When live remote truth cannot be resolved (remote unreachable, detached HEAD), report remote parity `unknown` or `not_applicable`; never substitute tracking parity.
- Do not classify the worktree from `.git` being a file: linked worktrees and submodules both use gitfiles.
- A local `main`/`master` branch is not proof of the remote default branch. Use `git ls-remote --symref origin HEAD` and record the evidence source.
- When a fact is required and unknown, return `INSUFFICIENT_EVIDENCE`, not a guess.

## Output contract

```text
VERDICT: READY | READY_WITH_NOTES | BLOCKED | WRONG_REPOSITORY | INSUFFICIENT_EVIDENCE
EVIDENCE: E0..E6
REPOSITORY: <host/owner/name>
ROOT: <path>
BRANCH: <current> -> HEAD <sha>
BASE: <default branch> merge-base <sha>
TREE: clean | dirty(<n>) | unknown/error
SYNC: ahead <n>, behind <n>, tracking parity <yes|no|unknown>, remote parity <yes|no|unknown|not_applicable>
PR: <number or none>, base <branch>, head <sha>
CI: <state or not relevant>
DEPLOY: <identity or not relevant>
DELTA:
  - <step>
NOTES:
  - <note or none>
NEXT: <the single next action, or AUTHORITY_REQUIRED>
```

Machine-readable output from `scripts/preflight.py` is the input to this verdict, not a substitute for it. The model interprets ambiguity; the script establishes facts.
