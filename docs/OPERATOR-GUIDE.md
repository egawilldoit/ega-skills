# EGA Skills V1.0.1 — Operator Guide

> HISTORICAL GUIDE (V1.0.1). For the 2.0 release, use
> `docs/operations/RELEASE-2.0-RUNBOOK.md` and
> `docs/RELEASE-NOTES-2.0.0.md`.

Local-first registry + deterministic resolver for coding-agent skills.
This guide covers shipped V1.0.1 behavior only (V1.0.0 + patch fixes;
see docs/RELEASE-NOTES-1.0.1.md).

## 1. Install

Prerequisites: Node.js 24 LTS, pnpm 10.

```sh
git clone https://github.com/egawilldoit/ega-skills && cd ega-skills
git checkout v1.0.1
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/ega-skills.mjs --version   # 1.0.1
```

No public package publication in V1; the version-stamped tree is the
distribution unit. Verify with `pnpm test` (reference count in
docs/RELEASE-NOTES-1.0.1.md).

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
node packages/cli/bin/ega-skills.mjs lock [<project-dir>]   # initial lock creation
node packages/cli/bin/ega-skills.mjs lock --refresh [<project-dir>]  # regenerate + diff
```

- `.egaskills.yaml` — routing policy (namespaces allow/deny, skills
  allow/deny/prefer, budgets, locking requirement).
- `.egaskills.lock` — freezes exact eligible versions (`config_hash` +
  per-skill `version_hash`, estimator `ega-o200k-v1`).
- An empty `skills: {}` lock is a VALID active lock (freezes to nothing).
- Locked projects ignore unrelated later imports until an explicit refresh;
  refresh computes exact +/-/~ diffs and fails closed on corruption.
- `lock` refuses when a lock already exists (use `--refresh`); symlinked
  lock paths are rejected, never followed; writes are atomic (temp +
  rename), so a failed run leaves the previous lock byte-unchanged.
- Full flow with no hand-editing: `init` → `lock` → `resolve`.
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
Supporting files (`references/`, other TEXT companions) are retrievable
through `get_content` with `file_path` (exact manifest path, L2-only);
scripts, assets, binaries, and control files are never served.

`list` is the operator/registry view and prints `skill_id` plus
`current_version_hash`. It is unchanged by the human catalog work.

## 7a. Catalog (human discovery)

```sh
node packages/cli/bin/ega-skills.mjs catalog
node packages/cli/bin/ega-skills.mjs catalog --search "review PR"
node packages/cli/bin/ega-skills.mjs catalog --json
```

- `catalog` is the **human** view, grouped by intent; `list` is the **operator**
  view. They read the same release.
- `--search` reuses the registry's existing FTS `search` against the same
  release-scoped FTS table the hosted runtime uses. It adds no independent
  ranking or similarity algorithm.
- Presentation grouping comes from `catalog/presentation.yaml`, resolved in this
  order: `--presentation`, `EGA_CATALOG_PRESENTATION`, `./catalog/presentation.yaml`,
  then the path shipped with the installed package.
- Presentation metadata is non-authoritative. It may not contain `triggers`,
  `anti_triggers`, `domains`, `platforms`, `frameworks`, or `aliases`; the loader
  rejects those keys. Regrouping the catalog cannot change routing.
- Any skill id in the presentation file that is absent from the release is a hard
  failure, not a silent skip.

Real captured output:

```console
$ ega-skills catalog --search "release certification"
Matches for "release certification"

  certify-release            Certify a release against three separate gates, CODE, RUNTIME, and PRODUCT, and report the highest gate actually reached as CODE_READY,…  [Release]
  certify-pr-head            Verify that acceptance evidence belongs to the exact current head of a pull request.  [Release]
  trace-artifact-provenance  Establish immutable lineage from source commit to build to artifact to digest to release to deployment, and emit a provenance manifest…  [Release]
  certify-mcp-production     Certify a production MCP server end to end: endpoint, protocol negotiation, OAuth, tool discovery, tool schemas, permission and profile…  [Release]
  deliver-software           Route non-trivial engineering work to the right workflow instead of improvising.  [Not sure which skill?]
```

The bracketed group is the human-intent category from
`catalog/presentation.yaml`. Browsing the full catalog:

```console
$ ega-skills catalog | head -8
EGA SKILLS
release sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77
114 skills in 4 namespaces

Not sure which skill?
  deliver-software                              Route non-trivial engineering work to the right workflow instead of improvising.
  ask-matt                                      Ask which skill or flow fits your situation.
```

### Scope note: natural-language input is not a CLI feature

`ega-skills` does **not** accept a natural-language task as a bare argument; it
takes explicit subcommands (`resolve --task "..."`, `catalog --search "..."`).
Describing intent in plain language is an MCP host/client behaviour, driven
through the four MCP tools, not a shell feature:

```console
$ ega-skills "what skills do I have"
Unknown command or option: what skills do I have
Run "ega-skills --help" for usage.
```

When routing returns LOW, MCP `resolve` returns the candidates as suggestions
with `selected=[]` (SPEC-004 §5.1.17 rule 4). The host presents them; it does not
execute them:

```text
resolve(task) -> confidence: LOW, selected: []

  candidates (suggestions only, nothing executed):
    1. recover-work-context   Reconstruct the current state of ongoing work so it can be resumed…
    2. what-did-i-get-done    Summarize authored commits over a requested time window…

  the host must ask the user which to use; it must NOT auto-run candidate 1.
```

## 7b. Regenerating and checking the generated catalog

```sh
pnpm generate:catalog   # rewrite docs/generated/SKILL-CATALOG.md
pnpm catalog:check     # exit 1 when the committed file is stale
pnpm eval:discovery    # routing + discovery quality report
```

`catalog:check` runs in CI and in `release:verify`, so a catalog that no longer
matches its release fails the build. Generation is deterministic: the same
release and presentation file always produce byte-identical output.

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
- docs/RELEASE-NOTES-1.0.0.md — V1.0.0 release notes.
- docs/RELEASE-NOTES-1.0.1.md — V1.0.1 patch notes (this release).
