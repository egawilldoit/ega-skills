# Classification

How to turn a recurring candidate into the right artifact. The order matters: search the existing ecosystem first, then choose the smallest artifact that removes the friction.

## Step 1: search the existing ecosystem

Before classifying, build an inventory:

- Existing skills and what each triggers on, from its name and description.
- Existing scripts and what each computes.
- Existing policies, rules, and checks.
- Existing templates and what each produces.

For each candidate, find the closest existing artifact by capability. Compare what the candidate needs to what the artifact does, not what either is called.

## Step 2: classify

| Class | Use when |
|-------|----------|
| `REUSE_EXISTING_SKILL` | An existing skill already covers the work. The problem is that it did not trigger, or the user did not know to reach for it. Fix the trigger, do not build. |
| `ADAPT_EXISTING_SKILL` | An existing skill is the right home, but its body or description needs a change to cover the candidate. |
| `BUILD_NEW_SKILL` | A recurring multi-step workflow with clear triggers and no existing home. |
| `BUILD_SCRIPT` | The work is deterministic and rerunnable. A script proves or performs it. |
| `BUILD_WORKFLOW` | A process convention that is real and valuable but not reliably triggerable. |
| `BUILD_POLICY` | A broad rule that should apply across tasks, ideally enforced by a check. |
| `BUILD_TEMPLATE` | A reusable artifact shape that gets copied into outputs. |
| `DO_NOT_ENCODE` | One-off, stale, contradicted, or low confidence. |

## Decision rules

1. Existing artifact first. If a skill already covers it, `REUSE_EXISTING_SKILL`. The fix is a trigger or awareness change, not a new skill.
2. Mechanism over prose. If a lint rule, script, metadata flag, or runtime check can enforce it, prefer `BUILD_SCRIPT` or `BUILD_POLICY`.
3. Smallest artifact. Prefer a script or policy to a new skill. Prefer a workflow doc to a skill when the trigger is unreliable.
4. New skill last. `BUILD_NEW_SKILL` requires recurrence, clear triggers, and no real home.
5. Distinct triggers. A new skill's description must not overlap an existing skill's trigger surface. If it would, it is an `ADAPT_EXISTING_SKILL`.
6. Wording is not capability. Do not create a duplicate because the candidate is phrased differently from the existing skill.

## Duplicate check

Before proposing `BUILD_NEW_SKILL`, answer all of these:

- Which existing skill is closest, and why is it not a real home?
- Does the candidate recur, with evidence from 2+ slices or 2+ instances?
- Does it deserve its own trigger surface, distinct from every neighbor?
- Would an `ADAPT_EXISTING_SKILL` or `BUILD_SCRIPT` solve it with less surface area?

If any answer is weak, downgrade the class.

## Examples

```text
The user re-derives the same release check every week.
  -> BUILD_SCRIPT, or REUSE_EXISTING_SKILL if a release skill already does it.

The user corrects the same report format in three sessions.
  -> ADAPT_EXISTING_SKILL on the reporting skill, or BUILD_TEMPLATE for the format.

A recurring multi-step migration flow with no skill and no script.
  -> BUILD_NEW_SKILL.

A one-time data cleanup from last month.
  -> DO_NOT_ENCODE.

The user always wants evidence attached to a claim, stated once as a general rule.
  -> BUILD_POLICY, ideally enforced by a check.
```

## After approval

- New or adapted skills go through the catalog's skill-authoring workflow, with descriptions checked for trigger collisions against neighbors.
- Scripts, policies, and templates are created in the repository that owns them, with a test or check where one is cheap.
- Record the classification and reason so the next mining run does not re-propose the same candidate.
