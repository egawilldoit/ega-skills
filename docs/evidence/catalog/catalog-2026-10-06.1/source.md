# Source — catalog-2026-10-06.1

- Catalog ID: `catalog-2026-10-06.1`
- Product: EGA Skills 2.0.1 (**software unchanged**; catalog-content release only)
- Base branch: `release/2.0`
- Base SHA: `39ae0d7b19ab5cf5830b5d36dd9280cebcbcc0d9`
- Parent catalog: `catalog-2026-09-29.2` → `9c8b0eb98cc608bdc727287fdeb285040fb2771a`

## Upstream release

| field | value |
|---|---|
| repository | https://github.com/mattpocock/skills |
| release | `v1.3.1` |
| release URL | https://github.com/mattpocock/skills/releases/tag/v1.3.1 |
| tag object | `0b6cee10f260a2e048279cf737bfd3e37b1fce0b` |
| tag type | **annotated** (`tag v1.3.1`, tagger `github-actions[bot]`, signed-off 2026-09-25 epoch 1791118097) |
| resolved commit | `24fe0ef7737efae15c87225755e9f6f5965e4888` |
| commit subject | `Merge pull request #1160 from mattpocock/changeset-release/main` |
| commit date | 2026-10-04 13:48:05 +0100 |
| previous pin | `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` (2026-09-18) |
| license | MIT, repo-level `LICENSE`, byte-identical between the two pins (`sha256:0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5`) |

The Git tree is authoritative; release notes were not used as the source of truth.

## Selected roots (27)

All of `skills/engineering/*` and `skills/productivity/*` skill directories at
the exact commit. Excluded by construction (same rule as the previous pin):
`skills/deprecated/`, `skills/in-progress/`, `skills/misc/`, and the two
category `README.md` files. `skills/in-progress/implement-spec`,
`skills/in-progress/pr` and `skills/in-progress/retro` were **promoted** by
v1.3.x into `skills/engineering/` and are therefore newly in scope; they are not
newly-authored content.

Every selected file was byte-verified against the upstream git blobs at
`24fe0ef7737efae15c87225755e9f6f5965e4888` (79 files, 0 mismatches).

## Governing pin

The governed identity is the exact 40-character commit
`24fe0ef7737efae15c87225755e9f6f5965e4888`. Neither `v1.3.1` nor `main` is used
as a stored source identity anywhere in this release.