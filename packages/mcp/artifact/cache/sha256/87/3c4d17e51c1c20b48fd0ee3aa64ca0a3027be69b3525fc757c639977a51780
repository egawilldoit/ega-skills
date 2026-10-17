# Pattern signals

What to hunt in a history window. Each slice miner looks for the same signals and returns candidates in the same schema. Keep raw history in the subagents; the main thread gets findings with evidence pointers.

## Signals

### Response and interaction preferences

- Length, tone, format corrections ("shorter", "dumb it down", "show a table").
- Repeated clarifications the user has to make.
- The same context supplied more than once.

### Corrections and friction

- "Not what I asked", "stop", "no", repeated rework.
- A step the user performs by hand every time.
- A tool, command, or flag that has to be rediscovered each run.

### Delegation habits

- When the user reaches for subagents, parallelism, or a specialized workflow.
- How work is split and aggregated.
- Handoffs that lose context.

### Verification posture

- What "done" means to the user: unit tests, a live repro, a screenshot, a real client.
- Checks that are demanded and checks that are skipped.
- Cases where a result was accepted without proof.

### Code and prose discipline

- Style rules, principles cited, lint and format tools.
- Review expectations.

### Process conventions

- Branching, commits, pull requests, review and merge tooling.
- Environments, worktrees, release steps.
- Repeated multi-step workflows with a stable shape.

### Meta patterns

- Fixing a skill mid-task.
- Proposing or requesting a new skill.
- Requests to automate or remember something.

## Candidate schema

Each candidate carries:

```text
trigger           what situation starts this work
workflow step     the step or sequence that repeats
decision rule     the choice the user consistently makes
quality bar       what good looks like to the user
stop condition    when the step is done
evidence pointer  conversation id, commit, ticket, or file that shows it
confidence        strong, medium, weak, or contradicted
```

## Mining rules

- Order candidates by real modification time, not by identifier.
- Grep the topic first, then read only matching regions.
- Skip the current session and obvious noise: subagent, evaluation, and test runs.
- Cross-check across slices. A signal in 2+ slices is high confidence.
- A null result is a finding: report the signal that was searched and not found.
- Redact secrets, credentials, customer data, and private content before they leave a subagent.

## Confidence scale

```text
strong        explicit user preference, workflow-changing correction, or pattern in 2+ slices
medium        accepted workflow, repeated tool or validation preference, or subagent agreement
weak          agent-chosen behavior with no feedback, or one ambiguous instance
contradicted  evidence points in incompatible directions; ask before writing anything
```

Only `strong` and `medium` justify an artifact. `weak` is dropped or held. `contradicted` blocks.
