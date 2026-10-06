---
name: certify-production-target
description: "Verify the exact production target before a high-impact mutation: project, database, server, environment, deployment, branch, SHA, and account or organization. Return TARGET_CERTIFIED, AMBIGUOUS_TARGET, WRONG_TARGET, or INSUFFICIENT_EVIDENCE. Use before deploys, destructive commands, production data changes, or any operation where hitting the wrong target is costly. AMBIGUOUS_TARGET is a hard stop for destructive or production mutation."
---

# Certify production target

Before a high-impact mutation, prove the operation will hit the intended target
and nothing else. Wrong-target incidents are rarely caused by a bad command.
They are caused by a correct command aimed at an unverified target.

This is a read-only check. It never mutates the target in order to identify it.

## Target identity

Verify each field that applies to the operation:

```text
account or organization
project
environment (production, staging, preview)
deployment
database
server or host
branch
commit SHA
```

Only the fields that the operation can affect matter. A read-only report needs
fewer; a destructive migration needs all of them.

## Workflow

1. Write down the intended target from the task itself, before touching any
   system. Record each field explicitly, including fields the task leaves
   implicit.
2. Observe the target that the current credentials and configuration actually
   resolve to. Use read-only inspection.
3. Compare field by field. Mark each field `MATCH`, `MISMATCH`, or `UNKNOWN`.
4. Classify the target using the verdict rules below.
5. If any field is `MISMATCH`, stop. If any required field is `UNKNOWN` and the
   operation is destructive or production, stop.

## Verdicts

```text
TARGET_CERTIFIED     every relevant field MATCH, none UNKNOWN
AMBIGUOUS_TARGET     one or more relevant fields UNKNOWN, or credentials
                     resolve to more than one candidate
WRONG_TARGET         one or more fields MISMATCH the intended value
INSUFFICIENT_EVIDENCE  the target cannot be observed with available access
```

## Hard rules

- `AMBIGUOUS_TARGET` is a hard stop for destructive or production mutation. Do
  not proceed to "resolve it during the operation".
- `WRONG_TARGET` is always a hard stop.
- Never mutate, create, or delete anything to determine identity. Identify by
  reading.
- Do not assume the default profile, default project, or default environment is
  the intended one. Verify it.
- Certification is not authorization. A certified target still needs explicit
  authority at the required mutation level (`L5` or `L6`) for the operation.
- Distinguish this from `certify-release` (whole-release gates) and from
  `certify-database-rollout` (a migration's full lifecycle).

## Output contract

```text
VERDICT: TARGET_CERTIFIED | AMBIGUOUS_TARGET | WRONG_TARGET | INSUFFICIENT_EVIDENCE

Intended target:
- account/organization: <value>
- project: <value>
- environment: <value>
- database: <value>
- server: <value>
- branch: <value>
- SHA: <value>

Observed target:
- <field>: <value> (source, evidence level)

Field comparison:
- <field>: MATCH | MISMATCH | UNKNOWN

Operation: <what is about to run>
Mutation level: <L0-L6>
Authority: authorized | AUTHORITY_REQUIRED

Next action: <one exact step>
```

Shared vocabulary is in `references/operating-contract.md`.
