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
| W0 | in progress | — | baseline refresh and defect reproduction |
| W1 | pending | — | owner-safe locks and process-death recovery |
| W2 | pending | — | atomic review batches |
| W3 | pending | — | approval before adoption |
| W4 | pending | — | verified derivative adoption |
| W5 | pending | — | approval-bound publication |
| W6 | pending | — | retained promotion race safety |
| W7 | pending | — | OAuth harness offline hardening |
| W8 | pending | — | connected CLI/MCP E2E |
| W9 | pending | — | combined-head CI and merge preparation |

## Acceptance evidence

To be filled as each wave completes. `BLOCKED` and `SKIPPED` are not passes.

