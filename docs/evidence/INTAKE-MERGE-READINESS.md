# Intake merge readiness

> HISTORICAL RECORD (2026-09-20). Superseded by the 2.0 release window in
> `docs/evidence/RELEASE-2.0-FINAL.md`. The PRs referenced below have since
> merged into `release/2.0`; statements here are preserved as the state at the
> time of writing and are not current release status.

Status: correction implementation complete; final review branches are open and required CI is green.

This record distinguishes local tests, CI evidence, upstream validation, and
remote-client validation. It does not authorize a production merge or deploy.

## Baseline

- Production baseline: `9622a6ac4d06f00da525046e5ebb29428dfb91ff` on `release/2.0`.
- Intake stack tip: `40007ed4c14dcd9cf6c1a6c348818321993d274d` (#110).
- OAuth branch / PR #99 corrected head: `7500c80ec31fc285e041608aa6ae6269dee49e1d` (original baseline head `e5cdadf8986335d84df7aebd3c4fef98a2494d70`).
- Correction branch: `fix/intake-merge-readiness`.
- Local integration head before evidence-only updates: `121c9a7c789ef4ea4885d76827796d2f5d95288e`.
- Final integration PR [#112](https://github.com/egawilldoit/ega-skills/pull/112) is based on `release/2.0`; commits after code-equivalent tested head `de215aff16e2ccd152d326f9a73db0ec5db00be1` contain documentation-only evidence updates.
- Execution date: 2026-09-20 UTC.
- Exact operator deadline: not supplied; do not infer one from “before mid.”

## Wave status

| Wave | Outcome | Commit | Focused evidence |
|---|---|---|---|
| W0 | complete | `40007ed4c14dcd9cf6c1a6c348818321993d274d` | baseline refresh and defect reproduction |
| W1 | complete | `5aa716091bc1c2075b5e89375379b72807cafc7a` | owner-safe locks and process-death recovery |
| W2 | complete | `761f356c73b127d19e42e3c88a4bbd7cca8c63d1` | atomic review batches |
| W3 | complete | `90fef3862003be3798761d938aceb8a8a9f81d0b` | approval before adoption |
| W4 | complete | `90fef3862003be3798761d938aceb8a8a9f81d0b` | verified derivative adoption |
| W5 | complete | `453f1e9dcd6a6bb6f47ba41814a99b2c5c405ff9` | approval-bound publication |
| W6 | complete | `d6033ae21ca263babfae88f66e20cdc041f3b3b1` | retained promotion race safety and crash recovery |
| W7 | complete | `7500c80ec31fc285e041608aa6ae6269dee49e1d` | strict/redacted OAuth harness, locally merged into the integration branch |
| W8 | complete | `30ca8a99934c6d710a2d2d59a65b67b6ca862c8e` | connected CLI/MCP E2E |
| W9 | complete; awaiting review/approval | `de215aff16e2ccd152d326f9a73db0ec5db00be1` | code-equivalent head passes final PR #112 Linux/Windows/Contract F CI; later commits are documentation-only |

## Acceptance evidence

To be filled as each wave completes. `BLOCKED` and `SKIPPED` are not passes.

W5 local evidence:

- `corepack pnpm build` passed at `453f1e9dcd6a6bb6f47ba41814a99b2c5c405ff9`.
- The focused release, publication, adoption, derivative, CLI, and retained-runtime suite passed 42/42.
- The governed candidate matrix rejected missing and altered receipts, blocked status, wrong approval-set digest, mismatched skill/version data, and swapped diffs.
- The real CLI preview rejected a review change between its initial and final preflight snapshots. The old exported candidate remained verifiable.
- Linux CI, Windows CI, real upstream validation, and remote-client validation remain unrecorded.

W6 local evidence:

- `corepack pnpm build` passed at `d6033ae21ca263babfae88f66e20cdc041f3b3b1`.
- `node --test tests/mcp/retained-serving.test.mjs` passed 8/8.
- The retained tests covered default governed-candidate rejection, explicit legacy compatibility, owner-token replacement protection, concurrent promotion versus rollback with one revision winner, killed writes before and after the durable pointer, and same-deployment lost-response retry without a second transition.

W8 local evidence:

- `node --test tests/cli/intake-publication-e2e.test.mjs tests/cli/intake-derivative-publication-e2e.test.mjs` passed 2/2.
- The publication E2E now proves plan identities and provenance, rejects apply before approval without creating owned bytes, preserves the upstream checkout bytes, exports and validates the exact release, then deletes the source checkout before driving the real stdio MCP server through `search → resolve → inspect → get_content`.
- The same transport test rejects a control-plane file request with `E_CONTENT_FILE_UNKNOWN`.
- The derivative E2E proves explicit original input digest, owned target identity, provenance/license lineage, tamper rejection, source-byte preservation, coexistence of seed/alpha/beta, and preview/export validation.
- Retained release A/B promotion, default selection, pinned selection, rollback, stale-CAS rejection, and interrupted-write recovery remain covered by `tests/mcp/retained-serving.test.mjs`.

W7 local evidence:

- `node --check scripts/oauth/interop-check.mjs && node --test tests/oauth/interop-check.test.mjs` passed 9/9.
- The offline stub covered happy flow, changed subject, changed client, missing code, missing refresh token, setup failure, provider 500, and sentinel-secret redaction.
- The harness preserves Supabase `apikey` and authorization-details association, compares registered client and independently known subject claims, enforces exact rejection status/error, and emits no token/code/password/auth-header or response-body credentials.
- No live OAuth endpoint was exercised because `EGA_INTEROP_USER_TOKEN`, `EGA_INTEROP_API_KEY`, and `EGA_INTEROP_BASE_URL` are unset.

W9 local evidence:

- At integration head `121c9a7c789ef4ea4885d76827796d2f5d95288e`, `corepack pnpm build`, `corepack pnpm typecheck`, `corepack pnpm specs:check`, `corepack pnpm test:perf:registry`, Contracts A/B/C/G, `git diff --check`, and `corepack pnpm test` passed.
- Full suite result: 1,029 tests, 1,024 passed, 0 failed, 5 skipped. The five skips are the repository's opt-in Windows-path, real-client, and real-upstream-disabled cases; the pinned public upstream case was run separately below.
- `EGA_REAL_UPSTREAM=1 node --test tests/project/real-upstream-e2e.test.mjs` passed against pinned public Git sources: cursor/pstack commit `6ed0f7a9504f577d7529064103cecce9be7dfc5e`, Matt Pocock commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`, with lifecycle commits `5c89081d4bbeb3d039a42093653f90bb698d780e`, `6a34259e99bc5fed4f8fe5da61c273dad14edf67`, and `3cca18b368ae95cdbdebbff572ccafa662551015`.
- Final integration PR #112 CI passed at head `de215aff16e2ccd152d326f9a73db0ec5db00be1`: Contract F run [`35539331956`](https://github.com/egawilldoit/ega-skills/actions/runs/35539331956), Linux job [`106154019931`](https://github.com/egawilldoit/ega-skills/actions/runs/35539331956/job/106154019931), Windows job [`106154019876`](https://github.com/egawilldoit/ega-skills/actions/runs/35539331956/job/106154019876); hashing traversal run [`35539331986`](https://github.com/egawilldoit/ega-skills/actions/runs/35539331986) passed on Linux job [`106154019899`](https://github.com/egawilldoit/ega-skills/actions/runs/35539331986/job/106154019899) and Windows job [`106154019698`](https://github.com/egawilldoit/ega-skills/actions/runs/35539331986/job/106154019698). No production merge or deploy was performed.
