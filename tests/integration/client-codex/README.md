# EGA Skills × Codex — repeatable acceptance procedure (EGA-595)

SPEC-006 §5.1.10. Proves the **real Codex CLI** discovers and consumes exactly
the four V1 tools served by the **same local stdio binary** every other client
uses — no fork, no remote URL, no network.

## 0. Prerequisites

- Built checkout: `pnpm install --frozen-lockfile && pnpm build`.
- Codex CLI on PATH (`codex --version`; EGA-595 ran CLI 0.150.1).
- A Codex credential for YOUR account (the live run needs model calls).
  Never commit credentials; the fixture paths below are all disposable.

## 1. Build the deterministic fixture

```sh
node tests/integration/client-codex/fixture.mjs /tmp/ega-codex-accept
# {"home": ".../home", "sources": ".../src",
#  "skillId": "ega/contract-probe",
#  "versionHash": "sha256:74e8…7e0", "registry": ".../registry.sqlite"}
```

Record before-state hashes (for the §7 no-mutation check):

```sh
sha256sum <home>/registry.sqlite | tee before.sha
find <home>/cache -type f | sort | xargs sha256sum > before-blobs.sha
```

## 2. Isolate Codex

```sh
export CODEX_HOME=/tmp/ega-codex-accept/codex-home
mkdir -p "$CODEX_HOME"
# Credential: reuse YOUR OWN login non-interactively, e.g.
cp ~/.codex/auth.json "$CODEX_HOME/auth.json" && chmod 600 "$CODEX_HOME/auth.json"
# Register the server (or copy codex-config.template.toml by hand):
codex mcp add ega-skills \
  --env EGA_SKILLS_HOME=<fixture-home> \
  -- "$(command -v node)" <checkout>/packages/mcp/bin/ega-mcp.mjs
printf '\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n' \
  >> "$CODEX_HOME/config.toml"
```

Isolation rules: the EGA fixture skills are NEVER copied to a native
`skills/` directory, and `$CODEX_HOME` is disposable — the real
`~/.codex` config, auth, and skills are untouched (only `auth.json` is
read, never written).

## 3. Smoke + discovery

```sh
cd /tmp/ega-codex-accept && mkdir -p proj && cd proj
codex exec --skip-git-repo-check \
  "Reply with exactly the word ALIVE and nothing else." </dev/null
codex exec --skip-git-repo-check \
  "List every tool available to you, including all MCP tools. \
Reply with ONLY the tool names, one per line, no other text." </dev/null
```

Expect exactly four EGA tools, Codex-prefixed, and no other `ega_skills` entries:

```text
mcp__ega_skills__get_content
mcp__ega_skills__inspect
mcp__ega_skills__resolve
mcp__ega_skills__search
```

## 4. Four-tool proof (JSONL captures raw tool payloads)

Run each with `--json` and keep stdout: `mcp_tool_call` events carry the
raw `result` (structured content + text fallback) Codex actually consumed.

```sh
export VH=sha256:74e83090de8a7ee2624a1d24d5b298c7d34d8e3c44a7043e56f65ea8d5bca7e0
codex exec --json --skip-git-repo-check --approve-for-me \
  "Call the ega_skills resolve tool with task \
'codex acceptance probe contract verification'. Then reply with ONLY the \
selected skill ids and the confidence value from the tool result." \
  </dev/null > evidence-resolve.jsonl
codex exec --json --skip-git-repo-check --approve-for-me \
  "Call the ega_skills search tool with query 'codex acceptance probe'. \
Then reply with ONLY the returned skill ids, one per line." \
  </dev/null > evidence-search.jsonl
codex exec --json --skip-git-repo-check --approve-for-me \
  "Call the ega_skills inspect tool with skill_id 'ega/contract-probe'. \
Then reply with ONLY these fields from the tool result, one per line: \
version_hash, and the observed_at of each source." \
  </dev/null > evidence-inspect.jsonl
codex exec --json --skip-git-repo-check --approve-for-me \
  "Call the ega_skills get_content tool with skill_id 'ega/contract-probe', \
version_hash '$VH', level 'L2', max_tokens 2000. Then reply with ONLY the \
exact text content returned by the tool, nothing else." \
  </dev/null > evidence-content.jsonl
```

Expected (EGA-595 live run, 2026-09-05):

| tool | result |
| --- | --- |
| resolve | selects `ega/contract-probe`, MEDIUM, UNLOCKED/WITHIN_BUDGET, no bodies |
| search | 1 hit: `ega/contract-probe` @ `$VH`, L0 only, no BM25 |
| inspect | `version_hash` = `$VH`, real `observed_at` (import instant, never 1970), no L1/L2 bodies |
| get_content | exact L2 bytes (`CODEX-ACCEPT-4471` marker), tokens 40/2000 |

Byte-exactness: `sha256` of the returned `content` MUST equal the manifest
L2 blob hash (`sha256:17e4305b…1645` for this fixture).

## 5. Approval semantics (observed, CLI 0.150.1)

- Default policy prompts; headless `exec` fails closed ("tool approval
  unavailable/required").
- `approval_policy="never"` does NOT auto-approve: MCP calls fail with
  "MCP tool call requires approval, but approval policy is never".
- `--approve-for-me` routes approvals through automatic review and is the
  supported headless path (read-only tools, disposable fixture).

## 6. Offline evidence

`unshare -n` is blocked in some environments (record it if so). Fallback,
as run for EGA-595:

1. Start the server, find its PID.
2. Assert zero socket fds: `ls -l /proc/<pid>/fd | grep -c socket` → `0`.
3. The frozen EGA-589 boundary tests already assert no network/shell/script
   imports on the MCP runtime path.
4. All four Codex runs above use the local `command` from config.toml —
   no URL, no port.

## 7. No-mutation check

```sh
sha256sum -c before.sha                                  # registry.sqlite: OK
(cd / && sha256sum -c before-blobs.sha)                 # all blobs: OK
```

Every Codex call MUST leave registry, blobs, sources, and project
config/lock byte-identical. (SQLite WAL artefacts: none observed —
`query_only` read path; any future `*-wal`/`*-shm` files are a defect.)

## 8. Read-only follow-up → EGA-601

`resolve` delegates to `resolveSkills`, which opens the ordinary registry
path rather than EGA-589's explicit read-only connection. The live EGA-595
run proves zero byte mutation in practice; EGA-601 must audit whether
read-only is capability-enforced or convention-enforced.

## 9. Housekeeping

- Delete `$CODEX_HOME` (contains a copy of your credential) when done.
- Evidence JSONL files are local run artefacts: summarise them into the
  Linear comment / PR body, never commit raw transcripts or credentials.
