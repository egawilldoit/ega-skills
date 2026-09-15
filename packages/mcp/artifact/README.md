# Bundled immutable HubRelease artifact (Vercel deployment)

This directory is the deployment-time home of the ONE immutable verified
HubRelease served by the Vercel Node runtime.

Set on Vercel:

```text
EGA_HOSTED_ARTIFACT_DIR=./artifact
```

## Provisioned release

- Release digest: `sha256:70a37c28e767230e04e45e34a33689113870394cda88f017f2aac322aaeb3f66`
- Hub id: `personal`
- Skills (5, real reviewed upstream only — no fixtures, no examples):
  `cursor/architect`, `cursor/setup-pstack`, `mattpocock/code-review`,
  `mattpocock/grilling`, `mattpocock/tdd`
- Built by `scripts/hosted/build-deployment-artifact.mjs` from pinned
  reviewed commits; see `PROVENANCE.md` for sources, digests, and the
  reproduce/validate commands.

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
