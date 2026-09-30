---
name: fix-ci
description: "Find a failing pull-request check, inspect the actual logs or check link, and apply the smallest fix that turns it green, one failure cause at a time. Use when CI is red and needs focused repair. Resolve checks and logs through a native connector, MCP tool, or authenticated gh; follow external CI evidence where accessible and report inaccessible logs honestly."
---

# Fix CI

## Trigger

A branch or pull request has a failing check and needs a fast, focused path to green. This skill repairs one failure cause. To drive a whole PR to green across pushes, use `loop-on-ci`.

## GitHub capability resolution

Do not assume any single GitHub transport or CI provider. Resolve capability in this order:

1. Prefer a native or connected GitHub capability when the runtime provides one: a GitHub connector, an MCP GitHub integration, or an equivalent structured GitHub tool.
2. Otherwise use the authenticated GitHub CLI (`gh`) when shell execution is available, `gh` is installed, and `gh` is authenticated.
3. Otherwise report that the GitHub capability is unavailable. Do not claim a check was inspected or fixed when it was not.

Do not assume the check is GitHub Actions. The check may point to any CI provider. Follow the check's own link and logs.

## Workflow

1. Resolve the exact pull request head SHA and the failing check.
2. Read the actual failure evidence: the check's logs, artifacts, or link target. Do not infer the failure from the check name alone.
3. Classify the failure: compile or type error, test failure, lint or format, dependency, environment, infrastructure, or flake.
4. Reproduce locally when practical, using the same command the check runs.
5. Apply the smallest fix that addresses the cause, not the symptom.
6. Run focused validation for the fix.
7. Push only if pushing is authorized and available.
8. Re-check the exact head's CI after the push. Confirm the repaired check and the rest of the attached set.

## Command examples

Fallback examples only. Prefer a native GitHub capability when one exists.

```bash
# Resolve the active PR and its head
gh pr view --json number,url,headRefName,headRefOid

# Read all attached checks
gh pr checks --json name,bucket,state,workflow,link

# Logs for a GitHub Actions check, when applicable
gh run view <run-id> --log-failed
```

## Guardrails

- Fix one actionable failure at a time.
- Prefer a minimal, low-risk change over a broader refactor.
- If a check's logs are not accessible, report that honestly instead of guessing the cause.
- Do not bypass hooks to force progress.

## Output

- The failing check and its exact head SHA.
- Root error and the fix applied.
- Post-fix check status and the exact next action.
