---
name: parallelize-work
description: "Parallelize work only when it can be split safely, then aggregate deterministically. Use for 'parallelize this', 'fan this out', 'run these in parallel', or a large sweep of independent slices, races, or coverage. Requires a clear decomposition, no conflicting mutable ownership, isolated branches, worktrees, files, or state, and explicit aggregation. Parallel execution never implies parallel merge or integration: integration stays serial and ordered. Use design-investigation when the task shape is unknown; use this once the seams are clear."
---

# Parallelize work

Fan out independent work, drain it, and return one report. Parallelism is a tool, not a default. It is worth it only when the decomposition is clean and the results can be merged without conflict.

The invariant that governs everything below:

```text
parallel execution is allowed
parallel integration is not
```

Preparation can run in parallel. Landing changes stays serial.

## 1. Frame before fanning out

Open a todo list with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Integrate
5. Report

State the done predicate and the artifact or report the fan-out must return. Then answer these before spawning anything:

- Decomposition: can the work be cut into slices that do not depend on each other? If a slice needs another slice's output, the seam is wrong.
- Mutable ownership: does any slice write to a resource another slice also writes? Shared files, shared branches, shared databases, shared ports, and shared scratch directories are conflicting mutable ownership. Eliminate the sharing or serialize those slices.
- Isolation: where appropriate, give each writer its own branch, worktree, file, or state. See `references/worker-brief-template.md` for the isolation matrix.
- Aggregation: define how results combine before you start. The combination rule is part of the frame, not an afterthought.
- Shape: partition into slices, race workers on identical briefs, or mix both. For a race, declare `first pass`, `rank all`, or `best-of` up front.
- N: total workers, derived from the shape or given by the user.

If the decomposition, isolation, or aggregation is not clear, stop and use `design-investigation`. Do not fan out to hide an unclear plan.

## 2. Fan out

Spawn all workers in one message when the tooling supports it. Every brief stands alone: goal, scope, exact slice or race arm, inputs, isolation, how to verify, and what to report. Use `references/worker-brief-template.md`.

- Workers report `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.
- When workers verify or measure a commit, each brief names the exact SHAs. A measurement brief also names the method: sample count, what one sample is, and order. The worker records both in its result.
- A worker that drops out reduces the effective count by one. Note it; do not silently substitute.
- One writer per mutable resource. If two briefs would write the same resource, they are not parallel-safe.

## 3. Aggregate

Read the results. Drop any result that does not record the SHAs and method its brief named, and rerun that worker once. After a second miss, record a gap. A gap does not count as a pass.

- For coverage, every required slice needs a result.
- For a race, apply the selection rule declared up front.
- Do not paste raw worker dumps. Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## 4. Integrate serially

Aggregation is not integration. Land results one at a time, in a deterministic order, each on a verified base.

- Re-read every artifact before landing it.
- Revalidate after each landing; a later landing must not silently invalidate an earlier one.
- Never resolve a conflict by discarding one side wholesale. Preserve semantic intent.
- If two results conflict, the decomposition was wrong. Re-frame, do not force the merge.

Landing to a remote, opening a pull request, merging, or deploying requires authority for the current task at the stated mutation level. Parallel preparation never authorizes parallel landing.

## Hard rules

- Do not parallelize without a clear decomposition and explicit aggregation.
- Do not allow two writers to own the same mutable resource.
- Do not treat a gap or dropout as a pass.
- Do not merge in parallel. Integration is serial.
- Do not hide an unclear plan behind fan-out.

## Output

Return one consolidated report: the result table, one-line evidenced issues, gaps or dropouts, the selection rule when a race was used, and the serial integration order. Name the evidence level from `references/operating-contract.md` that the aggregate rests on.
