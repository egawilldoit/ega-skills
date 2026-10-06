---
name: design-architecture
description: "Design an architecture before implementation: current verified state, desired state, invariants, source of truth, state ownership, failure behavior, concurrency, migration path, backward compatibility, and validation strategy. Use for 'design this', 'architect this', a cross-cutting change, or non-trivial work where jumping straight to code would lock in the wrong shape."
---

# Design architecture

Design the shape before writing the code. Produce an implementable architecture contract, not a sketch that reads well and constrains nothing. The contract names the types, the ownership, the invariants, and the migration path, and it is specific enough that implementation is mostly filling in bodies.

For a shape that is genuinely contested among several reasonable options, use `compare-designs` to generate and compare candidates. To read the existing system, use `understand-codebase`; for why it is shaped that way, use `recover-design-rationale`.

## When to use

- "Design this", "architect this", "how should this be structured".
- A cross-cutting change, a new subsystem, or a change that redefines ownership, layering, or a public surface.
- Any non-trivial work where the first plausible shape would be expensive to undo.
- Not for a mechanical change with one obvious shape.

## Workflow

1. Ground the current state. Trace every system the new code touches with `understand-codebase`. Naming a file is not grounding. State the current verified state: what exists, what it owns, what it guarantees, and what is broken. If the design moves ownership or layering, run `recover-design-rationale` so existing constraints become inputs rather than guesses. Skip only when the work is genuinely greenfield.
2. State the desired state. What must be true when the work is done, in observable terms. Name the user or caller outcome before any implementation detail.
3. Write the caller's usage first. Show what the consumer imports, calls, and receives, with two or three realistic call sites. The type and module sketch is derived from the usage, not the other way around. When they diverge, fix the sketch to match the usage.
4. Decide the load-bearing questions and write each one down:
   - Architectural invariants: what must always hold. Which are enforced by types, which by runtime guards, which by convention.
   - Source of truth: one owner per fact. Derive, do not sync.
   - State ownership: what state exists, which component owns it, and who may mutate it.
   - Failure behavior: what happens on partial failure, retry, timeout, and crash. Which operations are idempotent, and what happens if one runs twice.
   - Concurrency: which actors share state, and what happens if two write. Prefer eliminating shared writes over adding locks.
   - Migration path: the ordered steps from current to desired, each ending in a working state.
   - Backward compatibility: what existing callers, data, or wire formats must keep working, and for how long.
   - Validation strategy: how each invariant and behavior will be proven, at what evidence level, before and after shipping.
5. Screen the shape. Reject shallow modules, information leakage, pass-through layers, and temporal decomposition. See references/design-red-flags.md.
6. Write the contract using references/architecture-contract.md.
7. Optionally pressure-test the design with `adversarial-review` before implementing, when the stakes justify it.

## Implement against the contract

The contract is the spec. Fill in bodies against it. A deviation during implementation is signal: decide whether the contract was wrong, the requirement was missed, or the implementation is overreaching, and update the contract deliberately rather than absorbing the deviation silently.

## Scrap when the shape is wrong

Watch for a pattern, not a single edge case: the same workaround repeating across unrelated code, a growing set of special-case branches, types that need escape hatches to compile, or callers forced to know an abstraction's internal rules. When the pattern appears, throw the shape out and redesign from first principles instead of bolting fixes on. Subtract before adding, so the new shape starts smaller than the old one.

## Output contract

- Problem and current verified state.
- Desired state.
- Usage, from the caller's view.
- Shape: data structures first, then the flow, then the named decisions.
- Invariants, source of truth, and state ownership.
- Failure behavior and concurrency.
- Migration path and backward compatibility.
- Validation strategy.
- Tradeoffs accepted, each as "we accept X in exchange for Y".
- Alternatives considered, each with why it lost.
- Open questions and risks, phrased as questions.
- Next implementation step, one sentence.

The terms used here (work mode, evidence level, mutation level, authority) come from references/operating-contract.md. Any claim about the current state names the evidence level it reached.

**Reply:** the architecture contract, with open questions called out.
