---
name: build-execution-contract
description: "Turn a requirement, analysis, or design into a bounded implementation contract another agent can execute without guessing. Use when delegating a substantial change, handing work to a subagent, or converting a plan into an authorized, scoped, and verifiable task. Emits fixed sections from MISSION through FINAL REPORT FORMAT, with base and head SHAs, authorized mutation level, must-preserve invariants, forbidden scope, validation ladder, required evidence, stop conditions, and merge and production authority. Use preflight-repository to establish the facts it pins; this skill writes the contract."
---

# Build execution contract

A handoff prompt that leaves the executor guessing is a defect. This skill converts a requirement or analysis into a bounded contract: what to do, what not to touch, how far the executor may mutate, how success is proven, and when to stop.

The contract is the artifact. It is written to be pasted to another agent or a subagent unchanged.

Vocabulary comes from `references/operating-contract.md`. The full section template lives in `references/execution-contract-template.md`.

## When to use

- Delegating a non-trivial change to another agent or subagent.
- Converting an approved design or investigation result into an implementation task.
- Replacing a long ad hoc implementation prompt you rebuild every time.
- Splitting one large change into several independently executable contracts.

Do not use it for a one-line edit or for exploratory work that has no defined delta yet. Establish the delta first with `design-investigation` or `design-architecture`.

## Inputs

Before writing, gather or confirm:

```text
the requirement or accepted analysis
repository identity and root
base SHA and target head or branch
the current verified state
the desired state
the delta between them
known invariants that must not break
anything explicitly out of scope
how success will be proven
who holds merge and production authority
```

If the base SHA or repository identity is unknown, run `preflight-repository` first. A contract with an unproven base SHA is unsafe.

## Workflow

1. Fix repository identity and the base SHA. These are pinned facts, not prose.
2. State the current verified state and the desired state, then the authorized delta as the subtraction between them.
3. Choose the mode and mutation level from the operating contract. The executor stops at the stated level.
4. List must-preserve invariants and forbidden scope. Be explicit about files, modules, systems, and data.
5. Write the validation ladder from cheapest check to strongest, and the evidence each rung requires.
6. Write stop conditions and the authority for merge and production.
7. Define the final report format so the executor returns checkable facts.
8. Run `scripts/validate_contract.py` to confirm every required section is present.

## Sections

Every contract contains these sections, in this order. Empty sections are not allowed; write `none` with a reason.

```text
MISSION
REPOSITORY IDENTITY
BASE SHA
HEAD SHA
MODE
AUTHORIZED MUTATION
CURRENT VERIFIED STATE
AUTHORIZED DELTA
MUST PRESERVE
FORBIDDEN SCOPE
ARCHITECTURE INVARIANTS
IMPLEMENTATION REQUIREMENTS
VALIDATION LADDER
REQUIRED EVIDENCE
STOP CONDITIONS
MERGE AUTHORITY
PRODUCTION AUTHORITY
FINAL REPORT FORMAT
```

Field rules:

- `BASE SHA` and `HEAD SHA` are full commit ids. Use `HEAD SHA: to-be-created` only when the executor creates the commit, and require it in the report.
- `MODE` is one or more work modes from the operating contract.
- `AUTHORIZED MUTATION` is one `L0`..`L6` level. Anything above it is `AUTHORITY_REQUIRED`.
- `AUTHORIZED DELTA` is the smallest change that reaches the desired state. Anything beyond it is forbidden.
- `VALIDATION LADDER` orders checks from static to runtime to client. Name the exact command or procedure per rung.
- `REQUIRED EVIDENCE` names the evidence level `E0`..`E6` each claim must reach. Never require a level the executor cannot produce.
- `STOP CONDITIONS` name the blocker type for each: `FIX_FORWARD`, `INVESTIGATE`, `HARD_STOP`, or `AUTHORITY_REQUIRED`.
- `MERGE AUTHORITY` and `PRODUCTION AUTHORITY` state `none`, a named role, or the exact authorization required. Default to `none`; capability is not permission.

## Hard rules

- Pin the base SHA. Never let the executor discover its own starting point.
- State mutation authority explicitly. "Do not merge" and "do not deploy" must be written, not assumed.
- Keep the delta minimal. Do not bundle unrelated cleanups into the authorized scope.
- Every requirement must map to a validation rung and a piece of evidence. If it cannot be checked, say so.
- Do not invent commands, tools, endpoints, or versions. Reference what the repository actually has.
- The contract is platform-neutral. Do not name a specific model or subagent runtime.

## Output contract

Return the filled contract as a single markdown block, plus:

```text
CONTRACT STATUS: COMPLETE | INCOMPLETE
UNPROVEN INPUTS: <list, or none>
BASE SHA: <sha or unknown>
AUTHORIZED MUTATION: <L0..L6>
NEXT: <the single next action>
```

`INCOMPLETE` is correct when a required fact is unproven. Report it rather than filling the gap with an assumption.
