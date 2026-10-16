# Operating contract

Shared vocabulary for this catalog's owned skills. It exists so skills can
state facts precisely instead of writing long prose. Copy it into a skill's
`references/` folder when that skill relies on these terms.

This is a working reference, not a philosophy. Use the labels; skip the essay.

## Work mode

What kind of work is happening. A task usually moves through several.

```text
INSPECT     read-only fact finding
PLAN        decide the approach and its contract
IMPLEMENT   make the change
REVIEW      challenge correctness independently
FIX         repair a specific confirmed finding
INTEGRATE   land changes, one at a time
DEPLOY      move an artifact into an environment
CERTIFY     prove a gate is actually reached
RECONCILE   resolve disagreement between sources of truth
```

## Mutation level

How far a change reaches. State the level a task is authorized for, and stop
at it.

```text
L0 READ          no writes
L1 LOCAL FILE    working-tree edits only
L2 COMMIT        local commits
L3 REMOTE / PR   push branches, open or update pull requests
L4 EXTERNAL SYSTEM  trackers, registries, third-party state
L5 STAGING       staging or preview environments
L6 PRODUCTION    production systems, data, or user-visible surfaces
```

## Evidence level

How strongly a claim is proven. Name the level you actually reached; never
report a higher level than the evidence supports.

```text
E0 CLAIM         asserted, not checked
E1 STATIC        read the source, no execution
E2 LOCAL EXECUTION  ran it on this machine
E3 CI            ran in the project's continuous integration
E4 IMMUTABLE ARTIFACT  a digest/checksum-pinned artifact was produced
E5 RUNTIME       observed in a running environment
E6 REAL CLIENT / DEVICE  observed through the intended client or hardware
```

## Knowledge state

How much is actually known about a fact.

```text
PROVEN        demonstrated by evidence
SUPPORTED     consistent evidence, not exhaustive
ASSUMED       taken as true without checking
UNRESOLVED    not enough information yet
CONTRADICTED  evidence disagrees
```

## Completion state

How far a unit of work has actually progressed.

```text
IMPLEMENTED
TESTED
REVIEWED
CI_VALIDATED
MERGE_READY
MERGED
DEPLOYED
RUNTIME_VERIFIED
CLIENT_VERIFIED
CLOSED
```

## Blocker type

What to do when work cannot continue.

```text
FIX_FORWARD        proceed by repairing the issue directly
INVESTIGATE        gather more evidence before deciding
HARD_STOP          do not proceed; a precondition is false
AUTHORITY_REQUIRED do not proceed; the task does not authorize this
```

## Authority model

Capability is not permission. The two questions are separate:

```text
CAN the agent do this?      capability
IS this task authorized to do this?  authority
```

A change being reversible does not make it authorized. Actions such as the
following require explicit authority for the current task, at the stated
mutation level, even when they are technically possible:

```text
push
open or update a pull request
merge
deploy
modify a production database
send an external message
delete resources
change external tracker state
```

When authority is unclear, treat the action as `AUTHORITY_REQUIRED` and report
it instead of acting. Read-only inspection never needs authority.

## Reporting

Every owned skill that reports a verdict should return one of the defined
labels, the evidence level it reached, and the exact next action. Prefer a
short, checkable statement over a narrative.
