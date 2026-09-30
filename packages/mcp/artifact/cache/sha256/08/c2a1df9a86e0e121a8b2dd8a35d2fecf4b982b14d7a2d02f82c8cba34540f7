---
name: certify-release
description: "Certify a release against three separate gates, CODE, RUNTIME, and PRODUCT, and report the highest gate actually reached as CODE_READY, RUNTIME_READY, PRODUCT_READY, or BLOCKED. Use before calling a build production-ready, after a deploy, or when a release claim spans implementation, the running environment, and the real end-user path. This is the whole-release gate; use certify-pr-head for freshness of PR evidence, trace-artifact-provenance for source-to-artifact lineage, and certify-production-target for target identity before mutation."
---

# Certify release

Certification proves a gate is actually reached, not that a checklist was filled in. Report the highest gate reached and stop there.

Three gates, cumulative and ordered. A later gate cannot pass while an earlier gate fails.

```text
CODE     implementation, tests, review, CI, static validation
RUNTIME  artifact, deployment, migration, health, real-environment smoke
PRODUCT  intended client, real device when required, real auth path, real user workflow
```

Do not call something production-ready because only CODE passed. The common false release claim is CODE evidence presented as PRODUCT evidence.

## Workflow

1. Fix the release identity: repository, base SHA, release SHA, artifact or version. If the release SHA or artifact is unknown, stop at `BLOCKED` with insufficient evidence.
2. State the authorized mutation level. Certification itself is read-only (`L0`). Deploying, migrating, or touching production in order to certify requires explicit authority; without it, report `AUTHORITY_REQUIRED` instead of acting.
3. Gate CODE. Confirm the implementation is present at the release SHA, tests passed at that SHA, review evidence names that SHA, CI checks are associated with that exact SHA and green, and static validation is clean.
4. Gate RUNTIME. Confirm a digest-pinned artifact exists, the deployment maps to that artifact, migrations applied, health checks pass, and a smoke test ran in the real environment.
5. Gate PRODUCT. Confirm the intended client, a real device when the product requires one, the real authentication path, and a real end-user workflow.
6. Report each gate with status, evidence level, what was checked, what failed, and the next action.

## Hard rules

- Never report a gate above the evidence actually reached. Name the evidence level (`E0` to `E6`) per gate.
- Evidence must attach to the exact release SHA or artifact. Successful evidence from an older commit is stale and does not count.
- A skipped gate is `NOT CHECKED`, never `PASS`.
- One failing gate does not lower a passed gate. Report passed gates honestly and name the first failing gate as the blocker.
- Certification is not authorization. See `references/operating-contract.md`.

## Verdicts

```text
CODE_READY     CODE passed; RUNTIME not reached
RUNTIME_READY  CODE and RUNTIME passed; PRODUCT not reached
PRODUCT_READY  all three gates passed
BLOCKED        an earlier gate failed, or identity, authority, or evidence is missing
```

## Output contract

```text
VERDICT: CODE_READY | RUNTIME_READY | PRODUCT_READY | BLOCKED
Release: <repository> <release SHA> <artifact or version>
Reached gate: CODE | RUNTIME | PRODUCT | none

CODE:    PASS | FAIL | NOT CHECKED   evidence=E<n>
RUNTIME: PASS | FAIL | NOT CHECKED   evidence=E<n>
PRODUCT: PASS | FAIL | NOT CHECKED   evidence=E<n>

Blockers:
- <gate>: <exact fact> (<blocker type>)

Next action: <one exact step>
```

Read `references/release-gates.md` for gate entry criteria and the evidence model. Shared vocabulary is in `references/operating-contract.md`.
