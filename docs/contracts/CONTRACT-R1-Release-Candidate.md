# Contract R1: immutable release candidates

R1 defines the handoff between a verified local Hub build and a deployment
artifact. A release candidate is a retained, relocatable copy of one exact
Contract C build. Export reads the candidate only; it does not fetch upstream
sources, inspect a moving Hub, or rebuild content.

## Candidate envelope

A governed candidate has object type `ega.release-candidate` and schema
version `2`. Its payload contains:

- `hub_id` and `release_digest`, binding the candidate to one HubRelease;
- `sqlite_artifact_digest`, `snapshot_rows`, and the release FTS table name;
- the exact runtime file layout: `hub-release.json`, `release-package.json`,
  `registry.sqlite`, `cache/sha256`, `alias-map.json`,
  `search-index-input.json`, and `token-artifact.json`;
- `publication`, which contains `preflight_digest`, `approval_set_digest`,
  `previous_release_digest`, `release_diff_digest`, and the fixed
  `publication_policy_revision` value `R1-approval-v2`.

The candidate directory also contains the complete `publication-preflight.json`
and `release-diff.json` sidecars. The candidate binds both sidecars by digest.
The writer verifies the complete temporary directory before it exposes the
destination directory.

The candidate verifier checks the envelope, HubRelease and package bindings,
semantic artifact digests, SQLite integrity, the release FTS table and row
count, the release projection, and every content-addressed blob referenced by
the release. A candidate with a corrupt runtime file cannot be exported.

SQLite bytes are deployment artifacts, not semantic release identity. Two
candidates may therefore have different SQLite artifact digests while carrying
the same HubRelease digest; both candidates must independently verify.

The publication snapshot records the exact Skill ID and version map, the
approval records used for the snapshot, the approval-set digest, and any
blockers. A governed candidate requires `READY`, no blockers, and one matching
`APPROVED` review for every released Skill ID. The approval-set digest proves
the snapshot contents. It is not a reviewer signature.

Schema version `1` is the legacy artifact-only format. The verifier can read it
for retained serving and migration checks. `hub release export` rejects it by
default. Use `hub release export --legacy` only for the explicit legacy path.
The legacy path does not create approval evidence or turn an old artifact into
a governed candidate.

## Release diff

`ega.release-diff` schema version `1` compares two verified releases from the
same Hub. It reports added and removed Skill IDs, exact version changes, and
changes to alias, search, token, or adopted-source projections. It has no
transport paths or SQLite bytes, so the result is deterministic for semantic
release inputs.

## CLI and publication boundary

`ega-skills hub release preview` requires an explicit Hub, base release, and
fresh output directory. It runs publication preflight before and after the
release build. If the committed preflight digest changes, the preview fails as
stale. A blocked preflight returns status `1` and writes no candidate. A ready
preview writes the verified governed candidate plus its two sidecars. It does
not publish or deploy.

`ega-skills hub release export` requires an explicit governed candidate and
fresh output directory. It verifies the source and destination candidates and
copies the exact files without reading the Hub. It never adds a `published`
flag. Production publication remains a separate, explicit deployment
operation. Use `--legacy` only when exporting a retained schema version `1`
candidate under the legacy policy.

The hosted artifact builder now requires one explicit input mode:
`--hub`, `--candidate`, or the reviewed five-skill `--fixture` mode. The
fixture is reproducibility evidence, not an implicit catalog default.

## Acceptance coverage

- RL-01: semantic release equality with different SQLite bytes;
- RL-02: corrupt candidate artifacts rejected before export;
- RL-03: retained candidate export succeeds after source removal;
- RL-08: governed approval sidecars bind to the candidate and tamper cases
  fail closed;
- actual CLI coverage for blocked preview and candidate export.
