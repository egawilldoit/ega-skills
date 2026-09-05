# EGA Skills V1.0.0 — Operator Guide

Local-first registry + deterministic resolver for coding-agent skills.
This guide covers shipped V1 behavior only.

## 1. Install

Prerequisites: Node.js 24 LTS, pnpm 10.

```sh
git clone https://github.com/egawilldoit/ega-skills && cd ega-skills
git checkout v1.0.0
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/ega-skills.mjs --version   # 1.0.0
```

No public package publication in V1; the version-stamped tree is the
distribution unit. Verify with `pnpm test` (592 pass / 0 fail reference).

## 2. Home directory

`EGA_SKILLS_HOME` (default `~/.ega-skills`) holds `registry.sqlite`,
`cache/sha256/`, `logs/`, `config/`. Back up `registry.sqlite` to snapshot
state. The home is created on first read-write use; read-only flows
(resolve, MCP tools) never create it.

## 3. Import skills

```sh
node packages/cli/bin/ega-skills.mjs import <skills-root> --namespace <ns>
```

Rules (SPEC-001, enforced, not warnings):

- Each skill is a directory containing `SKILL.md` with `name:` +
  `description:` frontmatter (description ≤ 1024 code points). Optional
  portable fields per SPEC-001 §5.1.6: `license`, `compatibility`,
  `metadata`, `allowed-tools`. UNKNOWN fields (e.g. `version:`) are
  rejected, never silently dropped.
- Directory name MUST equal the skill name; canonical ID is `<ns>/<name>`.
- `SKILL.core.md` (L1) and `ega.yaml` (routing metadata) are optional.
- Import is deterministic: same bytes + namespace → same version hashes.
- 4 of 70 evaluated real skills are correctly rejected (see
  docs/V1-CORPUS.md); never edit third-party source to force acceptance.

## 4. Namespaces and IDs

Canonical IDs (`namespace/name`, portable lowercase-hyphen) are immutable
per version; content versions are SHA-256 addressed. Aliases exist but bare
names/aliases are rejected at strict boundaries (use canonical IDs).

## 5. Project config, lock, refresh

In your project root:

```sh
node packages/cli/bin/ega-skills.mjs init [<project-dir>]   # directory must exist
```

- `.egaskills.yaml` — routing policy (namespaces allow/deny, skills
  allow/deny/prefer, budgets, locking requirement).
- `.egaskills.lock` — freezes exact eligible versions (`config_hash` +
  per-skill `version_hash`, estimator `ega-o200k-v1`).
- An empty `skills: {}` lock is a VALID active lock (freezes to nothing).
- Locked projects ignore unrelated later imports until an explicit refresh;
  refresh computes exact +/-/~ diffs and fails closed on corruption.
- Commit both files with your project.

## 6. Resolve (CLI)

```sh
node packages/cli/bin/ega-skills.mjs resolve --project <path> \
  --task "<task>" [--explicit <id>] [--max-skills 1-3] [--max-tokens N]
```

- Suggest mode: LOW confidence selects nothing (correct conservatism);
  MEDIUM+ selects up to 3 (normally 1–2).
- Automatic selection caps at 3 skills; per-call token budgets are exact
  (over-budget content errors, never truncates).
- Output is machine JSON on stdout; errors go to stderr (empty stdout).

## 7. List / inspect

```sh
node packages/cli/bin/ega-skills.mjs list
node packages/cli/bin/ega-skills.mjs inspect <canonical-id>
```

Metadata only — instruction bodies come exclusively from `get_content`
after selection (progressive disclosure: L0 routes, L1/L2 follow).

## 8. Codex MCP setup

Same local binary over stdio; full repeatable procedure (isolated config,
credential handling, approval semantics, evidence capture) lives in
`tests/integration/client-codex/README.md`. Essentials:

```toml
[mcp_servers.ega-skills]
command = ["<node>", "<checkout>/packages/mcp/bin/ega-mcp.mjs"]
[mcp_servers.ega-skills.env]
EGA_SKILLS_HOME = "<home>"
```

Run headless sessions with `--approve-for-me` (`approval_policy="never"`
BLOCKS MCP calls in Codex — observed behavior, not a bug).

## 9. OpenCode / T3 MCP setup

Project-local `opencode.json` (template:
`tests/integration/client-opencode/opencode.json.template`):

```json
{"mcp": {"ega-skills": {
  "type": "local",
  "command": ["<node>", "<checkout>/packages/mcp/bin/ega-mcp.mjs"],
  "environment": {"EGA_SKILLS_HOME": "<home>"},
  "enabled": true}}}
```

On Windows write paths with forward slashes or escaped backslashes.
Full procedure (isolation via XDG dirs, model flag form, parity bar) lives
in `tests/integration/client-opencode/README.md`.

## 10. MCP tools reference

Exactly four tools, project-scoped, read-only, offline:

| tool | input | returns |
| --- | --- | --- |
| resolve | task, project_path?, explicit_skills?, max_skills?, max_tokens? | selected/candidates/rejected, confidence, tiers, token + lock + budget status. NEVER bodies. |
| search | query, project_path?, limit? (default 10, max 20) | L0 rows with skill_id + version_hash. No bodies, no BM25. |
| inspect | skill_id, project_path?, version_hash? | identity, L0/routing/manifest/provenance/tokens, per-source observed_at. No bodies. |
| get_content | skill_id, version_hash, level, max_tokens, file_path?, project_path? | EXACT requested bytes (level body, or ONE exact TEXT companion via file_path, L2-only: file_path with L1 is E_MCP_INPUT_INVALID) or a frozen error. No fallback/truncation/substitution. |

Text fallbacks are self-sufficient (some clients never forward
structuredContent): search/inspect carry ids/hashes/instants;
get_content text is summary + exact body within its per-call budget.

## 11. Offline behavior

After import, everything works with zero network: the server holds no
sockets (audited), imports never fetch, the tokenizer initializes offline.
`unshare -n` isolation is env-blocked in some VMs; socket audit + frozen
no-network suites cover the same property.

## 12. Security model

- Read-only by capability: MCP search/inspect/get_content use verified
  `query_only` handles; resolve uses SQLite `readonly: true` connections
  (no mkdir, no migrations — stale schemas fail closed).
- No skill/script/shell/network execution anywhere in production code
  (audited; test harnesses only spawn the server over stdio).
- Path traversal contained (realpath + jail checks); control-file symlinks
  rejected; malformed control files fail closed.
- Locks cannot be silently bypassed (explicit refresh-gating; tool-level
  E_VERSION_NOT_LOCKED / E_SKILL_NOT_FOUND).
- Full audit: docs/AUDIT-601.md. Credential handling for acceptance runs:
  private temp roots + restrictive modes + immediate deletion (see client
  READMEs); repo + history secret-scanned clean at release.

## 13. Known V1 limitations

- Partial-name ranking: a task mentioning one token of a hyphenated skill
  name gets no NAME-tier boost; BM25 IDF decides among tier-C candidates
  (observed once in 12 eval tasks; conservative LOW output, right answer
  adjacent). See docs/EVAL-599.md.
- `packages/mcp/bin/ega-mcp.mjs` ships without the exec bit; launch via
  explicit `node <path>` (all documented configs do).
- Windows reference performance is CI-observational (noisy runners);
  correctness is fully gated on both OSes.
- No cloud registry, RBAC, marketplace, embeddings, LLM routing, script
  execution, web dashboard, or remote HTTP MCP (intentionally not in V1).
- GitHub branch protection: PR-required + no-force-push + thread-resolution
  enforced via ruleset; required-status-checks could not be applied through
  the API — CI gating is process-enforced (every merge had fresh exact-head
  Ubuntu + Windows), admin may add the check rule.

## 14. Further evidence

- docs/ACCEPTANCE-602.md — 18/18 release checkboxes with pointers.
- docs/V1-CORPUS.md — 70-skill real corpus record + manifest.
- docs/EVAL-599.md — 12 real-task evaluation.
- docs/PLATFORM-600.md — platform/offline/performance evidence.
- docs/RELEASE-NOTES-1.0.0.md — release notes.
