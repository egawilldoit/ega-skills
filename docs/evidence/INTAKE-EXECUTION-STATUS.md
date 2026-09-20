# Intake-to-publication execution status

Last updated: 2026-09-20

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
| P01 shared preparation boundary | `codex/intake-p01` / [PR #100](https://github.com/egawilldoit/ega-skills/pull/100) | Implemented; required CI green | Final HEAD `0490c2571be4ba9ca49c672a28cd72a4a35af764`; Linux [`35469702213`](https://github.com/egawilldoit/ega-skills/actions/runs/35469702213/job/105968298974), Windows [`35469702213`](https://github.com/egawilldoit/ega-skills/actions/runs/35469702213/job/105968298989), and Contract F [`35469702213`](https://github.com/egawilldoit/ega-skills/actions/runs/35469702213/job/105968298903) passed. |
| P02 import planning CLI | `codex/intake-p02` / [PR #101](https://github.com/egawilldoit/ega-skills/pull/101) | Implemented; required CI green | Implementation commit `ff3c4bf`; Contract G v1 and actual CLI cover IP-01–09; the Hub builder performs read-only journal inspection for IP-10, reporting COMMITTED cleanup remnants without deleting them. CI run [`35471709565`](https://github.com/egawilldoit/ega-skills/actions/runs/35471709565): Linux [`105973717037`](https://github.com/egawilldoit/ega-skills/actions/runs/35471709565/job/105973717037), Windows [`105973717068`](https://github.com/egawilldoit/ega-skills/actions/runs/35471709565/job/105973717068), and Contract F [`105973716921`](https://github.com/egawilldoit/ega-skills/actions/runs/35471709565/job/105973716921) passed. Vercel auth/MCP checks passed; Macroscope and CodeSmith were skipped by configuration. |
| P03 exact acquisition and adoption staging | `codex/intake-p03` / [PR #102](https://github.com/egawilldoit/ega-skills/pull/102) | Implemented; required CI green | Final HEAD `bf7af61`; Linux [`35473883544`](https://github.com/egawilldoit/ega-skills/actions/runs/35473883544/job/105979643911), Windows [`35473883544`](https://github.com/egawilldoit/ega-skills/actions/runs/35473883544/job/105979644060), and Contract F [`35473883544`](https://github.com/egawilldoit/ega-skills/actions/runs/35473883544/job/105979643979) passed. |
| P04 first adoption apply and recovery | `codex/intake-p04` / [PR #103](https://github.com/egawilldoit/ega-skills/pull/103) | Implemented; required CI green | Final HEAD `c1bf2b0`; local AD-01–AD-07 and full suite passed. CI run [`35474815346`](https://github.com/egawilldoit/ega-skills/actions/runs/35474815346): Linux [`105982134357`](https://github.com/egawilldoit/ega-skills/actions/runs/35474815346/job/105982134357), Windows [`105982134481`](https://github.com/egawilldoit/ega-skills/actions/runs/35474815346/job/105982134481), and Contract F [`105982134485`](https://github.com/egawilldoit/ega-skills/actions/runs/35474815346/job/105982134485) passed. |
| P05 owned derivatives | `codex/intake-p05` / [PR #104](https://github.com/egawilldoit/ega-skills/pull/104) | Implemented; required CI green | Final HEAD `09741f9689ec6d027d72bbd7d8b3948e3c90e120`; CP-01–CP-04 pass in the real CLI-backed targeted suite. CI run [`35475949174`](https://github.com/egawilldoit/ega-skills/actions/runs/35475949174): Linux [`105985108029`](https://github.com/egawilldoit/ega-skills/actions/runs/35475949174/job/105985108029), Windows [`105985108075`](https://github.com/egawilldoit/ega-skills/actions/runs/35475949174/job/105985108075), and Contract F [`105985107823`](https://github.com/egawilldoit/ega-skills/actions/runs/35475949174/job/105985107823) passed. |
| P06 review and publication preflight | `codex/intake-p06` / [PR #105](https://github.com/egawilldoit/ega-skills/pull/105) | Implemented; required CI green | Implementation commit `c90ff9f`; evidence commits `74c484a`, `13fdee1`; RV-01–RV-04 pass in the targeted suite and the actual CLI exposes exact review and preflight commands. Contract E1/E2 adds append-only CAS review records and a fresh-catalog approval gate. Final-tip CI run [`35477917860`](https://github.com/egawilldoit/ega-skills/actions/runs/35477917860): Linux [`105990282012`](https://github.com/egawilldoit/ega-skills/actions/runs/35477917860/job/105990282012), Windows [`105990282105`](https://github.com/egawilldoit/ega-skills/actions/runs/35477917860/job/105990282105), and Contract F [`105990282146`](https://github.com/egawilldoit/ega-skills/actions/runs/35477917860/job/105990282146) passed; Vercel auth/MCP and preview checks passed. |
| P07 collections | `codex/intake-p07` / [PR #106](https://github.com/egawilldoit/ega-skills/pull/106) | Implemented; required CI green | HEAD `df19b59`; Contract E3 and CL-01–CL-02 pass. Local full suite: 996 tests, 991 pass, 0 fail, 5 skipped. CI run [`35479067275`](https://github.com/egawilldoit/ega-skills/actions/runs/35479067275): Linux [`105993406827`](https://github.com/egawilldoit/ega-skills/actions/runs/35479067275/job/105993406827), Windows [`105993406817`](https://github.com/egawilldoit/ega-skills/actions/runs/35479067275/job/105993406817), and Contract F [`105993406731`](https://github.com/egawilldoit/ega-skills/actions/runs/35479067275/job/105993406731) passed; Vercel auth/MCP previews passed. |
| P08 deterministic quality diagnostics and routing evaluation | `codex/intake-p08` / [PR #107](https://github.com/egawilldoit/ega-skills/pull/107) | Implemented; required CI green | Implementation HEAD `06dfdb35a7a9943f4db35d985c6948de0bd0a9ee`; Contract Q1 and QL-01–QL-03 pass. Targeted CLI/quality/evaluation tests: 17 pass, 0 fail. Full local suite: 1000 tests, 995 pass, 0 fail, 5 skipped. Routing corpus: 30/30, release digest `sha256:a65f9ef7cb97b0c13289d38f54c1357538bdbec65f7ceaba7f686e2506e42893`, metadata revision `routing-corpus-v1`. Primary CI run [`35480739273`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739273): Linux [`105997951211`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739273/job/105997951211), Windows [`105997951122`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739273/job/105997951122), and Contract F [`105997951228`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739273/job/105997951228) passed. Hashing traversal run [`35480739317`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739317): Linux [`105997951363`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739317/job/105997951363) and Windows [`105997951385`](https://github.com/egawilldoit/ega-skills/actions/runs/35480739317/job/105997951385) passed. Vercel auth/MCP/preview checks passed. |
| P09 optional AI/L1 pilot | Deferred | Optional after the manual workflow | The deterministic P08 workflow is complete. AI suggestions remain non-authoritative and no P09 code has been started. |
| P10 immutable release preview/export | `codex/intake-p10` / [PR #108](https://github.com/egawilldoit/ega-skills/pull/108) | Implemented; required CI green | Implementation `c37489b5b93999fadcc10205edb403a62ba4ef97`; Windows portability fix `3ecd9f0`. Contract R1 and RL-01–RL-03 pass; actual CLI export and blocked preview pass. Full local suite: 1004 tests, 999 pass, 0 fail, 5 skipped. Required CI run [`35482721365`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721365): Linux [`106003301475`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721365/job/106003301475), Windows [`106003301470`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721365/job/106003301470), and Contract F [`106003301350`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721365/job/106003301350) passed. Hashing traversal run [`35482721370`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721370): Linux [`106003301380`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721370/job/106003301380) and Windows [`106003301333`](https://github.com/egawilldoit/ega-skills/actions/runs/35482721370/job/106003301333) passed. Vercel auth/MCP/preview checks passed. |
| P11 retained serving and deployment | `codex/intake-p11` / [PR #109](https://github.com/egawilldoit/ega-skills/pull/109) | Implemented; required CI green | HEAD `0038995`; Contract R2 and RL-04–RL-07 pass. Targeted hosted tests: 34 pass, 0 fail. Full local suite: 1009 tests, 1004 pass, 0 fail, 5 skipped. CI run [`35484690057`](https://github.com/egawilldoit/ega-skills/actions/runs/35484690057): Linux [`106008800333`](https://github.com/egawilldoit/ega-skills/actions/runs/35484690057/job/106008800333), Windows [`106008800347`](https://github.com/egawilldoit/ega-skills/actions/runs/35484690057/job/106008800347), and Contract F [`106008800243`](https://github.com/egawilldoit/ega-skills/actions/runs/35484690057/job/106008800243) passed; Vercel auth/MCP checks passed. |
| P12 spawned CLI and publication proof | `codex/intake-p12` / [PR #110](https://github.com/egawilldoit/ega-skills/pull/110) | Local proof implemented; external acceptance blocked | Implementation HEAD `f656870b57701d6fc857f3a373eb7d95881e5ae7`. The actual CLI executes plan → stage → apply → review → preflight → preview → export and verifies exact release identity, artifact validation, and source immutability. Targeted E2E: 21 pass. Full local suite: 1010 tests, 1005 pass, 0 fail, 5 skipped. CI run [`35485693628`](https://github.com/egawilldoit/ega-skills/actions/runs/35485693628): Linux [`106011517374`](https://github.com/egawilldoit/ega-skills/actions/runs/35485693628/job/106011517374), Windows [`106011517303`](https://github.com/egawilldoit/ega-skills/actions/runs/35485693628/job/106011517303), and Contract F [`106011517458`](https://github.com/egawilldoit/ega-skills/actions/runs/35485693628/job/106011517458) passed; Vercel auth/MCP/preview checks passed. Authorized non-production upstream and remote Codex/OpenCode acceptance remain blocked. |

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

## P02 implementation and local evidence

`ega-skills import-plan <folder> --namespace <namespace> --output <plan.json>`
now creates a deterministic, zero-mutation Contract G envelope. It reuses the
P01 preparation boundary, reads an existing registry with SQLite read-only
access, records raw source snapshot identity separately from canonical version
identity, predicts new/unchanged/update/reactivation outcomes, and emits
structured candidate and discovery diagnostics. The command writes a plan even
when blocked and uses exit status 1 for those plan diagnostics. It does not
create an absent registry home.

The Contract G validator rejects unknown fields, malformed identities, invalid
namespaces, and inconsistent summary counts. Hub builds use a new read-only
journal gate: a COMMITTED journal is reported as recovery-required and its
staging/backup remnants remain untouched; explicit recovery retains cleanup
authority.

Acceptance coverage: IP-01–IP-09 in `tests/cli/import-plan.test.mjs`, and
IP-10 in `tests/project/hub-builder.test.mjs`. Local evidence so far:
`pnpm build`, `pnpm typecheck`, `pnpm specs:check`,
`pnpm test:perf:registry`, `pnpm contracts:check-g`, the 8-case intake-plan
CLI run, the 37-test intake/import/preparation/lifecycle/read-only regression
CLI run, the 37-test intake/import/preparation/lifecycle/read-only regression
run, and the 70-test Hub builder/adoption/recovery run all passed. The full
repository test passed with 974 tests, 969 passed, 0 failed, and 5 skipped.
The final required local gates also passed: frozen-lockfile install with no
lockfile diff, typecheck, frozen specs, registry performance, Contract G, and
diff checks.

## Required resume protocol

1. Verify the current branch and worktree before editing; preserve the three
   unrelated user changes listed above.
2. Run the targeted tests and repository gates for the active slice before
   opening its PR.
3. Do not start a dependent slice until its predecessor has a green required
   CI result.
4. Add exact commit SHA, PR URL, CI URLs, and any blocked/live evidence here
   after each slice.
5. Never merge or deploy without explicit user approval.
