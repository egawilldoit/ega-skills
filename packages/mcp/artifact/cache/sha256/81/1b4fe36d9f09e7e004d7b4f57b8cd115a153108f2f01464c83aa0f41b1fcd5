---
name: certify-database-rollout
description: "Certify a database migration across its real lifecycle: target, lineage, ordering, fresh-database behavior, upgrade path, schema, constraints, RLS and security, cross-user denial, service-role behavior, production application, and post-migration runtime. Use before or after shipping a migration, or when someone claims a migration is deployed. Distinguishes a migration file that exists from a migration that is successfully deployed."
---

# Certify database rollout

A migration file existing in the repository proves nothing about the database.
Certification covers the whole lifecycle: the file, the ordering, both database
paths, the security behavior, and the applied result in production.

## Lifecycle checks

Check each stage and record the evidence level reached.

| Stage | What to prove |
| --- | --- |
| Target | the exact database and environment, via `certify-production-target` |
| Lineage | the migration descends from the deployed lineage, no fork or gap |
| Ordering | it runs after its dependencies and before its dependents |
| Fresh database | a new database built from all migrations reaches the target schema |
| Upgrade path | an existing database at the prior revision upgrades cleanly |
| Schema | tables, columns, types, and indexes match the intent |
| Constraints | keys, uniqueness, not-null, and checks behave as intended |
| RLS and security | row-level security and grants are present and correct |
| Cross-user denial | a second user cannot read or write another user's rows |
| Service-role behavior | the privileged role has exactly the intended bypass |
| Production application | the migration is recorded as applied in the target |
| Post-migration runtime | the running application works against the new schema |

Fresh and upgrade are different paths. Passing one does not prove the other.
Test both.

## Workflow

1. Certify the target with `certify-production-target`. Do not continue if it
   returns `AMBIGUOUS_TARGET` or `WRONG_TARGET`.
2. Read the migration and its full lineage. Confirm ordering against the actual
   applied history, not the filenames alone.
3. Build a fresh database from all migrations and record the resulting schema.
4. Build a database at the prior revision, apply the migration, and record the
   upgrade result.
5. Inspect schema, constraints, and security objects against the intent.
6. Attempt a cross-user denial: as a non-privileged user, try to read and write
   another user's rows. The attempt must be denied.
7. Confirm the service-role path separately, including where it should and
   should not bypass security.
8. Confirm the migration is applied in the target environment, then exercise the
   running application against the new schema.
9. Report each stage with status and evidence level.

## Hard rules

- "Migration file exists" is not "migration is deployed". Verify the applied
  record and the resulting schema in the target.
- A passing fresh build does not prove the upgrade path, and the reverse.
- A passing happy path does not prove denial. Attempt the denied operation.
- Security checks must run as a non-privileged identity. A check run as an owner
  or service role proves nothing about user isolation.
- Applying a migration to production is a mutation (`L6`) and needs explicit
  authority. Certification without that authority is read-only and reports
  `AUTHORITY_REQUIRED` for the application step.
- Never edit an already-applied migration. Use a new migration.

## Verdicts

```text
ROLLOUT_CERTIFIED  all applicable stages pass at required evidence
ROLLOUT_PARTIAL    some stages pass, others not checked or incomplete
ROLLOUT_FAILED     a stage failed
BLOCKED            target, authority, or evidence is missing
```

## Output contract

```text
VERDICT: ROLLOUT_CERTIFIED | ROLLOUT_PARTIAL | ROLLOUT_FAILED | BLOCKED
Migration: <identifier or file>
Target: <database> <environment> (target verdict)
Lineage: <prior revision> -> <migration>

Stages:
- target:                PASS | FAIL | NOT CHECKED   evidence=E<n>
- lineage:               PASS | FAIL | NOT CHECKED   evidence=E<n>
- ordering:              PASS | FAIL | NOT CHECKED   evidence=E<n>
- fresh database:        PASS | FAIL | NOT CHECKED   evidence=E<n>
- upgrade path:          PASS | FAIL | NOT CHECKED   evidence=E<n>
- schema:                PASS | FAIL | NOT CHECKED   evidence=E<n>
- constraints:           PASS | FAIL | NOT CHECKED   evidence=E<n>
- RLS/security:          PASS | FAIL | NOT CHECKED   evidence=E<n>
- cross-user denial:     PASS | FAIL | NOT CHECKED   evidence=E<n>
- service-role:          PASS | FAIL | NOT CHECKED   evidence=E<n>
- production application: PASS | FAIL | NOT CHECKED  evidence=E<n>
- post-migration runtime: PASS | FAIL | NOT CHECKED  evidence=E<n>

Blockers:
- <stage>: <exact fact> (<blocker type>)

Next action: <one exact step>
```

Shared vocabulary is in `references/operating-contract.md`.
