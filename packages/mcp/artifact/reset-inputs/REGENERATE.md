# Regenerating the empty-catalog candidate

All files in this directory are generation inputs only. They are neither a
second registry nor a publication system. `hub.yaml`, `sources.yaml`, and
`sources.lock.yaml` describe an empty Hub (`personal`, no owned skills, no
external sources). `empty-invocation-policy.json` is an `ega.invocation-policy`
envelope with empty `sources` and `bindings`, produced by
`@ega-skills/hashing.createEnvelope`.

The committed artifact in `packages/mcp/artifact/` is the output of the
commands below. Re-running them reproduces the same digests, provided the
base artifact used with `--against` is the 126-skill release
`sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`.

## Commands run

From the repository root, after `pnpm install --frozen-lockfile && pnpm build`:

```sh
WORK=$(mktemp -d)
cp -R packages/mcp/artifact/reset-inputs "$WORK/hub"
mv "$WORK/hub/empty-invocation-policy.json" "$WORK/empty-policy.json"

EGA_SKILLS_TRUSTED_PUBLISHED_RELEASE=sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266 \
  node packages/cli/bin/ega-skills.mjs hub release preview \
    --hub "$WORK/hub" \
    --against packages/mcp/artifact \
    --output-dir "$WORK/candidate" \
    --policy "$WORK/empty-policy.json"

node packages/cli/bin/ega-skills.mjs hub release export \
  --candidate "$WORK/candidate/candidate.json" \
  --out "$WORK/artifact"

node scripts/hosted/validate-artifact.mjs "$WORK/artifact"
```

Expected outputs:

- candidate `sha256:d701835e7f1046df4eee699eb5ce08d03efda09cd3905ffb16dff0be4baef30f`
- release `sha256:92dc7eec94a6dc4c5c61039fec929dd943398d1df618d1b7720a680e16a4fa3c`
- policy `sha256:8f84a13431dc108817bb32d654173cd4f3793051fd760d4da97fc4499b2eb80b`
- sqlite `sha256:e42b21b06704a86c4c242876d1a006504cb1089ccef8d0c82a13268801035d3a`
- `validate-artifact` prints `skills=0`

`--trusted-published-release` is deliberate: the publisher must supply the
independently verified active release identity. It is not inferred from the
`--against` artifact.

## Resolved integration steps

`catalog/presentation.yaml` has `favorites: []` and `groups: []`, and
`docs/generated/SKILL-CATALOG.md` was rendered with the repository's own
`renderCatalogMarkdown` using the empty model. `validatePresentation` accepts
that state only for a zero-skill release; a populated release with no groups,
a malformed group list, a group with no skills, or a reference to a skill that
is not in the release still fails closed. `verify-live.mjs` accepts a zero-skill
manifest and verifies the empty MCP surface without inventing content.

The renderer trims the zero-namespace line, so the generated line has no
trailing space and `git diff --check` stays clean. Never hand-edit the generated
document or an immutable artifact; regenerate with the repository scripts.
