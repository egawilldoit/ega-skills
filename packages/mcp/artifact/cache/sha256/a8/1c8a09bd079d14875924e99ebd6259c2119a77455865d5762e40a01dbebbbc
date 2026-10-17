---
name: compare-designs
description: "Compare materially different designs for a non-trivial artifact before committing, by generating independent candidates, judging them against explicit criteria, and picking a base to graft the strongest ideas into. Use when multiple reasonable solutions exist and picking the first would lock in the wrong shape, or for 'compare designs' or 'throw it in the arena'. Not for mechanical changes with one obvious solution."
---

# Compare designs

Use when more than one reasonable solution exists and committing to the first would lock in the wrong shape. Generate materially different candidates under the same brief, judge them against explicit criteria, pick one as the base, and graft the strongest parts of the others into it. Then verify the result.

Do not use this for a mechanical change with one obvious solution. To design a single architecture, use `design-architecture`; that skill can call this one for the contested shape.

## Workflow

1. Frame. Write the single brief every candidate receives: the artifact, the constraints, and the caller's usage. Then write the rubric: 3 to 6 concrete, gradeable criteria describing what success looks like for this task. Candidates see the brief and the rubric, never each other.
2. Fan out. Spawn two to four independent candidates in parallel, each in its own workspace so they cannot collide. Each returns the artifact plus a short rationale naming the alternatives it rejected. If a candidate fails, proceed with the rest and record the dropout.
3. Cross-judge. When the candidates are done, run one independent judge that sees the rubric and the candidates by label, scores each criterion, and recommends a base with reasons. Keep the judge independent of the generation, and prefer a different reviewer than the parent when possible.
4. Pick the base. Read every candidate end to end before deciding, and score criterion by criterion rather than on overall feel. Compare against the judge. Agreement confirms the pick; disagreement means one view is biased or the rubric was vague, so resolve it before choosing. Prefer the candidate a future maintainer can extend most easily without breaking invariants. When tied, prefer the smaller public surface.
5. Graft. Walk each losing candidate for the one or two ideas worth porting. Fold them in by hand so the result stays coherent under one mental model. Record what was grafted, from where, and what was rejected and why. When candidates converge, note the convergence and ship the consensus. When they wildly diverge, the brief was under-specified, so reframe and re-run rather than averaging.
6. Verify. Treat the synthesized artifact as any other output and prove it works: run it, test it, or measure it. If verification finds a problem the comparison missed, either the brief was wrong or a losing candidate had the answer and the graft was missed.

See references/design-comparison.md for the brief, rubric, and synthesis record templates.

## Hard rules

- Candidates must be materially different, not flavors of one shape. If they converge, the brief was too narrow.
- Do not let one candidate see another's work while generating.
- Judge against criteria, not vibe. Name the criterion each score rests on.
- Do not paste a losing candidate in mechanically. Adapt it to the base's model.
- Do not average divergent candidates. Reframe and re-run.
- Do not run this on a task with one obvious solution.

## Output contract

- The synthesized artifact.
- A synthesis record: the base chosen and why, the grafts with their source candidate, the rejections with reasons, any dropouts, the judge's verdict, and the verification result.
- Open risks.

The labels and levels used here come from references/operating-contract.md. Report the evidence level reached when verifying.

**Reply:** the artifact plus the synthesis record.
