# Intake merge readiness

Status: executing correction waves from the merge-readiness plan.

This record distinguishes local tests, CI evidence, upstream validation, and
remote-client validation. It does not authorize a production merge or deploy.

## Baseline

- Production baseline: `9622a6ac4d06f00da525046e5ebb29428dfb91ff` on `release/2.0`.
- Intake stack tip: `40007ed4c14dcd9cf6c1a6c348818321993d274d` (#110).
- OAuth branch: `e5cdadf8986335d84df7aebd3c4fef98a2494d70` (#99).
- Correction branch: `fix/intake-merge-readiness`.
- Execution date: 2026-09-20 UTC.
- Exact operator deadline: not supplied; do not infer one from “before mid.”

## Wave status

| Wave | Outcome | Commit | Focused evidence |
|---|---|---|---|
| W0 | complete | `40007ed4c14dcd9cf6c1a6c348818321993d274d` | baseline refresh and defect reproduction |
| W1 | complete | `5aa7160b9a95f659f8d0da4ae7a7ce197df2da8a` | owner-safe locks and process-death recovery |
| W2 | complete | `761f356c1c88f52c50beff849e8fd9527568e6f` | atomic review batches |
| W3 | complete | `90fef38e1de976572a17a9b278c91f0763b776d7` | approval before adoption |
| W4 | complete | `90fef38e1de976572a17a9b278c91f0763b776d7` | verified derivative adoption |
| W5 | complete | `453f1e9dcd6a6bb6f47ba41814a99b2c5c405ff9` | approval-bound publication |
| W6 | pending | — | retained promotion race safety |
| W7 | pending | — | OAuth harness offline hardening |
| W8 | pending | — | connected CLI/MCP E2E |
| W9 | pending | — | combined-head CI and merge preparation |

## Acceptance evidence

To be filled as each wave completes. `BLOCKED` and `SKIPPED` are not passes.

W5 local evidence:

- `corepack pnpm build` passed at `453f1e9dcd6a6bb6f47ba41814a99b2c5c405ff9`.
- The focused release, publication, adoption, derivative, CLI, and retained-runtime suite passed 42/42.
- The governed candidate matrix rejected missing and altered receipts, blocked status, wrong approval-set digest, mismatched skill/version data, and swapped diffs.
- The real CLI preview rejected a review change between its initial and final preflight snapshots. The old exported candidate remained verifiable.
- Linux CI, Windows CI, real upstream validation, and remote-client validation remain unrecorded.
