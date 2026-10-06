---
name: deliver-software
description: "Route non-trivial engineering work to the right workflow instead of improvising. Use at the start of a task that spans investigation, design, a bug, review, integration, a release, resuming prior work, or an autonomous run, to pick the narrowest skill that fits and hand off to it. For a small change with one obvious shape, skip this skill and just do the work."
---

# Deliver software

Top-level router for non-trivial engineering work. Classify the request, pick the narrowest skill that fits, and run it. This skill routes. It does not duplicate the skills it points to.

## Classify first

Identify three things before routing:

- The work mode: INSPECT, PLAN, IMPLEMENT, REVIEW, FIX, INTEGRATE, DEPLOY, CERTIFY, or RECONCILE.
- The mutation level the task is authorized for, L0 to L6. Do not exceed it.
- Whether the task is read-only. Read-only work never needs authority.

These labels are defined in references/operating-contract.md.

## Route

- Need to understand how code works, or where a change belongs -> `understand-codebase`.
- Need why code is shaped that way, or the history behind a decision -> `recover-design-rationale`.
- A bug to reproduce and fix -> `principle-fix-root-causes` for the root cause, with `tdd` when there is a cheap failing-test path, and `verify-this` to prove the fix.
- Need to design an architecture before implementing -> `design-architecture`.
- Several reasonable designs and picking the first would lock in the wrong shape -> `compare-designs`.
- A specific claim needs proof -> `verify-this`.
- An important completed change needs independent challenge -> `adversarial-review`.
- A single normal pull request to review and ship -> `review-and-ship`.
- A stack of pull requests to land -> `integrate-pr-stack`.
- A release to certify -> `certify-release`.
- Resuming or taking over prior work -> `recover-work-context`.
- Long, autonomous, or multi-phase work a human will review later -> `record-evidence` for the decision trail, alongside the skill that does the work.
- A session finished and lessons to capture -> `work-retrospective`.
- No narrower skill fits, or the task is a large migration or an ambitious multi-part change -> `design-investigation`.

When a task spans several rows, route the first step, then re-route as the work moves. Understanding precedes design, design precedes implementation, and implementation precedes review, integration, and release.

## Hard rules

- Route, do not improvise a parallel process. If a listed skill fits, use it.
- Do not exceed the authorized mutation level. Push, pull request, merge, deploy, tracker changes, and deletion each need explicit authority for this task.
- A task being reversible does not make it authorized. When authority is unclear, report the action instead of taking it.
- Name the evidence level a claim actually reached. Never report higher than the evidence supports.
- Do not copy a child skill's workflow here. Point to it and follow it.
- Keep the routing decision to one or two lines, then act.

## Output contract

Open with one line naming the chosen skill and the work mode, then follow that skill's output contract. If no skill fits, or authority is missing, state the blocker type (FIX_FORWARD, INVESTIGATE, HARD_STOP, AUTHORITY_REQUIRED) and the exact next action.

**Reply:** the routing line, then the chosen skill's result.
