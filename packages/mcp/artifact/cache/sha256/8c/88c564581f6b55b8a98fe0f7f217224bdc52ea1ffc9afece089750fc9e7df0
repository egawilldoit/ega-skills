---
name: understand-codebase
description: "Build a senior-engineer mental model of a subsystem: entry points, runtime path, modules, state ownership, dependencies, data flow, boundaries, and where a future change belongs. Use for 'how does X work', code walkthroughs before changing something, and placement or ownership questions. Use recover-design-rationale for why it is shaped that way."
---

# Understand codebase

Build a mental model of a subsystem at the level a senior engineer needs to work in it confidently: enough to trace the runtime path and know where a change belongs, not so much that it reads like annotated source.

This is the how. It answers what the code does, how it runs, what it owns, and where new code goes. For why the code is shaped this way, meaning constraints, history, and decisions, use `recover-design-rationale`. For what a change could break elsewhere, use `blast-radius`.

## When to use

- "How does X work", "walk me through Y", "what happens when Z".
- Before changing a subsystem you do not yet know.
- Placement and ownership questions: "where should this live", "which module owns this state", "is this the right layer".
- Onboarding onto an unfamiliar area.

## Workflow

1. Scope the question. If it is ambiguous, state your interpretation and proceed. Classify the size:
   - Narrow (one module, one function, a single file): explore and explain in one pass.
   - Broad (multiple files or services, a cross-cutting feature): split into 2 to 4 exploration angles, cover them in parallel, then synthesize. When in doubt, take the narrow path.
2. Anchor in code. Find the entry point before reading outward. Locate files, symbols, and tests rather than guessing from names.
3. Trace the runtime path from the entry point. For each step: what runs, where it lives, what it does, what it calls next, and what data moves. Read the implementations, not just the signatures.
4. Map the pieces. List the modules, types, and services, and what each owns. Identify state ownership: which component holds which state and who may mutate it.
5. Map data flow and dependencies, inbound and outbound. Mark the subsystem boundaries: what enters, what leaves, what is shared.
6. Answer the placement question. State where a new piece of behavior belongs and why, grounded in the existing ownership and layering.
7. Name what you could not trace. An explicit gap beats a hand-wave.

See references/exploration-guide.md for the exploration brief and the synthesis instructions.

## Answer quality

- Cite real locations: file path, symbol, and line where useful.
- Read the code. Do not infer behavior from names or comments alone.
- Separate what you verified by reading from what you assume.
- Prefer concrete statements ("OrderService.submit calls PaymentClient.charge") over abstractions ("the service delegates to the client").
- Explain non-obvious behavior you find, but do not invent a rationale for it. Motivation questions belong to `recover-design-rationale`.
- If the subsystem is too large to cover fully, say which slice you covered.

## Output contract

Use this shape, dropping sections that do not apply:

- Overview: what this is, what it does, why it exists.
- Key concepts: the types, services, and abstractions needed to follow the rest.
- How it works: the traced flow, step by step, with file references. Add a diagram only when the flow spans components and prose is not enough.
- Where things live: the file and directory map someone needs to start working here.
- State and ownership: which component holds which state, and the mutation rules.
- Boundaries and dependencies: what enters, what leaves, and what is shared with other subsystems.
- Placement: where a future change of the relevant kind belongs, and why.
- Gotchas: surprising behavior, pitfalls, and things easy to get wrong.
- Open questions: what you could not trace, and what it would take to trace it.

**Reply:** the explanation above, ending with open questions when any remain.
