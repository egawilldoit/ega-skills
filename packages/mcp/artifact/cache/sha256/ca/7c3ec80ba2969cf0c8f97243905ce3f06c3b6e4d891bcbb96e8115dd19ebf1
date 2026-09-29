# Recommendation taxonomy

Every accepted finding gets exactly one classification. Pick the smallest artifact that reliably prevents the problem.

## Classes

| Class | Use when | Artifact |
|-------|----------|----------|
| `SCRIPT` | The step is deterministic and can be rerun to prove or perform it. | A script under the skill or repository that owns the step. |
| `SKILL` | A recurring multi-step workflow with clear triggers and no existing home. | A new `SKILL.md` with a distinct description. |
| `SKILL_UPDATE` | An existing skill is the right home but its body is missing, weak, or mis-placed. | An edit to that skill, or a description tune when it failed to trigger. |
| `POLICY` | A broad rule that should apply across tasks, ideally enforceable. | A rule, lint, gate, or check that makes the wrong thing hard. |
| `WORKFLOW` | A process convention that is real but not reliably triggerable. | A checklist or workflow doc. |
| `DOCUMENTATION` | Context worth writing down that is not enforceable and not triggerable. | A doc, a comment, or a note. |
| `NOTHING` | One-off, stale, contradicted, or low confidence. | None. Do not encode. |

## Decision rules

1. Recurrence first. If nothing would make the problem happen again, classify `NOTHING` or, at most, `DOCUMENTATION`.
2. Mechanism over prose. If a lint rule, script, metadata flag, or runtime check can enforce the rule, prefer `SCRIPT` or `POLICY` over a `SKILL_UPDATE`. Prose is for what mechanisms cannot enforce.
3. Existing home first. If an existing skill owns the workflow, the answer is `SKILL_UPDATE`, not `SKILL`. Read the target skill before proposing the edit.
4. Trigger versus body. If the skill existed and was right but did not fire, the fix is a description tune, still classified `SKILL_UPDATE`.
5. New skill last. Propose `SKILL` only when no existing skill is a real home, the pattern recurs, and the topic deserves its own trigger surface.
6. Keep it small. Prefer the smallest artifact that prevents the problem. A one-line rule beats a section; a script beats a rule.

## One-off guard

For each candidate, answer: what would make this recur? If the answer is "nothing, it was specific to this task", it is not durable.

- A single typo: `NOTHING`.
- A task-specific correction that will not repeat: `NOTHING`.
- A correction the user made twice, or a rule they stated as general: durable, classify it.
- A step that cost an hour once but would cost the same on any similar task: durable, classify it.

## Examples

```text
User pasted the ticket title twice because the agent did not fetch it.
  -> SKILL_UPDATE on the workflow skill: fetch the ticket before asking.

The same flaky test tripped the run three times.
  -> SCRIPT that detects or retries the flake, or POLICY if it is a suite-wide rule.

The agent skipped a runtime check and reported success from a summary.
  -> SKILL_UPDATE: add the artifact check to the verification step.

A new multi-step release workflow appeared with no skill for it.
  -> SKILL, with a distinct description.

A reviewer typo in one commit message.
  -> NOTHING.
```

## Structural enforcement check

Before accepting any body edit, ask whether a mechanism would enforce it more reliably than text: a type constraint, a lint rule, a test, a script, a metadata flag, or a runtime check. If yes, move it to `SCRIPT` or `POLICY`. Skill prose is the fallback for judgment that cannot be mechanized.
