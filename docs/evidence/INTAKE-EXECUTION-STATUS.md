# Intake-to-publication execution status

Last updated: 2026-09-19

This is the resume record for the EGA-Skills-Intake-E2E-Implementation-Plan.
It records implementation evidence, not deployment approval.

## Baseline

- Handoff recorded SHA: `9622a6ac4d06f00da525046e5ebb29428dfb91ff`.
- Baseline branch: `release/2.0`; baseline SHA matched the handoff SHA.
- Existing hygiene/OAuth work: PR [#99](https://github.com/egawilldoit/ega-skills/pull/99), head `e5cdadf8986335d84df7aebd3c4fef98a2494d70`; Linux, Windows, and Contract F checks were green when work began.
- Existing uncommitted user work was preserved: `scripts/oauth/interop-check.mjs`, `.vercel/`, and `packages/mcp/.gitignore`.
- No production configuration or deployment was changed.

## Slice status

| Slice | Branch / PR | Status | Evidence |
| --- | --- | --- | --- |
| P00 hygiene and contracts | Existing PR #99 | In progress outside this branch | Existing CI green; live OAuth remains unclaimed until staging credentials are authorized. |
| P01 shared preparation boundary | `codex/intake-p01` / [PR #100](https://github.com/egawilldoit/ega-skills/pull/100) | Implemented; required CI green | Final HEAD `8effa85`; Linux [`35469194843`](https://github.com/egawilldoit/ega-skills/actions/runs/35469194843/job/105966936552), Windows [`35469194843`](https://github.com/egawilldoit/ega-skills/actions/runs/35469194843/job/105966936495), and Contract F [`35469194843`](https://github.com/egawilldoit/ega-skills/actions/runs/35469194843/job/105966936425) passed. |
| P02 import planning CLI | Not started | Unblocked after P01 required CI | — |
| P03–P12 | Not started | Dependency-ordered | — |

## P01 implementation

`packages/registry/src/preparation.ts` now separates pure source preparation from
registry persistence. Preparation performs safe traversal, canonical content
normalization, schema/routing validation, token classification, and manifest
identity derivation without creating registry or cache state. Commit validates
the prepared identity, finalizes blobs, and performs the existing per-skill
transaction. The importer delegates to this boundary without changing its
summary or historical-version behavior.

Acceptance evidence currently covered:

- zero-mutation preparation and explicit commit persistence;
- A/B/A historical identity reuse without duplicate versions;
- oversized authored L1 demotion while valid L2 remains importable;
- mutation of prepared canonical bytes rejected before persistence;
- existing importer, alias, source-observation, token, lifecycle, CLI, and
  read-only registry behavior retained.

Required P01 gates passed locally: `pnpm build`, `pnpm typecheck`,
`pnpm specs:check`, `pnpm test:perf:registry`, `pnpm test`, targeted
preparation tests, and `git diff --check`. The first Windows run exposed a
fixture-teardown file-lock issue; commit `8effa85` closes the registry before
removing its temporary directory, and the fresh Linux/Windows run passed.

## Required resume protocol

1. Verify the current branch and worktree before editing; preserve the three
   unrelated user changes listed above.
2. Run the P01 targeted tests and repository gates before opening its PR.
3. Do not start P02 until P01 has a green required CI result.
4. Add exact commit SHA, PR URL, CI URLs, and any blocked/live evidence here
   after each slice.
5. Never merge or deploy without explicit user approval.
