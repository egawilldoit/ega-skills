# Source skill manager operations

The manager proposes changes to `egawilldoit/skills` on a dedicated branch. It does not merge source PRs or publish releases. Source PR CI and human review remain required; a PR or passing observed checks does not prove publication.

The editor is disabled unless all three server-only variables are configured:

- `EGA_SOURCE_GITHUB_TOKEN`: a fine-grained token restricted to `egawilldoit/skills`, with repository contents and pull request read/write permissions. Never expose it in browser configuration or client logs.
- `EGA_SOURCE_EDITOR_SUBJECTS`: comma-separated Supabase user UUIDs that are explicitly authorized to manage this GitHub repository. Workspace owner status alone is insufficient.
- `EGA_SOURCE_EDITOR_ORIGIN`: the exact HTTPS console origin, without a trailing slash (HTTP is accepted only for localhost). POST requests must carry this exact Origin.

Supabase caller identity is independently verified on each request. To rotate the GitHub token, create the replacement with the same repository restriction, update the server-side secret using the normal deployment process, verify an authorized editor can read the source index, and revoke the old token. Never put token values into the repository, PRs, tickets, or browser-facing variables. Removing any required setting disables the editor.

A GitHub import is read from a full commit SHA over the GitHub API without the source token. It requires one root license, supported paths, strict source frontmatter, and explicit acceptance of the catalog's `original` normalization. The proposal preserves the pinned origin, attribution, and license; classification does not assert authorship. Executable files under `scripts/` are retained as files and are never executed by the manager. Unsupported metadata or resource paths are refused.

A single SKILL.md or a bounded ZIP archive can be uploaded for an add proposal. The ZIP route accepts one skill directory with `SKILL.md` and optional `references/`, `scripts/`, and `assets/` files, rejects traversal, collisions, symlinks, encryption, ZIP64, multi-disk archives, and oversized or excessive compression entries, and passes validated bytes and modes into the normal proposal flow. Uploads do not publish anything.

Preview diagnostics remain provisional for add and update proposals: the source repository's own validators on the candidate tree and its exact-head and synthetic-merge CI are the final source checks. A removal is different: submission recomputes the plan and validates the complete candidate catalog locally (registry and provenance coverage, skill frontmatter, generated interface metadata, routing metadata and alias uniqueness, trigger-case coverage, and reference integrity). A removal with validation errors or dangling references stays blocked before any GitHub write. Local validation does not replace source CI or human review, and neither creates a release.
