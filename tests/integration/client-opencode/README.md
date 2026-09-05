# EGA Skills × OpenCode/T3 — configuration + acceptance procedure (EGA-596/EGA-597)

SPEC-006 §5.1.11. OpenCode launches the **same** `packages/mcp/bin/ega-mcp.mjs`
binary over local stdio. No fork, no alternate router, no client-specific
registry, no remote URL.

## 1. Configure (EGA-596)

Copy `opencode.json.template` to the project root as `opencode.json` and
replace the three `<ABS-...>` placeholders:

- `<ABS-PATH-TO-NODE>` — `command -v node` (EGA-596 ran `/home/ubuntu/.nvm/versions/node/v24.18.0/bin/node`).
- `<ABS-PATH-TO-CHECKOUT>` — built checkout (`pnpm install --frozen-lockfile && pnpm build`).
- `<ABS-PATH-TO-FIXTURE-ROOT>` — fixture root from step 2 (`<root>/home` holds the registry).

Project-local `opencode.json` merges over the global config, so the EGA
server declaration is hermetic per project; the fixture home
(`EGA_SKILLS_HOME`) keeps acceptance data out of every real project.

Build the deterministic fixture (shared with the Codex procedure):

```sh
node tests/integration/client-codex/fixture.mjs /tmp/ega-opencode-accept
# {"skillId": "ega/contract-probe",
#  "versionHash": "sha256:74e83090de8a7ee2624a1d24d5b298c7d34d8e3c44a7043e56f65ea8d5bca7e0", ...}
```

Verify the resolved configuration (deterministic, no model call):

```sh
cd <proj> && opencode debug config   # mcp.ega-skills: type local, same command, EGA_SKILLS_HOME set
opencode mcp list                     # ✓ ega-skills connected — exactly 1 server
```

EGA-596 live evidence (opencode 1.18.29, 2026-09-05): `debug config`
returned exactly the project-local declaration above; `mcp list` showed
`✓ ega-skills connected`, 1 server.

## 2. Isolate (recommended for acceptance runs)

```sh
export XDG_CONFIG_HOME=/tmp/ega-opencode-accept/fakexdg/config
export XDG_DATA_HOME=/tmp/ega-opencode-accept/fakexdg/data
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
# Reuse YOUR OWN model credential (machine-local only, never commit):
cp ~/.local/share/opencode/auth.json ~/.local/share/opencode/account.json "$XDG_DATA_HOME/"
chmod 600 "$XDG_DATA_HOME/auth.json"
```

This keeps the real `~/.config/opencode` (which may declare unrelated
remote MCPs) and the real data dir untouched. The EGA fixture is never
installed as a native opencode skill.

## 3. Prove parity (EGA-597)

From the fixture project dir, with a cheap pinned model. Pick an id from
`opencode models` (EGA-597 ran `-m opencode/muse-spark-1.3-contributor-free`
in the isolated env; bare `gpt-4o-mini`-style ids are NOT accepted — the
flag needs the full `provider/model` form):

```sh
export VH=sha256:74e83090de8a7ee2624a1d24d5b298c7d34d8e3c44a7043e56f65ea8d5bca7e0
opencode run --format json -m opencode/muse-spark-1.3-contributor-free \
  "List every MCP tool available to you. Reply with ONLY the tool names, one per line."
opencode run --format json -m opencode/muse-spark-1.3-contributor-free \
  "Call the ega-skills resolve tool with task 'codex acceptance probe contract verification'. Reply with ONLY the selected skill ids and confidence."
opencode run --format json -m opencode/muse-spark-1.3-contributor-free \
  "Call the ega-skills search tool with query 'codex acceptance probe'. Reply with ONLY the returned skill ids."
opencode run --format json -m opencode/muse-spark-1.3-contributor-free \
  "Call the ega_skills inspect tool with skill_id 'ega/contract-probe'. Reply with ONLY version_hash and each source observed_at."
opencode run --format json -m opencode/muse-spark-1.3-contributor-free \
  "Call the ega-skills get_content tool with skill_id 'ega/contract-probe', version_hash '$VH', level 'L2', max_tokens 2000. Reply with ONLY the exact text content returned."
```

Parity bar (same values as the Codex run): same 4 tools, same version
hash, same L2 bytes (`sha256(content)` = manifest blob
`sha256:17e4305b…1645`), same lock/policy behavior, offline, no mutation
(see the Codex README `tests/integration/client-codex/README.md` §6–§7
for the socket-audit and hash-compare methods — they are client-independent).

## 4. Automated coverage

- `opencode-smoke.test.mjs` "config template" test: always runs, asserts the
  template is a complete single-server local declaration (no CLI needed).
- "acceptance smoke" test: runs under `EGA_OPENCODE_ACCEPTANCE=1`, asserts
  fixture determinism (frozen `$VH`) plus `tools/list` = exactly the four
  V1 tools from the built binary.
- Live model runs stay manual; summarise transcripts into Linear/PR, never
  commit raw transcripts or credentials.

## 5. Housekeeping

Delete the fake XDG root when done (it contains a copy of your credential).
