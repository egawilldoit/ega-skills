# Bundled immutable HubRelease artifact (Vercel deployment)

This directory is the deployment-time home of the ONE immutable verified
HubRelease served by the Vercel Node runtime.

Set on Vercel:

```text
EGA_HOSTED_ARTIFACT_DIR=./artifact
```

## Prepared release candidate

- Release digest: `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`
- Hub: `personal`; 117 skills (mattpocock 27, anthropic 14, vercel 9, egawilldoit 67).
- Source: `egawilldoit/skills@8f264fc5fcb5691694c3653287f4d9370c5b025c`.
- Delta: 112 unchanged, four metadata-only updates, Ship One Outcome added, zero removed.
- Parent catalog: `catalog-2026-10-06.1`, digest
  `sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3`.
- Software remains EGA Skills **2.0.1**. See `PROVENANCE.md` and the
  `docs/evidence/catalog/ship-one-outcome/` receipts.
- Local preparation is approved. PR merge and all production publication actions
  require separate authorization. These files do not establish hosted availability.

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
