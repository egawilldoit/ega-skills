# Deployment artifact provenance

Built with the existing Contract C build (`buildHubRelease`); no fixtures,
no examples, no invented content.

Built: 2026-09-14T19:01:57.790Z
Release digest: sha256:70a37c28e767230e04e45e34a33689113870394cda88f017f2aac322aaeb3f66
Hub id: personal
Skills: cursor/architect, cursor/setup-pstack, mattpocock/code-review, mattpocock/grilling, mattpocock/tdd

## Sources (pinned reviewed commits)

- cursor-pstack (cursor): https://github.com/cursor/plugins@2b8ae2ee306f823d54879d3da7f8496b73c31d5d
  roots: pstack/skills/architect, pstack/skills/setup-pstack
  tree: sha256:380c3c138f994c93a2cdc107471277985a0bf9e2854d252f82ad2a2be1ccf7b5
  snapshot: sha256:1c196843be90b605daa100c743790cd8c9ffa87cff88eb31398e24cb558078b1
- mattpocock (mattpocock): https://github.com/mattpocock/skills@3cca18b368ae95cdbdebbff572ccafa662551015
  roots: skills/engineering/code-review, skills/engineering/tdd, skills/productivity/grilling
  tree: sha256:2f8d8f27d54c14002c4a58397fb358f3fe244a48a72fda983ab817d3dd4a2ba8
  snapshot: sha256:33b3f931ef8960b28f7efa3732cc593620df039a8433e81638e78c55c8996971

Evidence: docs/evidence/1.1-REAL-UPSTREAM-E2E-2026-09-08.md
Reproduce: pnpm build && node scripts/hosted/build-deployment-artifact.mjs
Validate: node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
