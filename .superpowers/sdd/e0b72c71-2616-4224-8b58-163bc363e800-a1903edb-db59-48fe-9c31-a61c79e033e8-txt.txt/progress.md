# SDD ledger — plan: /home/ubuntu/.t3/userdata/attachments/e0b72c71-2616-4224-8b58-163bc363e800-a1903edb-db59-48fe-9c31-a61c79e033e8-txt.txt

## Setup

- Execution is inline; no subagents used, per user instruction.
- Correction branch: `fix/intake-merge-readiness`, based on `40007ed4c14dcd9cf6c1a6c348818321993d274d` (#110).
- Production baseline: `9622a6ac4d06f00da525046e5ebb29428dfb91ff` (`release/2.0`).
- Separate OAuth branch: `e5cdadf8986335d84df7aebd3c4fef98a2494d70` (#99).
- Current execution began 2026-09-20 UTC at approximately 03:xx; no exact operator cutoff was supplied.
- Original checkout dirty state is preserved outside this worktree: `scripts/oauth/interop-check.mjs`, `.vercel/`, `packages/mcp/.gitignore`.

## Refreshed PR matrix

| PR | head | base | state |
|---:|---|---|---|
| 99 | `e5cdadf8986335d84df7aebd3c4fef98a2494d70` | `9622a6ac4d06f00da525046e5ebb29428dfb91ff` | open |
| 100 | `0490c2571be4ba9ca49c672a28cd72a4a35af764` | `9622a6ac4d06f00da525046e5ebb29428dfb91ff` | open |
| 101 | `3b5876cc626b243c0bab9325e49dbc7efc1ffa9e` | `0490c2571be4ba9ca49c672a28cd72a4a35af764` | open |
| 102 | `bf7af614e9d0838a7fe6b4c89a840ee5ae43bfa7` | `3b5876cc626b243c0bab9325e49dbc7efc1ffa9e` | open |
| 103 | `c1bf2b073f1ea57289863efa23f77a20271c5f18` | `bf7af614e9d0838a7fe6b4c89a840ee5ae43bfa7` | open |
| 104 | `09741f9689ec6d027d72bbd7d8b3948e3c90e120` | `c1bf2b073f1ea57289863efa23f77a20271c5f18` | open |
| 105 | `11add8f326ca4e23c65af1efba08e428a603d643` | `09741f9689ec6d027d72bbd7d8b3948e3c90e120` | open |
| 106 | `e1f8067a5676ad10ec8ff0e8afa29216ca6a649a` | `11add8f326ca4e23c65af1efba08e428a603d643` | open |
| 107 | `80961350226c1c6e0e24112cece046953bced0b2` | `e1f8067a5676ad10ec8ff0e8afa29216ca6a649a` | open |
| 108 | `5fd87bc4d90f54cc0038723cd6b655aa464ac836` | `80961350226c1c6e0e24112cece046953bced0b2` | open |
| 109 | `ed77cd74130ffb4bdee0c46668e7095d74797168` | `5fd87bc4d90f54cc0038723cd6b655aa464ac836` | open |
| 110 | `40007ed4c14dcd9cf6c1a6c348818321993d274d` | `ed77cd74130ffb4bdee0c46668e7095d74797168` | open |

## Pre-flight shared interfaces

- W1 produces owner-safe Hub lock/recovery behavior consumed by W3 adoption, W6 retained promotion, and W8 crash/race evidence.
- W2 produces atomic review-batch persistence consumed by W3 approval enforcement, W4 derivative adoption, and W5 publication bindings.
- W3 changes adoption authority and baseline semantics consumed by W4 derivative candidates, W5 candidate preflight, and W8 CLI E2E.
- W4 produces verified owned-adoption candidates consumed by W5 publication and W8 derivative E2E.
- W5 produces governed publication bindings consumed by W6 promotion and W8 retained-runtime E2E.
- W6 changes retained lock ownership and manifest transitions consumed by W8 MCP/retained E2E and W9 final CI.
- W7 is separate OAuth harness work and is merged into the final integration only after offline hardening.

## Rulings

- No plan/spec conflict identified during pre-flight. The new merge-readiness plan is the binding correction scope; optional AI, ZIP, UI, additional clients, and broad redesign remain deferred.
- The executing-plans skill references task-start/task-done helpers, but those scripts are absent from the installed skill; wave state is recorded manually in this ledger and the evidence document.
