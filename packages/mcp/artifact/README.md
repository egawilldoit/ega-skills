# Bundled immutable HubRelease artifact (Vercel deployment)

This directory is the deployment-time home of the ONE immutable verified
HubRelease served by the Vercel Node runtime.

Set on Vercel:

```text
EGA_HOSTED_ARTIFACT_DIR=./artifact
```

## Provisioned release

- Release digest: `sha256:55b9dba5e0274dc0640c742a8f2ceab2889c1ef312ca16d1b4f9387cb30f752f`
- Hub id: `personal`
- Skills (48: mattpocock 25, anthropic 14, vercel 9 — real reviewed upstream only,
  no fixtures, no examples; see PROVENANCE.md for the full ID list and the
  catalog-2026-09-24.1 evidence files)
- Built by the governed hub intake → preview → export pipeline from pinned
  reviewed commits; see `PROVENANCE.md` for sources, repairs, routing
  metadata, and the reproduce/validate commands.

A valid artifact contains everything required by the current loader
(`loadHostedReleaseSnapshot`), including:

- `hub-release.json`
- `release-package.json`
- `registry.sqlite`
- required `cache/sha256/` blob content

Do NOT invent an artifact. Do NOT use a random test fixture as production
content. Do NOT regenerate an identity silently.

Validate a proposed artifact BEFORE deployment with the deterministic
checker (calls the existing release verification code, weakens nothing):

```sh
pnpm build
node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
```

The application reaches `/readyz = 200` only after the complete release
passes verification.

Note: `registry.sqlite*` and `cache/` stay git-ignored by default
(developer safety). The provisioned production files above were added
explicitly with `git add -f`; `.gitattributes` pins them binary so no
platform normalizes the bytes. Re-provisioning means rebuilding with the
script, re-validating (exit 0), and force-adding the new exact bytes —
never editing them in place.
