# Source skill manager operations

The manager proposes changes to `egawilldoit/skills` on a dedicated branch. It does not merge source PRs or publish releases. Source PR CI and human review remain required; a PR or passing observed checks does not prove publication.

The editor is disabled unless all three server-only variables are configured:

- `EGA_SOURCE_GITHUB_TOKEN`: a fine-grained token restricted to `egawilldoit/skills`, with repository contents and pull request read/write permissions. Never expose it in browser configuration or client logs.
- `EGA_SOURCE_EDITOR_SUBJECTS`: comma-separated Supabase user UUIDs that are explicitly authorized to manage this GitHub repository. Workspace owner status alone is insufficient.
- `EGA_SOURCE_EDITOR_ORIGIN`: the exact HTTPS console origin, without a trailing slash (HTTP is accepted only for localhost). POST requests must carry this exact Origin.

Production uses the canonical console origin. A preview deployment needs its own exact preview origin and the same three server-side variables; never reuse a production origin for a preview. The editor stays disabled in environments where the origin or an allowlisted subject is absent.

Supabase caller identity is independently verified on each request. To rotate the GitHub token, create the replacement with the same repository restriction, update the server-side secret using the normal deployment process, verify an authorized editor can read the source index, and revoke the old token. Never put token values into the repository, PRs, tickets, or browser-facing variables. Removing any required setting disables the editor.

A GitHub import is read from a full commit SHA over the GitHub API without the source token. It requires one root license, supported paths, strict source frontmatter, and explicit acceptance of the catalog's `original` normalization. The proposal preserves the pinned origin, attribution, and license; classification does not assert authorship. Executable files under `scripts/` are retained as files and are never executed by the manager. Unsupported metadata or resource paths are refused.

A single SKILL.md or a bounded ZIP archive can be uploaded for an add proposal. The ZIP route accepts one skill directory with `SKILL.md` and optional `references/`, `scripts/`, and `assets/` files, rejects traversal, collisions, symlinks, encryption, ZIP64, multi-disk archives, and oversized or excessive compression entries, and passes validated bytes and modes into the normal proposal flow. Uploads do not publish anything.

## Validation boundary

Before a proposal exists, the manager recomputes the plan from the pinned source
commit and runs the application checks:

- add/update: input shape, source paths and modes, resource size/UTF-8 bounds,
  import normalization, provenance and routing conflicts, and description or
  trigger overlap warnings;
- removal: the complete candidate catalog (registry and provenance coverage,
  skill frontmatter, generated interface metadata, routing metadata and global
  alias ownership, trigger-case coverage, and reference integrity), plus the
  removal planner's generator-entry checks and dangling-reference checks.

A removal with any error stays blocked before a branch or GitHub write. These
checks are provisional for add/update, and local validation is not the merge
gate for any proposal.

Before merge, `egawilldoit/skills` CI checks the exact PR head and a synthetic
merge result. Both jobs run the repository's Python gates:
`validate_plugin_manifest.py`, `validate_catalog.py`,
`sync_openai_yaml.py --check`, `sync_operating_contract.py --check`,
`routing_audit.py`, `trigger_audit.py`, `validate_ega_metadata.py`, the Python
unit suite, and `git diff --check`. `main` requires both
`validate-head (exact PR head)` and `validate-merge (synthetic merge result)`,
so an invalid or unsupported removal cannot merge even if the application
preview accepted it.

Application validation deliberately does not reimplement the Python generators.
Generated-file equivalence remains a source-CI gate, while the application
blocks the cases it can establish from the pinned snapshot. Neither path
publishes a release.
