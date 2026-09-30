---
name: check-compiler-errors
description: "Run the repository's compile and type-check commands, summarize failures by file and category, and report what needs fixing without changing code unless edits are authorized. Use after edits, when a build or type-check breaks, or before review. If repair is explicitly requested or already authorized, fix the highest-confidence issues one at a time and rerun the checks."
---

# Check compiler errors

## Trigger

Compile or type-check status needs to be inspected, or known compiler failures need diagnosis.

## Workflow

1. Resolve and run the repository's compile and type-check commands.
2. Summarize failures by file, category, and root cause where the evidence supports one.
3. If the task is diagnostic or read-only, stop and report the failures and the next likely fix.
4. If code edits are explicitly requested or already authorized, fix one highest-confidence failure cause at a time.
5. Re-run the affected compile or type-check command after each authorized fix.
6. Stop when checks are clean, the authorized scope is exhausted, or the remaining cause is unproven.

## Guardrails

- Finding compiler errors does not authorize editing files.
- Do not weaken compiler settings, type checks, or assertions to make the command pass.
- Keep authorized fixes scoped to the reported failure. Do not clean up unrelated code.
- If the repository's compile command is missing or cannot run, report that instead of inventing a substitute result.

## Output

- Commands executed and current compile or type-check status
- Error summary grouped by file and category
- Root cause or next likely fix, with confidence when uncertain
- Changes applied, only if edits were authorized
- Remaining blockers
