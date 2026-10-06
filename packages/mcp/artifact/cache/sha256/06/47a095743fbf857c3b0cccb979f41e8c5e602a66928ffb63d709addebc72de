# Architecture contract

The deliverable of this skill. One page or a short set of sections. Write it so an implementer can fill in bodies without re-deciding the shape. Sentence-case headings, no boilerplate.

## Problem and current verified state

What we are trying to do, and what about the existing system makes the shape non-obvious. State the current verified state with its evidence level: what exists, what owns what, what is guaranteed, and what is broken. Name the constraints the design must honor, such as existing types to interoperate with, callers that cannot break, and invariants that cross the boundary.

## Desired state

What must be true when the work is done, in observable terms. Lead with the caller or user outcome, then the internal properties.

## Usage (caller's view)

Write this before the shape. Show the quickstart a consumer reads plus two or three realistic call sites in their own code: what they import, what they call, what comes back. The shape is derived from this, and the two must agree. When they diverge, reconcile the shape to the usage, not the reverse. The caller's experience is the spec.

## Shape

The recommended architecture. Data structures first, then how data flows through the signatures. Name the load-bearing decisions. State which invariants are encoded in types, where validation lives, and what the system deliberately does not do. Judge interface depth explicitly: what complexity the public surface hides, what remains exposed, and why the surface is no larger than needed.

## Invariants, source of truth, and ownership

- Architectural invariants, and how each is enforced: type, runtime guard, or convention.
- Source of truth: one owner per fact, and how derived values are computed rather than synced.
- State ownership: the state, its owner, and who may mutate it.

## Failure behavior and concurrency

- What happens on partial failure, retry, timeout, and crash.
- Which operations are idempotent, and what happens if one runs twice.
- Which actors share state, and what happens if two write. If the answer is not "nothing", prefer removing the sharing over serializing it.

## Migration path and backward compatibility

- The ordered steps from current to desired, each ending in a working state.
- What existing callers, data, or wire formats must keep working, and for how long.
- When the old and new shapes coexist, which one is authoritative.

## Validation strategy

How each invariant and behavior will be proven, and at what evidence level. Name the check, the surface it runs on, and what a failure looks like.

## Tradeoffs accepted

One bullet per tradeoff, in the form "we accept X in exchange for Y". Include anything a future reader might mistake for an oversight.

## Alternatives considered

At least one concrete alternative shape, with one line on why it lost. Judge each on interface depth, not implementation simplicity alone. Name the complexity it exposes to callers and the complexity it hides. Avoid listing flavors of the same shape. This section is about design alternatives the chosen shape rejected, not about candidate runs.

## Open questions and risks

What the human needs to weigh in on, phrased as questions so their answer is the resolution. Risks worth flagging before implementation starts.

## Next implementation step

The first thing to build against the contract. One sentence.
