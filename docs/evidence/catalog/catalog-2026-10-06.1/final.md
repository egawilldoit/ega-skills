# Verification — catalog-2026-10-06.1

All commands run from the release worktree at base `39ae0d7b19ab5cf5830b5d36dd9280cebcbcc0d9`
on branch `chore/catalog-matt-v1.3.1`. No frozen runtime source was modified.

## Canonical gates

| gate | command | result |
|---|---|---|
| install | `pnpm install --frozen-lockfile` | PASS |
| build | `pnpm build` | PASS |
| typecheck | `pnpm typecheck` (`tsc -b --force`) | PASS |
| specs | `pnpm specs:check` | PASS — 8 frozen files, no placeholders, G001–G042 ×1, T001–T009 present |
| artifact validator | `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact` | **PASS** — `OK digest=sha256:3de9177a… hub=personal skills=116` |
| contract A | `pnpm contracts:check-a` | PASS |
| contract B | `pnpm contracts:check-b` | PASS |
| contract C | `pnpm contracts:check-c` | PASS |
| contract G | `pnpm contracts:check-g` | PASS |
| full suite | `pnpm test:ci` (bounded runner, 90-min bound) | **923 pass / 1 fail** — the one failure is a load-induced p95 perf budget on byte-identical router code (see §Pre-existing perf failures) |
| `pnpm release:verify` | **19 / 20 stages PASS**; the single failure is a pre-existing host-speed perf budget, proven unrelated to this release (see §Pre-existing perf failure) |

## Pre-existing perf failures — not caused by this release

Two wall-clock budget assertions fail on this host. Both are performance budgets,
not correctness assertions, and both are provably independent of this release.

### 1. `registry:performance` (cold import)

`pnpm release:verify` fails one stage: `registry:performance`.

```
SPEC-003 §5.1.11: isolated 100-skill cold import meets platform budget
cold import elapsed 9078 ms exceeds budget 5000 ms on linux
```

| evidence | finding |
|---|---|
| the failing test imports **100 synthetic fixture skills** into a temp dir | it never reads `packages/mcp/artifact`, `hub-release.json`, or any catalog content |
| `git diff --name-only release/2.0..HEAD`, filtered to non-artifact/non-docs paths | **empty** — this branch modifies zero runtime source files |
| same test on the **unmodified base checkout** `/home/ubuntu/ega-skills` | fails identically: `elapsed 9639 ms` vs budget `5000 ms` |
| same test on this branch, run isolated | `elapsed 8982 ms` — **faster** than the base checkout, still over budget |

The host runs this fixture import at roughly half the speed the frozen 5 s budget
assumes, on code paths this release does not touch.

The other 19 `release:verify` stages pass, including all four contract gates,
version-consistency across all 11 workspaces, lockfile cleanliness, and the
stdio + hosted MCP self-identity checks.

### 2. Full suite: `warm benchmark` p95

The full suite reports **923 passing, 1 failing**. The single failure:

```
warm benchmark: 100-skill registry, 30 timed resolves, p95 <= 300ms
[BENCH] min=51.0 median=128.5 p95=305.1 max=416.1
```

A 305.1 ms p95 against a 300 ms budget — a 1.7% overshoot, measured while all
128 test files execute concurrently. It is load-induced, not a code regression:

| evidence | finding |
|---|---|
| `git diff --stat release/2.0..HEAD -- packages/router/ tests/router/` | **empty output** — the benchmarked source and its tests are byte-identical to the base |
| this branch, isolated | **PASSES**: `p95=117.3 ms` |
| base checkout, isolated | **PASSES**: `p95=67.2 ms` |
| repeated alternating runs on both checkouts | base `238.4 / 96.3`, branch `127.1 / 91.3` — the distributions overlap heavily |

Both checkouts pass when the host is not saturated, and both fail under load, on
identical router source. The benchmark is measuring host contention, not this
catalog.

**Both failures are recorded, not papered over.** They are real budget failures
on this machine; they are simply not attributable to a change that touches no
runtime code at all.

## Release pipeline gates

| stage | result |
|---|---|
| `hub intake plan` ×5 | anthropic 14 READY, mattpocock 26 READY, pr BLOCKED (expected), vercel 9 READY, egawilldoit 66 READY |
| `hub intake stage` ×5 | OK |
| `hub intake review` ×5 | 116 approvals, revision 1, 0 stale, 0 rejected |
| `hub intake apply` ×5 | COMMITTED |
| `hub intake derive` (D1, `pr`) | READY, predicted version hash matched |
| `hub release preflight` | **READY** — hub `personal`, reviews 116, blockers **0** |
| `hub release preview` | READY, diff CHANGED (+3 / −1 / 9 updated) |
| `hub release export` | EXPORTED |
| `hub release export` re-validation | validator PASS on the exported tree |

## Catalog assertions

All PASS — see `artifact.md` for the full list (3 must-exist, 1 must-not-exist,
11 representatives, inventory==upstream roots, no duplicate IDs, total==116,
89/89 non-Matt identity preservation).

## Semantic content verification

| check | result |
|---|---|
| `implement-spec` serves task-graph / ready-frontier / worktree / integration-branch semantics | PASS |
| `pr` serves Summary / Evidence / Merge-Danger / Blast-Radius closeout shape | PASS |
| `retro` uses explicit Skill-tool invocation (`Call the Skill tool with …`) | PASS |
| `retro` covers navigation, automated checks, coding standards, steering, tool economy, information access | PASS |
| `ask-matt` routes to `/implement-spec`, `/retro`, `/pr` | PASS |
| `ask-matt` no longer routes to `/resolving-merge-conflicts` | PASS |
| GLOSSARY.md convention present in 9 skills that carry it | PASS |
| `codebase-design` companion `DESIGN-IT-TWICE.md` uses GLOSSARY.md | PASS |
| **no served skill (116 swept) references `CONTEXT.md`/`CONTEXT-MAP.md`** | PASS |

## Artifact-only serving

- MCP booted with `cwd=/tmp`, `EGA_SKILLS_HOME=<artifact>`; no source checkout on
  the runtime path.
- Tools advertised: exactly 4 — `get_content`, `inspect`, `resolve`, `search`.
- 42/42 checks PASS. See `artifact.md`.
- Read-only proof: 848-file manifest identical before and after serving
  (`sha256:d9cdf518…` both times) → 0 mutations.

## Routing verification

See `routing.md`. Summary: 0 selection changes on 19 shared tasks, 0 correct
selections displaced, 0 unrelated-namespace regressions — **plus 1 proven
platform defect introduced by `mattpocock/pr` (12/20 false-positive
auto-selections), which the release owner adjudicated as ACCEPTED: ship with the
regression documented and tracked.**

## Version integrity

| file | change |
|---|---|
| `package.json` version | **unchanged** (`2.0.1`) |
| `packages/router/src/tiers.ts` | **unchanged** (prototype reverted; `git diff` empty) |
| `packages/schema` | **unchanged** |
| `docs/specs/**` | **unchanged** (all 8 frozen files) |

Only `packages/mcp/artifact/**` and `docs/evidence/catalog/catalog-2026-10-06.1/**`
changed. This is a catalog-content release with **no software change**.

## Known defect — ACCEPTED, not a blocker

`mattpocock/pr` — SPEC-004 §5.1.11.2 substring `NAME_DESCRIPTION` matching makes
a 2-character portable name match inside ordinary words. Measured 12/20
false-positive auto-selections on unrelated tasks, reproduced through the real
MCP `resolve` against the committed artifact. Fixing it requires either a
frozen-contract amendment or a catalog that avoids 2-character skill names; it is
out of scope for a catalog-only release and must not be papered over. Full
analysis, reproduction, the recommended fix and the adjudication are in
`routing.md` §3, §4, §7 and §8.

**Adjudication: ACCEPTED — ship with the regression documented and tracked.**
It does not block this release; it is carried as follow-up work.

## Manual follow-up

ChatGPT Web validation remains manual (unchanged from prior releases).

## Deployment verification protocol (from the parent catalog tag)

The annotated tag `catalog-2026-09-29.2` records a hard invariant that changes
how this release must be verified in production:

> Verify a deployment with: exact source SHA + physical artifact hash +
> runtime path invariant (inspect `sources[].local_path` relative).
> **Do NOT rely on `release_digest` alone to prove sanitization.**

`release_digest` proves *semantic* catalog identity and deliberately does not
cover `skill_sources` provenance rows. That is precisely why the `.1`/`.2`
discrepancy was possible: `.2` had an identical digest and different physical
bytes. Relying on the digest alone would repeat exactly that mistake.

`scripts/hosted/accept-catalog-2026-10-06.1.mjs` implements the invariant. It
reads the expected 116 `id -> version_hash` pairs from the merged artifact's
`hub-release.json` — so it cannot drift from what was reviewed — and asserts:

| # | identity | assertion |
|---|---|---|
| 1 | semantic | served `effective_release_digest` == `sha256:3de9177a…` |
| 2 | **physical** | **all 116 served `version_hash` values equal the reviewed values** |
| 3 | path | every `sources[].local_path` is host-relative; no build-host path in any response |
| 4 | membership | the 3 added skills serve; the withdrawn skill is refused by `inspect` *and* absent from `search` |

Check 2 is the strong one: per-skill hashes prove physical identity where the
digest cannot.

Verified offline against the committed artifact through a stdio MCP server
behind an HTTP shim (`cwd=/tmp`, artifact as the only runtime input):

```
checks: 17  passed: 17  failed: 0  skipped: 1   ->  PRODUCT_READY
```

The one skip is the semantic digest check: `effective_release_digest` is a
**hosted-only** wrapper (`packages/mcp/src/hosted.ts:247`). A stdio server never
emits it, so the script requires it by default and only tolerates its absence
behind an explicit `--allow-missing-digest` flag, which is for offline dry runs
only. In production the flag must not be passed.

Two API facts the dry run established, both of which would otherwise have made
the production acceptance wrong:

- `search` caps `limit` at **20** (`min 1, max 20`), so the catalog cannot be
  enumerated from ranked search. The script therefore sweeps the reviewed 116-id
  list through `inspect` instead.
- `inspect` discloses `trust`, `l1`, `l2`, `l2_size_class`, `files`, `sources`
  and the `source <kind> <logical-path> observed_at=` provenance line, but **not**
  the release digest.

## Physical identity of this catalog

For the promotion tag and the post-production record:

```
registry.sqlite      sha256:de3ab40cfb13adf05f420cae72d5f7d18add82331d593ff3bf6e5f5f468f6e1d
hub-release.json     sha256:abd415ad229f7e469b77104f340cacde3d2a5443c57ac4900fd96f7df86ea260
release-package.json sha256:cd08205868e468902d45e953ca5bf65a5261204a6a41e0559d721abdf68da577
artifact tree        sha256:4157291f4300fe5996dbeb5c2ca4a1dcefd1695cbf5b352628d943e6a3fd8455   (850 files)
release_digest       sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3
```

The tree is 850 files: the 848 files `hub release export` produced, plus the two
hand-maintained `README.md` and `PROVENANCE.md` that live alongside the export.
