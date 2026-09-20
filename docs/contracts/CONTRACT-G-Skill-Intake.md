# Contract G: Skill intake plan

Status: v1 local preview surface. This contract covers `ega-skills
import-plan`; it does not authorize import, adoption, release, or production
publication.

## Command

```text
ega-skills import-plan <folder> --namespace <namespace> --output <plan.json>
```

The command discovers skill roots, prepares each candidate with the canonical
V1 preparation and hashing pipeline, and writes one deterministic
`ega.import-plan` envelope. It reads an existing registry in read-only mode.
If the target registry does not exist, the plan records an explicit empty
target and the command does not create the registry home.

Exit status is `0` when the plan has no blocking diagnostics, `1` when the
plan was written but contains invalid or blocked candidates, `2` for command
usage or namespace errors, and `4` for source, target, or output I/O errors.
Progress and errors go to stderr; the successful summary goes to stdout.

## Identity and diagnostics

The envelope is:

```json
{
  "object_type": "ega.import-plan",
  "schema_version": 1,
  "payload": { "...": "..." },
  "digest": "sha256:<64 lowercase hex>"
}
```

The digest is the existing JCS/SHA-256 envelope identity. The payload has
exactly these fields:

- `intake_contract`: `G1`;
- `namespace`;
- `source`: local `snapshot_digest` plus `extraction_policy` `1`;
- sorted `selected_roots` relative to the requested folder;
- `policy_revision`: `intake-policy-v1`;
- `target`: `EMPTY` or `REGISTRY`, with a state digest;
- sorted `discovery_diagnostics` for unreadable paths and the frozen depth limit;
- sorted `candidates`;
- `summary` counts.

Each candidate reports its relative root, proposed canonical ID, validation
status, change classification (`NEW`, `UNCHANGED`, `UPDATE`, `REACTIVATE`, or
`UNKNOWN`), canonical version hash when valid, aliases, file/size/token
measurements, and sorted structured diagnostics. Diagnostics distinguish
validation errors, duplicate IDs, alias conflicts, and warnings such as an
oversized authored L1 being classified as `MISSING` while L2 remains valid.

The source snapshot hashes raw bytes and therefore detects newline or other
source drift. Candidate version hashes use canonical bytes and therefore
preserve the existing SkillVersion identity rules. Absolute source paths,
timestamps, and host-specific registry paths are not included in the plan
identity.

`target.state_digest` includes the current ID-to-version map, all historical
version identities, alias ownership, target mode, and this policy revision.
No candidate is selected as an alias conflict winner. Invalid candidates have
no predicted version hash.

## Validation

The executable validator is:

```text
pnpm build
node scripts/contracts/validate-contract-g.mjs <plan.json>
```

It rejects malformed envelopes, digest mismatches, unknown fields, invalid
enum/value combinations, and inconsistent plan structure.

This contract intentionally does not define ZIP input, remote clients,
large-scale ingestion, operator UI, apply/recovery, approvals, releases, or
production publication. Those later stages must bind their artifacts to this
exact plan and source/target identities.
