# Execution contract template

Copy this template and fill every section. Do not delete sections. Write `none` with a reason when a section does not apply.

Shared labels come from `operating-contract.md`.

---

```markdown
# EXECUTION CONTRACT

## MISSION
<One paragraph. The outcome, not the activity. What is true when this is done.>

## REPOSITORY IDENTITY
- host/owner/name: <e.g. github.com/owner/name>
- root: <absolute path or worktree>
- remote: <fetch URL>

## BASE SHA
<Full 40-character commit id. This is the pinned starting point.>

## HEAD SHA
<Full commit id, or `to-be-created`. If created, the executor reports it.>

## MODE
<One or more: INSPECT, PLAN, IMPLEMENT, REVIEW, FIX, INTEGRATE, DEPLOY, CERTIFY, RECONCILE>

## AUTHORIZED MUTATION
<Exactly one: L0 READ, L1 LOCAL FILE, L2 COMMIT, L3 REMOTE / PR, L4 EXTERNAL SYSTEM, L5 STAGING, L6 PRODUCTION>
<Anything above this level is AUTHORITY_REQUIRED.>

## CURRENT VERIFIED STATE
<What is proven true now, each line with its evidence source. Mark PROVEN, SUPPORTED, ASSUMED, UNRESOLVED.>

## AUTHORIZED DELTA
<desired state - current verified state = this delta. The smallest change that reaches the mission. Anything beyond it is forbidden.>

## MUST PRESERVE
<Behavior, interfaces, data, and invariants that must remain true. Each must be checkable.>

## FORBIDDEN SCOPE
<Files, modules, systems, data, and actions the executor must not touch. Include merge and deploy here if not authorized.>

## ARCHITECTURE INVARIANTS
<Rules the change must respect: source of truth, state ownership, boundaries, concurrency, failure behavior.>

## IMPLEMENTATION REQUIREMENTS
<Numbered, concrete requirements. Each maps to a validation rung and evidence item.>

## VALIDATION LADDER
<Cheapest to strongest. Name the exact command or procedure per rung.>
1. Static: <command>
2. Local execution: <command>
3. CI: <workflow or check>
4. Immutable artifact: <build and digest>
5. Runtime: <environment and probe>
6. Client or device: <intended client and workflow>

## REQUIRED EVIDENCE
<For each claim, the evidence level E0..E6 it must reach and the artifact that proves it.>

## STOP CONDITIONS
<Each with its blocker type.>
- <condition> -> HARD_STOP
- <condition> -> AUTHORITY_REQUIRED
- <condition> -> INVESTIGATE
- <condition> -> FIX_FORWARD

## MERGE AUTHORITY
<none | named role | exact authorization required>

## PRODUCTION AUTHORITY
<none | named role | exact authorization required>

## FINAL REPORT FORMAT
<The exact shape the executor must return. Include completion state, evidence level per claim, and any blocker.>
```

## Example final report format

```text
COMPLETION: IMPLEMENTED | TESTED | REVIEWED | CI_VALIDATED | MERGE_READY
BASE SHA: <sha>
HEAD SHA: <sha>
DELTA APPLIED: <files and systems changed>
EVIDENCE:
  - <claim>: <level>, <artifact>
VALIDATION: <each rung, pass or fail, with output>
MUST PRESERVE: <confirmed, or the check that proves it>
BLOCKERS: <none, or type and detail>
NEXT: <single next action, or AUTHORITY_REQUIRED>
```
