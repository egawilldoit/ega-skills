# Contract R2: retained release serving and promotion

R2 defines the bounded retained-release adapter between immutable R1
candidates and the read-only hosted MCP handler. It keeps the existing four
MCP tools and their read-only behavior; it only changes how a verified release
snapshot is selected.

## Trusted manifest

The retained manifest is an `ega.retained-release-manifest` envelope, schema
version `1`. Its payload contains:

- `hub_id`, `publication_revision`, and `deployment_id`;
- one exact `default_release_digest`;
- a sorted retained set of entries containing `release_digest`,
  `candidate_digest`, a POSIX-relative `artifact_path`, and the raw
  `release_package_digest`.

Every entry must be below the manifest directory and must not be a symlink.
The loader verifies the R1 candidate envelope, semantic HubRelease, release
package, SQLite integrity and projection, FTS row count, and every referenced
content-addressed blob before exposing the snapshot. A package digest is
checked independently from the semantic release digest because SQLite bytes
are transport artifacts.

## Selection and authorization

Unpinned requests use the manifest's exact default digest. Requests with an
explicit digest use only that retained entry. An unknown or unavailable digest
returns an error; it never falls back to the default. Context resolution and
direct digest resolution use the same retained lookup. Hub association,
release denies, skill denies, source denies, and workspace authorization are
applied by the existing hosted handler on the selected snapshot.

The handler selects one snapshot per request and keeps that snapshot's
registry context for all tool phases. A manifest change cannot switch an
in-flight request to another release. New requests reload the trusted
manifest, so a successful rollback changes the default for subsequent
requests without closing a snapshot still in use.

## Promotion and rollback

Promotion accepts an exact `candidate.json` path, its expected candidate
digest, an expected manifest revision, and a deployment identity. The
candidate digest must match the verified R1 envelope; the candidate's Hub and
release package must match the retained entry. A directory lock plus the
existing stable-pointer CAS helper protects the durable manifest update.
An older job with a stale revision cannot replace a newer deployment.

Rollback selects a retained candidate by exact release digest and performs
the same monotonic revisioned promotion path. Manifest writes use the shared
durable atomic-write helper. The retained bundle is deployment-immutable;
there is no live cache eviction or unbounded lazy-loading path in R2.

## Runtime configuration

`EGA_HOSTED_RETAINED_MANIFEST` enables retained serving and may replace
`EGA_HOSTED_ARTIFACT_DIR`. The legacy single-artifact variable remains
supported. Both modes still require the existing hosted authentication,
origin, authorization, and release-verification configuration.

## Acceptance coverage

- RL-04: stale older promotion is rejected and rollback advances the CAS
  revision;
- RL-05: default, pinned, and unknown-digest requests remain isolated;
- RL-06: retained release denial is enforced for explicit pins;
- RL-07: an in-flight request keeps one snapshot while the default changes;
- candidate digest, package digest, path confinement, and complete artifact
  verification are covered by the retained-serving tests.
