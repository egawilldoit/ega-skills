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
| full suite | `pnpm test:ci` (bounded runner) | see below |

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
selections displaced, 0 unrelated-namespace regressions — **but 1 proven platform
defect introduced by `mattpocock/pr` (12/20 false-positive auto-selections),
which is a release blocker.**

## Version integrity

| file | change |
|---|---|
| `package.json` version | **unchanged** (`2.0.1`) |
| `packages/router/src/tiers.ts` | **unchanged** (prototype reverted; `git diff` empty) |
| `packages/schema` | **unchanged** |
| `docs/specs/**` | **unchanged** (all 8 frozen files) |

Only `packages/mcp/artifact/**` and `docs/evidence/catalog/catalog-2026-10-06.1/**`
changed. This is a catalog-content release with **no software change**.

## Known BLOCKER

`mattpocock/pr` — SPEC-004 §5.1.11.2 substring `NAME_DESCRIPTION` matching makes
a 2-character portable name match inside ordinary words. Measured 12/20
false-positive auto-selections on unrelated tasks. Fixing it requires either a
frozen-contract amendment or a catalog that avoids 2-character skill names; it is
out of scope for a catalog-only release and must not be papered over. Full
analysis, reproduction and the recommended fix are in `routing.md`.

## Manual follow-up

ChatGPT Web validation remains manual (unchanged from prior releases).