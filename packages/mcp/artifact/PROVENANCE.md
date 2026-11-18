# Empty-catalog candidate provenance

Generated locally with the repository's supported generators. No upstream
source was fetched, no skill was imported, and no existing immutable release
identity was changed.

- Inputs: `packages/mcp/artifact/reset-inputs/` (empty Hub YAML and the empty
  invocation-policy envelope, built with `@ega-skills/hashing.createEnvelope`).
- Build: `ega-skills hub release preview` with `--policy`, then
  `ega-skills hub release export`.
- Release digest: `sha256:92dc7eec94a6dc4c5c61039fec929dd943398d1df618d1b7720a680e16a4fa3c`
- Candidate digest: `sha256:d701835e7f1046df4eee699eb5ce08d03efda09cd3905ffb16dff0be4baef30f`
- Hub id: `personal`
- Skills: 0

The immediately previous release identity
`sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`
is preserved verbatim as `previous-hub-release.json`. The earlier 117-skill
release `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`
and all superseded bytes remain in Git history at
`f76f3a674069fde70e082ff73130b71d33a63c0d`.

Full reproduction steps and integration notes: `reset-inputs/REGENERATE.md`.
