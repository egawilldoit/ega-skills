# Catalog delta — catalog-2026-10-06.1

Old catalog: `catalog-2026-09-29.2` (114 skills, `sha256:1efdbc3d…`)
New catalog: `catalog-2026-10-06.1` (116 skills, `sha256:3de9177a…`)

| namespace | before | after |
|---|---|---|
| mattpocock | 25 | 27 |
| anthropic | 14 | 14 |
| vercel | 9 | 9 |
| egawilldoit | 66 | 66 |
| **total** | **114** | **116** |

Release diff (`release-diff.json`, machine-derived):
`status=CHANGED`, `added=3`, `removed=1`, `updated=9`.

## Added (3)

- `mattpocock/implement-spec`
- `mattpocock/pr`
- `mattpocock/retro`

## Removed (1)

- `mattpocock/resolving-merge-conflicts` — removed upstream in v1.3.0 with no
  replacement. Not retained, not aliased. No frozen EGA contract requires a
  compatibility alias for it, so none was invented.

## Changed (9)

| skill | old SkillVersion | new SkillVersion |
|---|---|---|
| `mattpocock/ask-matt` | `sha256:a4e87261…` | `sha256:55d18157…` |
| `mattpocock/codebase-design` | `sha256:265858fa…` | `sha256:cc7fced2…` |
| `mattpocock/diagnosing-bugs` | `sha256:f56e6a33…` | `sha256:2544b52d…` |
| `mattpocock/domain-modeling` | `sha256:fbe160a6…` | `sha256:3d1b9f18…` |
| `mattpocock/improve-codebase-architecture` | `sha256:707c0647…` | `sha256:f00dca63…` |
| `mattpocock/setup-matt-pocock-skills` | `sha256:31121702…` | `sha256:5a80979a…` |
| `mattpocock/tdd` | `sha256:881b83c9…` | `sha256:8a80a764…` |
| `mattpocock/triage` | `sha256:3e8d4ae4…` | `sha256:34325b72…` |
| `mattpocock/wait-what` | `sha256:18a2e20a…` | `sha256:23bbecb0…` |

Every one of these nine is an upstream content change, not a local edit:
`ask-matt` (retires the `diagnosing-bugs → improve-codebase-architecture`
hand-off, adds `/implement-spec`, `/pr`, `/retro`), `codebase-design`
(`DESIGN-IT-TWICE.md`), `diagnosing-bugs`, `domain-modeling`
(`CONTEXT-FORMAT.md` → `GLOSSARY-FORMAT.md` rename plus SKILL.md),
`improve-codebase-architecture`, `setup-matt-pocock-skills`
(`SKILL.md` + `domain.md`), `tdd`, `triage`, `wait-what` — the last five are
the `CONTEXT.md` → `GLOSSARY.md` convention migration.

`diagnosing-bugs` and `tdd` additionally carry the carried-forward EGA routing
overlay (see `governance.md`), which is why their new hashes differ from a naive
upstream-only recomputation.

## Unchanged (104)

- Non-Matt namespaces: **89/89 byte-identical** to the parent
  (`anthropic` 14, `vercel` 9, `egawilldoit` 66). No SkillVersion in any
  unrelated namespace moved.
- Matt skills unchanged at 15/15: `code-review`, `grill-me`,
  `grill-with-docs`, `grilling`, `handoff`, `implement`, `prototype`,
  `research`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`,
  `wayfinder`, `wizard`, `writing-for-agents`.

## Inventory correspondence

The final Matt inventory is exactly the 27 upstream selected roots at
`24fe0ef7737efae15c87225755e9f6f5965e4888`: no stale skill, no missing skill,
no duplicate logical ID (programmatically asserted; see `artifact.md`).