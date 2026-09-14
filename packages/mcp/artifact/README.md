# Bundled immutable HubRelease artifact (Vercel deployment)

This directory is the deployment-time home of the ONE immutable verified
HubRelease served by the Vercel Node runtime.

Set on Vercel:

```text
EGA_HOSTED_ARTIFACT_DIR=./artifact
```

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

Note: `registry.sqlite*` and `cache/` are git-ignored by default (developer
safety). Provisioning the production artifact therefore requires an
explicit step (for example `git add -f` of the validated files) — see
`packages/mcp/VERCEL.md` and report artifact status in the deployment PR.
