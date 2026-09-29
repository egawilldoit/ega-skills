---
name: review-and-ship
description: "Review the current branch or pull request for bugs, regressions, security, and intent fit, run or add focused tests, commit selected files, and open or update the PR. Use to finish one ordinary independent PR. Resolve GitHub capability from a native connector, MCP tool, or authenticated gh, and resolve the actual base branch rather than assuming main. For stacked PRs use integrate-pr-stack; for independent challenge use adversarial-review."
---

# Review and ship

## Trigger

Reviewing changes before shipping. Close key issues, verify behavior, and open or update a pull request.

This skill owns one ordinary, independent PR. For a chain of dependent PRs use `integrate-pr-stack`. For an independent correctness challenge use `adversarial-review`.

## GitHub capability resolution

Do not assume any single GitHub transport. Resolve capability in this order:

1. Prefer a native or connected GitHub capability when the current runtime provides one: a GitHub connector, an MCP GitHub integration, or an equivalent structured GitHub tool.
2. Otherwise use the authenticated GitHub CLI (`gh`) when shell execution is available, `gh` is installed, and `gh` is authenticated.
3. Otherwise report that the GitHub capability is unavailable. Do not claim a push, PR, or check result that was not actually produced.

Local `git` is used whenever the working tree is available. It is not a substitute for GitHub capability when the task needs remote state.

## Resolve the base branch

Never hardcode `main`. Resolve the base in order:

1. If the branch already has a pull request, use that PR's base branch.
2. Otherwise use the remote default branch.
3. If neither can be resolved, ask or report `INSUFFICIENT_EVIDENCE`.

## Workflow

1. Resolve context: repository, current branch, associated PR, the actual base branch, the base SHA, and the current head SHA.
2. Obtain the real diff of the head against the base. With git, `git diff <base>...HEAD` after fetching the base. With a GitHub capability, read the PR's changed files.
3. Review for correctness, regressions, security, and intent fit. For a large diff, split the review across parallel subagents by area, then merge their findings.
4. Run focused validation for the changed behavior, using whatever execution capability is available. If no focused test exists, add one or record the gap.
5. Fix critical issues, then re-run the affected validation.
6. Mutate only if authorized and available: commit selected files with a concise message, push the branch, and open or update the PR. Push and PR creation require authority for this task.
7. Verify the final PR head matches the SHA you reviewed, then report exact evidence.

## Command examples

These are fallback examples, not the definition of the workflow. Prefer a native GitHub capability when one exists.

```bash
# git-only context
git fetch origin <base>
git diff origin/<base>...HEAD
git status

# GitHub CLI fallback
gh pr view --json number,url,baseRefName,headRefName,headRefOid
gh pr checks --json name,bucket,state,workflow,link
```

## Guardrails

- Prioritize correctness, security, and regressions over style-only comments.
- Keep commits focused and avoid unrelated file changes.
- If pre-commit checks fail, fix the issues rather than bypassing hooks.
- Judge PR readiness from the complete PR-attached check set, not from one CI provider's runs.
- Do not report a check, push, or PR as done unless the capability actually performed it.

## Output

- Findings summary: critical, warning, note.
- Validation run and outcomes, with the evidence level reached.
- Final PR head SHA and URL, or the blocker and the exact next action.
