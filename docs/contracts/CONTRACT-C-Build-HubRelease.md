# Contract C — Complete Build & HubRelease (FROZEN v1)

**Status:** FROZEN
**Contract version:** 1
**Milestone gate:** must freeze (with Contracts A and B) before any 1.1 implementation (§7 of the Final Post-V1 Release Specification).
**Linear:** EGA-622
**Normative inputs:** Final Post-V1 spec §2 (canonical envelope), §3.22–§3.33; Contracts A v1 and B v1; V1 SPEC-002 (JCS/SHA-256), SPEC-003 (FTS5), TEST-002 (`ega-o200k-v1`).

This contract freezes the complete Hub build and the immutable HubRelease it
emits. It defines no hosted behavior (Contracts D–F) and no new MCP tools.

## §1 Complete-build semantics (mandatory)

`hub build` MUST NOT reuse a developer's existing registry. Every build starts
from a FRESH EMPTY isolated registry plus a FRESH EMPTY release-specific
search index, then:

```text
1.  Parse Hub contracts (Contract A: hub/sources/lock).
2.  Determine the complete expected catalog.
3.  Validate all owned content (V1 validate surface).
4.  Verify all external provenance (Contract A §6 digests).
5.  Verify vendored tree digests.
6.  Discover expected skills.
7.  Reject duplicate canonical IDs.
8.  Derive release alias ownership (§4).
9.  Reject alias conflicts.
10. Import into the fresh registry.
11. Require ZERO import failures (partial success is failure: no release).
12. Verify the resulting catalog exactly equals the expected catalog.
13. Verify token counts (estimator ega-o200k-v1).
14. Build the release-specific FTS corpus (§5).
15. Verify SearchIndexInput identity.
16. Emit the HubRelease (§7).
17. Only then may publication begin (§9).
```

The build attests `fresh_registry: true`, `import_failures: 0`,
`expected_catalog_match: true` inside the HubRelease; any other values
invalidate the release (`E_BUILD_ATTESTATION`).

## §2 No retained history as semantic input

Historical SkillVersions may remain in object storage, but they MUST NOT
participate in alias calculation, FTS statistics, current catalog, routing
candidates, or token metadata unless explicitly selected by the release.

## §3 Removed skills

If R1 contains skill X and R2 does not, R1 remains intact, retained blobs stay
available, and R2 simply excludes X. Removal is per-release exclusion, never
mutation of history.

## §4 Release-scoped aliases

The alias map is derived EXCLUSIVELY from the SkillVersions selected by that
release. No alias survives implicitly from historical registry state:

```text
R1: foo → ega/a
R2: selected SkillVersions no longer claim foo
Result: R2 has no foo alias
```

Every alias value MUST resolve to a selected SkillVersion of the same release
(`E_ALIAS_SCOPE` otherwise). Alias keys are stored sorted.

## §5 Release-specific search index

Each HubRelease owns its EXACT FTS corpus. Only rows belonging to that release
participate in BM25 statistics. The forbidden shape is one shared table with a
visibility filter; the required shape is one corpus per release:

```text
R1 → FTS corpus R1
R2 → FTS corpus R2
```

Publishing R2 MUST NOT change search ordering for R1. The executable proof
(builds both corpora in one FTS5 database as SEPARATE tables, queries R1
before and after R2 exists, requires byte-identical order) is part of
acceptance (§11).

## §6 SearchIndexInput and token artifacts

- `SearchIndexInput` records the exact normalized rows used to build FTS, one
  per selected SkillVersion (`skill_id`, `version_hash`, `name`,
  `description`, `domains`, `platforms`, `frameworks`, `triggers`, `aliases`),
  sorted by `skill_id`. Its digest is bound by the HubRelease.
- The token-count artifact records `ega-o200k-v1` counts for EXACTLY the
  release catalog (no ambient history). Compatibility metadata stays advisory
  and MUST NOT affect routing in 1.1.

## §7 HubRelease semantic payload

Envelope `ega.hub-release`, `schema_version: 1`, digest = JCS/SHA-256 over
`{object_type, schema_version, payload}` (post-V1 spec §2.2). Payload binds at
minimum:

```text
hub_id
skill ID → SkillVersion map (exactly the release catalog)
alias_map_digest
search_index_input_digest
token_artifact_digest
adopted_sources (source_id + Contract A vectors each)
contracts {schema, hashing, router, search, token_estimator,
           importer_build, hub_contract, update_contract, build_contract}
build attestation (§1)
```

It EXCLUDES: build timestamp, CI run ID, developer path, publication URL,
OAuth configuration, deployment environment, SQLite raw-byte hash, and any
machine absolute path.

Frozen vector (validator-recomputed over
`scripts/contracts/examples/contract-c/`):

```text
hub-release.json  sha256:d3838fdcc7c16a5460f2ff381b3ac36df35a62733b053765fbb813074450e649
```

## §8 Semantic identity versus artifact identity

`hub build` may additionally produce `registry.sqlite` with raw digest
`sqlite_artifact_digest`, recorded in `release-package.json` OUTSIDE the
semantic envelope. The SQLite byte hash does NOT define the release: two valid
snapshot builds may differ in raw bytes while representing the same semantic
release. Flipping the artifact digest MUST NOT change validation of the
semantic release (proven by acceptance test).

## §9 Publication

Order:

```text
build complete release
→ upload immutable SkillVersion objects
→ upload release-specific index/snapshot
→ verify every artifact
→ publish immutable HubRelease
→ CAS-update stable pointer LAST (stable.json: stable_release_digest +
   positive-integer cas_version; older runs cannot overwrite newer)
```

Review CI (untrusted upstream) MUST NOT possess production publication
credentials; only reviewed-main release publication owns them. Rollback =
repoint stable to a retained prior HubRelease (retention keeps every release
referenced by a lock, context, or audit policy).

## §10 Errors (fail-closed)

| Code | Meaning |
| ---- | ------- |
| `E_RELEASE_SCHEMA` | envelope/payload shape violation, unknown field, null, non-semantic value |
| `E_RELEASE_DIGEST` | digest or semantic-binding recomputation mismatch |
| `E_ALIAS_SCOPE` | alias targets unselected skill / unsorted / historical inheritance |
| `E_SEARCH_INPUT` | corpus row shape violation, duplicates, unsorted, R2-superset invariant |
| `E_SEARCH_ISOLATION` | R1 order changed after R2 publish / row-count leak |
| `E_TOKEN_ARTIFACT` | wrong estimator, version mismatch, uncovered/extra catalog |
| `E_PACKAGE_BINDING` | hub_release_digest mismatch, bad artifact digest, row-count mismatch |
| `E_STABLE` | stable pointer digest/ordering violation |
| `E_BUILD_ATTESTATION` | non-fresh build, import failures, catalog mismatch |

## §11 Acceptance (executable)

1. `node scripts/contracts/validate-contract-c.mjs` exits 0 and recomputes
   the frozen HubRelease digest in §7 plus all three semantic bindings.
2. The validator's embedded FTS5 proof passes: R1 order byte-identical before
   and after R2 exists in the same database.
3. `node --test tests/contracts/contract-c.test.mjs` passes: valid release;
   tampered digest fails; alias leak fails; estimator mismatch fails; stable
   mismatch fails; sqlite-digest flip still passes (separation proof);
   corpus pollution fails; unknown field fails; null fails.
4. `pnpm specs:check` still passes (V1 frozen set untouched).
5. `pnpm build` + `pnpm typecheck` pass; `git diff --check` clean.
6. Linux + Windows CI green.
