# Artifact — catalog-2026-10-06.1

Built with the existing Contract C build path (`hub release preview` →
`hub release export`). No fixtures, no hand-edited release files, no manual
`registry.sqlite` edits.

## Identity

| | value |
|---|---|
| old release digest | `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77` |
| **new release digest** | `sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3` |
| hub id | `personal` |
| skills | 116 (mattpocock 27, anthropic 14, vercel 9, egawilldoit 66) |
| sqlite artifact digest | `sha256:de3ab40cfb13adf05f420cae72d5f7d18add82331d593ff3bf6e5f5f468f6e1d` |
| previous release digest (in candidate) | `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77` |
| approval set digest | `sha256:7dd05f4ee567ea47c74be53ab70110d86c2d4916737f3df403a9d298cb174bfa` |
| preflight digest | `sha256:93547211302347c13c7febeb1750b93a19de977ba4cbf3979c0df6262c55928b` |
| release diff digest | `sha256:d84db18c91fc3af78c9bbce7124c6b49d73af1b25d41f62fb78582cddc6476cb` |

## Pipeline result

| gate | result |
|---|---|
| `hub intake plan/stage/review/apply` (anthropic, mattpocock, vercel, egawilldoit) | COMMITTED × 5 |
| `hub intake derive/review/apply` (`mattpocock/pr` D1 repair) | COMMITTED |
| `hub release preflight` | **READY**, hub `personal`, reviews **116**, blockers **0** |
| `hub release preview --against <parent artifact>` | READY |
| `hub release export` | EXPORTED |
| `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact` | **OK**, 116 skills |

The artifact was built into a scratch directory and only then copied into
`packages/mcp/artifact`. The previously committed artifact was never mutated in
place.

## Release diff

`status=CHANGED`, added 3, removed 1, updated 9. See `delta.md`.

## Catalog assertions (programmatic)

```
PASS  must exist      mattpocock/implement-spec
PASS  must exist      mattpocock/pr
PASS  must exist      mattpocock/retro
PASS  must NOT exist  mattpocock/resolving-merge-conflicts
PASS  representative  mattpocock/ask-matt
PASS  representative  mattpocock/code-review
PASS  representative  mattpocock/diagnosing-bugs
PASS  representative  mattpocock/domain-modeling
PASS  representative  mattpocock/grill-with-docs
PASS  representative  mattpocock/tdd
PASS  representative  mattpocock/to-spec
PASS  representative  mattpocock/to-tickets
PASS  representative  mattpocock/triage
PASS  representative  mattpocock/wait-what
PASS  representative  mattpocock/wayfinder
PASS  mattpocock inventory == upstream selected roots (27 vs 27)
PASS  no duplicate logical IDs
PASS  total = 116
```

## Unchanged namespaces

**89/89** non-Matt SkillVersion hashes byte-identical to the parent release
(anthropic 14, vercel 9, egawilldoit 66). Verified by direct comparison of
`skill_versions` maps; no catalog-wide metadata consequence was applied to them.

## Artifact-only MCP smoke

Booted `packages/mcp/bin/ega-mcp.mjs` with `EGA_SKILLS_HOME` pointed at the
exported artifact and the runtime CWD set to `/tmp` — the source checkout is not
on the runtime path. Driven over real JSON-RPC.

**42 checks, 42 passed, 0 failed.** Full output: `mcp-smoke.log`.

| area | result |
|---|---|
| tools advertised | exactly 4 — `get_content`, `inspect`, `resolve`, `search` |
| `search` → `mattpocock/retro` | PASS (rank 1 of 2) |
| `search` → `mattpocock/implement-spec` | PASS (rank 2 of 7) |
| `search` → `mattpocock/pr` | PASS for `pr body` (rank 1); see `routing.md` §4 for the recorded `pull request` limitation |
| `inspect` + `get_content` for all three new skills | PASS |
| `mattpocock/retro` content: Skill-tool invocation, seven improvement categories | PASS |
| `ask-matt` routes to `/implement-spec`, `/retro`, `/pr`; drops `/resolving-merge-conflicts` | PASS |
| `implement-spec` task graph / frontier / worktrees / integration branch | PASS |
| `pr` Summary / Evidence / Merge Danger / Blast Radius shape | PASS |
| `inspect` refuses removed `resolving-merge-conflicts` (`E_SKILL_NOT_FOUND`) | PASS |
| `get_content` refuses it (`E_VERSION_NOT_FOUND`) | PASS |
| `search` does not serve it | PASS |
| GLOSSARY transition: 9 skills serve `GLOSSARY.md` with no stale `CONTEXT.md` | PASS |
| `codebase-design` companion `DESIGN-IT-TWICE.md` uses `GLOSSARY.md` | PASS |
| **no served skill references `CONTEXT.md` (116 swept)** | PASS |
| regression smoke: 3 Matt + 3 non-Matt (`egawilldoit/understand-codebase`, `anthropic/mcp-builder`, `vercel/react-best-practices`) | PASS |
| **no build-host path in any served response (116 skills)** | PASS |
| **`local_path` hub-relative logical for all 116 skills** | PASS |

Note on the path invariant: the check targets `/home/ubuntu/` (the build host) and
persisted `local_path`, not generic `/tmp` literals. Skill prose legitimately
contains `/tmp/...` (e.g. `anthropic/skill-creator` telling the agent to write a
temp file), and those literals are present identically in the previous production
artifact — so they are content, not leakage.

## Read-only proof

```
848 files hashed before the artifact-only MCP smoke
848 files hashed after
before == after  ->  PASS, 0 mutations
```

Serving the release does not mutate the immutable artifact.