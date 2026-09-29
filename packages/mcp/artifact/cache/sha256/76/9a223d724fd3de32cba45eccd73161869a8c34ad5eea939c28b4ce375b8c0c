---
name: loop-on-ci
description: "Watch a pull request's attached checks and iterate on failures until all required checks are green, treating the complete PR-attached check set as the source of truth. Use when a PR must be driven to green across repeated pushes. Resolve checks through a native connector, MCP tool, or authenticated gh, and confirm they match the current head. For a single failing check, use fix-ci."
---

# Loop on CI

## Trigger

Watch a branch or pull request and iterate on CI failures until all required checks are green.

The complete PR-attached check set is the source of truth. A provider-specific run list is not: it can miss checks from other providers attached to the same PR.

## GitHub capability resolution

Do not assume any single GitHub transport or CI provider. Resolve capability in this order:

1. Prefer a native or connected GitHub capability when the runtime provides one: a GitHub connector, an MCP GitHub integration, or an equivalent structured GitHub tool.
2. Otherwise use the authenticated GitHub CLI (`gh`) when shell execution is available, `gh` is installed, and `gh` is authenticated.
3. Otherwise report that the GitHub capability is unavailable. Do not claim checks are green when you cannot read them.

## Workflow

1. Resolve the pull request for the current branch and its current head SHA.
2. Retrieve all PR-attached checks using the available GitHub capability.
3. Verify the checks correspond to the current head SHA. Evidence attached to an older head is stale.
4. If any check failed, diagnose those failures first. For a single failure that needs focused repair, hand off to `fix-ci`.
5. If checks are pending, wait for the check set to settle before acting.
6. Fix only the cause of the failure. Push only if pushing is authorized and available.
7. After every push, re-read the complete PR-attached check set. The set can change between pushes.
8. Repeat until all required checks pass, a real blocker exists, or authority is required.

## Command examples

Fallback examples only. Prefer a native GitHub capability when one exists.

```bash
# Resolve the active PR
gh pr view --json number,url,headRefName,headRefOid

# Read all attached checks
gh pr checks --json name,bucket,state,workflow,link

# Watch pending checks and fail fast
gh pr checks --watch --fail-fast

# Logs for a GitHub Actions check, when the failing check links to a run
gh run view <run-id> --log-failed
```

## Guardrails

- Keep each fix scoped to a single failure cause.
- Do not bypass hooks to force progress.
- If a failure is clearly unrelated to the PR and already fixed on the base branch, refresh from the base instead of adding unrelated fixes.
- If a failure is flaky, retry once and report the flake evidence.
- Re-read the full check set after every push.

## Output

- Current check status, with the head SHA the checks belong to.
- Failure summary and the fixes applied.
- PR URL once all required checks are green, or the blocker and the exact next action.
