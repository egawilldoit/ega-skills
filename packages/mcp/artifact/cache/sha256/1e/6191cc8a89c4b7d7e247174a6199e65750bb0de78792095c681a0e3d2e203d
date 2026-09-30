---
name: run-smoke-tests
description: "Run the project's existing end-to-end smoke suite, capture failures from traces and logs, and report the result. Use for pre- or post-change smoke verification, or when an existing suite needs to be driven. Running the suite is read-only by default; edit product or test code only when repair is explicitly requested or already authorized. Prefer deterministic waits over timeouts."
---

# Run smoke tests

## Trigger

Need end-to-end smoke verification before or after changes.

## Workflow

1. Resolve the repository's existing smoke-test command and required build prerequisites.
2. Run the relevant smoke suite or the narrowest existing smoke test that answers the request.
3. If a test fails, inspect traces and logs and isolate the most likely root cause.
4. If the task is verification-only, stop and report the failure with evidence.
5. If repair is explicitly requested or already authorized, apply the smallest fix that addresses the proven cause and rerun the affected smoke test.
6. Re-run the relevant passing path when needed to distinguish a stable fix from a flaky pass.

## Example commands

```bash
# Run the full smoke suite when this is the repository's real command.
npm run smoketest

# Run a focused smoke test when the suite supports a path argument.
npm run smoketest -- path/to/test.spec.ts
```

Treat these as examples, not assumed repository commands. Prefer the commands the project already defines.

## Guardrails

- A request to run smoke tests does not authorize code changes.
- Do not weaken assertions, rewrite expected behavior, or quarantine a test merely to make the suite green.
- Quarantine a test only when the task explicitly authorizes it and the reason is documented.
- Prefer deterministic waits and observable conditions over fixed sleeps.
- Keep authorized fixes scoped to the proven failure.

## Output

- Commands executed and smoke-test result
- Failing scenario, trace, or log evidence
- Root cause or best-supported diagnosis
- Changes applied, only if repair was authorized
- Remaining flake risk or blockers
