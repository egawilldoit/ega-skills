# Contract E1/E2: intake review and publication preflight

This contract adds the manual review boundary to the intake workflow. It does
not change the frozen importer, preparation, adoption, release, or MCP
contracts.

## Review records

Review records are append-only JSON artifact envelopes under:

```text
intake/approvals/<namespace>/<name>/r000001.json
```

Each record has `object_type: ega.intake-review` and `schema_version: 1`. Its
payload has exactly these fields:

```json
{
  "candidate_digest": "sha256:<64 lowercase hex>",
  "skill_id": "namespace/name",
  "version_hash": "sha256:<64 lowercase hex>",
  "decision": "APPROVED|REJECTED",
  "revision": 1,
  "previous_review_digest": "sha256:<64 lowercase hex>|null",
  "actor": "local",
  "reason": "human-readable reason"
}
```

The envelope digest is the record identity. The candidate digest and version
hash are both required; an approval never means “approve the current bytes.”
Records form a contiguous per-Skill revision chain. Writes take the Hub
mutation lock and require the caller's expected revision. A competing write
therefore fails stale/conflicting instead of overwriting history.

`actor` and `reason` are audit metadata. They are not authentication or
authorization claims, and text inside a candidate, upstream source, or AI
suggestion cannot create an approval.

## Publication preflight

`hub release preflight` builds a fresh isolated Hub catalog and compares every
catalog entry with the latest review record for that exact Skill ID and
version hash. It emits an `ega.publication-preflight` envelope with status
`READY` or `BLOCKED`, exact `skill_versions`, the review projection, and
structured blockers. Unapproved content is never silently omitted. A changed
canonical version leaves the previous approval stale until a new exact review
revision is recorded.

The preflight is read-only and is not publication. A successful build or
preflight must not be interpreted as a production deployment.
