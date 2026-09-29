# Bundled immutable HubRelease artifact (Vercel deployment)

This directory is the deployment-time home of the ONE immutable verified
HubRelease served by the Vercel Node runtime.

Set on Vercel:

```text
EGA_HOSTED_ARTIFACT_DIR=./artifact
```

## Provisioned release

- Catalog: `catalog-2026-09-29.1`
- Release digest: `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77`
- Hub id: `personal`
- Skills: 114 (mattpocock 25, anthropic 14, vercel 9, egawilldoit 66)
- Parent catalog: `catalog-2026-09-24.1` (48 skills, digest
  `sha256:55b9dba5e0274dc0640c742a8f2ceab2889c1ef312ca16d1b4f9387cb30f752f`)
- Built by the governed hub intake → quality → review → preview → export
  pipeline from pinned reviewed commits; see `PROVENANCE.md` for sources,
  repairs, routing metadata, and the reproduce/validate commands.

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
