# Prepared EMPTY-catalog release candidate — not published, not production accepted

Hub `personal`; **zero active skills**. This candidate was generated locally
from the committed empty Hub inputs in `reset-inputs/`. No skill source was
re-imported and no external skill was added.

- Semantic release: `sha256:92dc7eec94a6dc4c5c61039fec929dd943398d1df618d1b7720a680e16a4fa3c`
- Candidate: `sha256:d701835e7f1046df4eee699eb5ce08d03efda09cd3905ffb16dff0be4baef30f`
- Policy (empty): `sha256:8f84a13431dc108817bb32d654173cd4f3793051fd760d4da97fc4499b2eb80b`
- SQLite: `sha256:e42b21b06704a86c4c242876d1a006504cb1089ccef8d0c82a13268801035d3a`
- Preflight (READY, zero reviews): `sha256:0b6e3674ae3bd513d7bb42c495466dada7a324b85d577b429a5d9065ff8841d8`
- Release diff: `sha256:c868a17702af58313290ecc2bed0fd6a6465d59a7c66d00c5826081cb020bb8a`

`release-diff.json` records all 126 previously active skill ids as removed and
no additions. `search-index-input.json` has zero rows, `token-artifact.json`
has zero counts, `alias-map.json` has zero aliases, and there are no
content-addressed blobs under `cache/sha256`.

## Rollback identities preserved

- Immediate previous release, byte-for-byte in `previous-hub-release.json`:
  `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`
  (126 skills; its digest and SQLite digest are also bound in `candidate.json`
  and `release-diff.json`).
- Prior retained release:
  `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`
  (117 skills).
- All superseded artifact bytes, including the 858 removed cache blobs and the
  old SQLite snapshot, remain available in Git at base commit
  `f76f3a674069fde70e082ff73130b71d33a63c0d`. No history was rewritten.

## Verification status

The physical artifact verifies with the repository's own verifier:

```
node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
```

It reports `skills=0` and a valid digest. This is an UNPUBLISHED candidate,
not a production release. The CLI presentation validator now accepts an empty
`groups` sequence for an empty release, and the generated catalog markdown has
been regenerated accordingly; see `reset-inputs/REGENERATE.md` for the exact
regeneration inputs.

`discovery-report.json` was removed from this active artifact: it was pinned to
the superseded 126-skill release and a stale digest. The historical report is
unchanged in Git at the base commit. The console answers a controlled
"not evaluated" state for releases without a pinned report and never
fabricates evaluation results.

`registry.sqlite` is a generated immutable binary produced by the supported
build. Never hand-edit it or any envelope digest.
