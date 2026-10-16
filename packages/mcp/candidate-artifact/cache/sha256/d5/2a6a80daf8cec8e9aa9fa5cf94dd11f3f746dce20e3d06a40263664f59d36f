---
name: new-branch-and-pr
description: "Create a focused branch from the repository's actual default branch, complete the work, commit, push, and open a concise pull request with summary and test notes. Use when starting work that should ship through a clean branch and PR. Resolve the base branch and the GitHub capability from the environment instead of assuming main or a local gh. For an existing branch use review-and-ship; for a chain of dependent PRs use integrate-pr-stack."
---

# New branch and PR

## Trigger

Starting work that should ship through a clean branch and pull request. This skill owns the first PR for a new change. For an existing branch or PR use `review-and-ship`. For a chain of dependent PRs use `integrate-pr-stack`.

## Resolve the base branch

Never hardcode `main`. Resolve the base in order:

1. If the current branch already has a pull request, use that PR's base branch.
2. Otherwise use the remote default branch.
3. If neither can be resolved, ask or report `INSUFFICIENT_EVIDENCE`.

## GitHub capability resolution

Do not assume any single GitHub transport. Resolve capability in this order:

1. Prefer a native or connected GitHub capability when the runtime provides one: a GitHub connector, an MCP GitHub integration, or an equivalent structured GitHub tool.
2. Otherwise use the authenticated GitHub CLI (`gh`) when shell execution is available, `gh` is installed, and `gh` is authenticated.
3. Otherwise report that the GitHub capability is unavailable. Local commits and a local branch are still possible; pushing and opening a PR are not. Do not claim a push or PR that was not actually produced.

## Workflow

1. Resolve the base branch, the current head, and the working-tree state. Ensure the tree is clean or the uncommitted changes are explicitly handled.
2. Create a descriptive branch from the up-to-date base.
3. Complete the implementation and focused tests.
4. Commit focused changes with a concise message.
5. Push the branch and open a concise PR with a summary and test notes, if pushing is authorized and available.
6. Verify the PR head SHA matches the branch you pushed, then report the PR URL.

## Command examples

Fallback examples only. Prefer a native GitHub capability when one exists.

```bash
git fetch origin
git switch -c <branch> origin/<base>
# GitHub CLI fallback
gh pr create --base <base> --head <branch> --title "..." --body "..."
```

## Guardrails

- Keep the branch scope focused on one change set.
- Include verification notes before requesting review.
- Push and PR creation require authority for the current task.

## Output

- Base branch and new branch name.
- PR summary and test notes.
- PR URL and head SHA, or the blocker and the exact next action.
