# Contract R1: immutable release candidates

R1 defines the handoff between a verified local Hub build and a deployment
artifact. A release candidate is a retained, relocatable copy of one exact
Contract C build. Export reads the candidate only; it does not fetch upstream
sources, inspect a moving Hub, or rebuild content.

## Candidate envelope

The envelope has object type `ega.release-candidate` and schema version `1`.
Its payload contains:

- `hub_id` and `release_digest`, binding the candidate to one HubRelease;
- `sqlite_artifact_digest`, `snapshot_rows`, and the release FTS table name;
- the exact runtime file layout: `hub-release.json`, `release-package.json`,
  `registry.sqlite`, `cache/sha256`, `alias-map.json`,
  `search-index-input.json`, and `token-artifact.json`.

The candidate verifier checks the envelope, HubRelease and package bindings,
semantic artifact digests, SQLite integrity, the release FTS table and row
count, the release projection, and every content-addressed blob referenced by
the release. A candidate with a corrupt runtime file cannot be exported.

SQLite bytes are deployment artifacts, not semantic release identity. Two
candidates may therefore have different SQLite artifact digests while carrying
the same HubRelease digest; both candidates must independently verify.

## Release diff

`ega.release-diff` schema version `1` compares two verified releases from the
same Hub. It reports added and removed Skill IDs, exact version changes, and
changes to alias, search, token, or adopted-source projections. It has no
transport paths or SQLite bytes, so the result is deterministic for semantic
release inputs.

## CLI and publication boundary

`ega-skills hub release preview` requires an explicit Hub, base release, and
fresh output directory. It runs publication preflight first. A blocked
preflight returns status `1` and writes no candidate. A ready preview writes
the verified candidate plus `release-diff.json` and
`publication-preflight.json`; it does not publish or deploy.

`ega-skills hub release export` requires an explicit candidate and fresh output
directory. It copies the exact verified candidate and retained review receipts
without reading the Hub. It never adds a `published` flag. Production
publication remains a separate, explicit deployment operation.

The hosted artifact builder now requires one explicit input mode:
`--hub`, `--candidate`, or the reviewed five-skill `--fixture` mode. The
fixture is reproducibility evidence, not an implicit catalog default.

## Acceptance coverage

- RL-01: semantic release equality with different SQLite bytes;
- RL-02: corrupt candidate artifacts rejected before export;
- RL-03: retained candidate export succeeds after source removal;
- actual CLI coverage for blocked preview and candidate export.
