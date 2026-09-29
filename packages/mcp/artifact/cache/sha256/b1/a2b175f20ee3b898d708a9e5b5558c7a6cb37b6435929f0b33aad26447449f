# Worker brief template

Every brief stands alone. A worker that has never seen the parent's reasoning must be able to complete its slice from the brief alone. Copy this shape and fill every field. Leave no placeholders.

## Brief

```text
GOAL
  One sentence. What the slice must produce.

SCOPE
  The exact slice, or the race arm. State what is out of scope.

INPUTS
  Exact base SHA and any other pinned inputs. For measurement, the method:
  sample count, what one sample is, and order.

ISOLATION
  The branch, worktree, file, or state this worker owns. Name the resource
  no other worker may touch.

HOW TO VERIFY
  The command or check that proves the slice is done. Include the done predicate.

WHAT TO REPORT
  PASS, ISSUES, or BLOCKED, with evidence. List every provable issue, not the first.

EVIDENCE TO RETURN
  The artifact, metric, or citation that backs the verdict, plus the exact
  commands or SHAs used so the result can be reproduced.
```

## Isolation matrix

For each mutable resource the work touches, choose the isolation that removes the sharing. If a resource cannot be isolated, those slices are not parallel-safe; serialize them instead.

| Mutable resource | Isolation strategy |
|------------------|--------------------|
| Git branch | One branch or worktree per writer. Never two writers on one branch. |
| Working tree | One worktree per writer, or one writer at a time on a shared tree. |
| Source files | Disjoint file sets. Overlapping files mean serialize. |
| Database | One schema, database, or transaction namespace per writer. |
| Local server or port | One port or instance per writer, or one shared instance driven serially. |
| Scratch or output directory | One directory per writer, named by worker or slice. |
| External system | One account, namespace, or dry-run sandbox per writer. Avoid shared external state. |

## Aggregation rule

Declare how results combine before fanning out.

- Coverage: union of slices; every required slice must have a result.
- Race, `first pass`: the first valid result wins; the rest are discarded.
- Race, `rank all`: rank every valid result against the criteria and keep the order.
- Race, `best-of`: keep only the single best valid result.

A result that does not record the SHAs and method its brief named is invalid. Rerun that worker once, then record a gap.

## Integration rule

Aggregation produces one report. Integration lands the results one at a time, in a deterministic order, each on a verified base. Landing to a remote or opening a pull request requires authority for the current task.
