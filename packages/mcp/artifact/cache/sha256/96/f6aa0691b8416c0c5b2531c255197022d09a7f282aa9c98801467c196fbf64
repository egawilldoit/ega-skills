---
name: make-pr-easy-to-review
description: "Prepare a pull request for review by cleaning noisy history, improving its description, and adding reviewer guidance without changing code behavior. Use for 'make this easy to review', 'tidy this PR', 'clean up commits', or 'annotate the diff'. Resolve GitHub access from a native connector, MCP tool, or authenticated gh. Preserve tree identity: reviewability cleanup must not change behavior."
---

# Make PR easy to review

Prepare a pull request so a reviewer can quickly understand the intent, the important files, and the risk. The default goal is reviewability without behavior changes.

## GitHub capability resolution

Do not assume any single GitHub transport. Resolve capability in this order:

1. Prefer a native or connected GitHub capability when the runtime provides one: a GitHub connector, an MCP GitHub integration, or an equivalent structured GitHub tool.
2. Otherwise use the authenticated GitHub CLI (`gh`) when shell execution is available, `gh` is installed, and `gh` is authenticated.
3. Otherwise report that the GitHub capability is unavailable and stop before proposing metadata changes you cannot verify.

Local `git` handles the working tree. GitHub metadata (PR title, description, review notes) needs a GitHub capability.

## Resolve the base branch

Never hardcode `main`. Use the pull request's own base branch, or the remote default branch when no PR exists.

## Workflow

1. Resolve the target PR from the user-provided URL or the current branch.
2. Inspect commits, diff size, changed paths, generated files, the PR description, and the actual base branch.
3. Identify reviewability problems: noisy or mixed commits, a stale description, unrelated changes, mechanical changes tangled with logic changes, missing tests, or unclear reviewer entry points.
4. Propose a plan before any history rewrite or force push. History rewriting requires explicit authorization.
5. Apply safe improvements. Prefer PR description and review notes when behavior must stay untouched.
6. Verify tree identity: the reviewed tree must match the intended code. Report the before and after tree SHAs.

## History cleanup

Only rewrite history when the user asks for it or agrees to the plan. Capture the original tree before rewriting so you can prove content identity.

```bash
# with git
git fetch origin <headRefName> <baseRefName>
ORIGINAL_TREE=$(git rev-parse origin/<headRefName>^{tree})

# with the GitHub CLI fallback
gh pr view <PR> --json title,headRefName,baseRefName,state,commits
```

Good commit groupings usually follow dependency order:

1. Schema, storage, or generated API definitions.
2. Core logic.
3. Wiring and integration.
4. UI or surface behavior.
5. Tests.

After rewriting, prove content identity:

```bash
echo "Original tree: $ORIGINAL_TREE"
echo "Current tree:  $(git rev-parse HEAD^{tree})"
```

Do not push if the tree changed unintentionally.

## Reviewer guidance

When code behavior should stay untouched, improve the review surface instead:

- Add a TL;DR that matches the actual diff.
- Separate core files from generated or mechanical files.
- Call out risky behavior changes, migration order, rollout plan, and test coverage.
- Link issue trackers, dashboards, or design docs when they explain intent.

## Guardrails

- Never hide a meaningful behavior change inside "cleanup".
- Do not bypass hooks unless the user explicitly asks.
- Do not rewrite history or force push without explicit authorization.
- If the PR is too large to make reviewable with notes, recommend splitting rather than polishing around the problem.

## Output

- Reviewability problems found.
- Changes applied, with the tree-identity proof when history was rewritten.
- Final PR metadata and the exact next action.
