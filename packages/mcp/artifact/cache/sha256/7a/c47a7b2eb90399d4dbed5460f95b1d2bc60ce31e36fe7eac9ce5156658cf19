---
name: design-investigation
description: "Design an auditable investigation when no narrower workflow fits: a large migration, an ambitious multi-part change, or work a human reviews after stepping away. Use for 'figure this out', 'investigate this', or when a task has unknowns, unclear scope, or no known playbook. Before substantial work it establishes a falsifiable definition of done, scope, unknowns, risk, an investigation strategy, and an evidence plan, then runs a hypothesis loop and keeps a decision trail. Use verify-this to prove one claim; use this to design the whole approach."
---

# Design an investigation

When the task matches no narrower workflow, design one. The deliverable before any code is the workflow itself: a sequence of phases that scales rigor to the task, runs the scientific method, and leaves a decision trail a human can audit after stepping away.

Do not wander. Every phase produces an artifact, and every unit of work is an experiment with a stated hypothesis and a measured result.

## Phase A: Frame

Ground first, then commit. Do not start until you can state all of these:

- Definition of done as a falsifiable predicate. If you cannot imagine the observation that would prove it false, it is not done.
- Scope, quantified: rough units and effort, plus the blockers grounding surfaced.
- Unknowns: what you do not yet know, ranked by how much they threaten the plan.
- Risk: what is hard to reverse, what has high blast radius, and what could fail silently.
- Rigor level, biased high. One-way doors and high blast radius get more. Reversible low-stakes steps get less. Rigor means gates and artifacts, not "try harder".
- Investigation strategy: the order of work, riskiest unknown first.
- Evidence plan: what you will observe, on which artifact, to decide each step.

Present the framing and tradeoffs before committing to a long run. Reversible work proceeds. A multi-hour run earns one checkpoint.

## Phase B: Design the investigation

Decompose into atomic, independently landable units. Sequence the riskiest unknown first. Scaffold and verification come before features.

- Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as old value versus new value.
- For one-way-door design decisions, design the architecture explicitly before implementing. Skip it for mechanical work whose shape is already concrete. A second design pass over a settled decision is over-engineering.
- Decide what fans out. Parallelize only across seams, and give each worker its own worktree, branch, file, or state. Do not over-fan. If the seams are unclear, use `parallelize-work` only after they are clear.
- Write the phase list down. That list is what the human reviews.

Then execute the design. Add its steps as concrete items and run each under the Phase C loop.

## Phase C: Run the loop

Each unit is an experiment.

1. State the hypothesis.
2. Make the smallest change that tests it.
3. Measure against the predicate on the real artifact.
4. Keep it if it advanced the predicate; revert it if it did not.

Verify each unit before starting the next, instead of batching checks at the end.

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system.
- Pair delegated work with an independent check. If a worker games the gate, reset and harden the contract. If the gate itself is wrong, fix the gate in its own change rather than routing around it.
- A verdict is `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`. Inconclusive is not a pass. Never hide a negative.

## Phase D: Keep the audit trail

Log the run in a decision ledger: one row per consequential decision, with what was decided, why, the evidence pointer, and the result. Use `references/decision-ledger.md`. Keep it compact and reviewable. When a reviewer must trust the result after stepping away, commit the ledger so it is readable alongside the change. For long autonomous runs, `record-evidence` owns the same ledger at greater length.

## Phase E: Verify and hand back

Check the whole against the Phase A predicate on the real product, not only the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script so the lesson does not rely on memory.

## Hard rules

- No substantial work before a falsifiable definition of done exists.
- Each unit is an experiment with a hypothesis and a measured result.
- Inconclusive is not a pass. Do not hide a negative.
- Keep the decision trail as you go, not at the end.
- Do not expand scope silently. If the frame was wrong, return to Phase A.

## Output

Reply with the designed playbook, the rigor level and why, the decision-ledger location, what is verified against the predicate, and what is still open. Name the evidence level and the completion state from `references/operating-contract.md` that the result reached.
