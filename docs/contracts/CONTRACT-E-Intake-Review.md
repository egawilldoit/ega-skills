# Contract E1/E2: intake review and publication preflight

This contract adds the manual review boundary to the intake workflow. It does
not change the frozen importer, preparation, adoption, release, or MCP
contracts.

## Review records

Legacy review records are append-only JSON artifact envelopes under:

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
Records form a contiguous per-Skill revision chain. Existing E1 records remain
readable. New decisions are committed as one immutable batch envelope under
`intake/review-batches/b-<request-id>.json`; the per-Skill records exposed by
the reader are committed projections whose identity includes the batch digest,
not independently published files. A batch has exactly these payload fields:

```json
{
  "candidate_digest": "sha256:<64 lowercase hex>",
  "decisions": [{
    "skill_id": "namespace/name",
    "version_hash": "sha256:<64 lowercase hex>",
    "expected_revision": 0,
    "revision": 1,
    "previous_review_digest": null,
    "decision": "APPROVED|REJECTED"
  }],
  "actor": "local",
  "reason": "human-readable reason",
  "request_id": "sha256:<64 lowercase hex>"
}
```

The complete batch is written to a temporary file and exposed by one atomic
rename while holding the Hub mutation lock. `--expected-revision N` is a
shorthand for every selected Skill ID; mixed histories use
`--expected-revisions <json-file>` with exactly the candidate Skill IDs as
keys. The deterministic request ID makes an exact retry converge after a lost
response; a different request with an old revision fails stale/conflicting.

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
