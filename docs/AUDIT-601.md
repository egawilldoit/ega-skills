# EGA-601 security + mutation-surface audit

Four-surface audit with one REAL defect found and fixed at the owning layer.
All other surfaces verified clean with evidence.

## Surface A — traversal / symlink / junction containment: CLEAN

- Frozen suites (traversal, SPEC-002 §5.1.20 escape, control-file symlink
  rejection, malformed-control-files fail closed) green on Linux + Windows.
- No new traversal code in this cycle; no new probes required.

## Surface B — source / registry / cache mutation: ONE DEFECT, FIXED

**Defect:** `resolveSkills` opened the ordinary read-write registry path:
`ensureRegistryHome` materialized the home tree (mkdir ×4) and
`runRegistryMigrations` upgraded stale schemas — during a supposedly
read-only MCP operation (SPEC-006 §5.3). Byte-identity held in practice only
because schemas were current and homes existed.

**Fix (owning layer: registry open):** `openRegistry({ readonly: true })`
- resolves paths WITHOUT mkdir (`resolveRegistryPaths`, pure);
- opens SQLite with `readonly: true` (missing file fails `E_REGISTRY_DB_OPEN`);
- NEVER migrates: version mismatch fails `E_REGISTRY_MIGRATION`;
- FTS/FK probes are temp-schema/pragma only (already file-clean).
- `resolveSkills` (MCP + CLI resolve) now opens capability-read-only.
  Import/refresh keep read-write opens. MCP mapping stays fail-closed
  (`E_REGISTRY_UNAVAILABLE`, already covered).

**Regressions:** `tests/registry/readonly-open.test.mjs` (4 tests):
missing home fails closed with no mkdir; stale schema refused byte-identical;
current-schema resolve works byte-identical; 20-way concurrent storm
byte-identical.

**Second defect (exposed by the fix):** explicit-reference shape validation
lived in `resolveExplicitSkills`, i.e. AFTER the registry open — malformed
requests against a missing/stale registry failed `E_REGISTRY_DB_OPEN` /
`E_REGISTRY_MIGRATION` instead of the frozen `E_RESOLVE_REQUEST_INVALID`.
Fixed by hoisting the pure count/blank checks before any filesystem touch
(identical messages; downstream checks retained). Frozen
`E_RESOLVE_REQUEST_INVALID` suite + x10 determinism (41×10 identical) green.

## Surface C — shell / network / script execution: CLEAN

- Static audit over all `packages/*/src`: zero `child_process`,
  `worker_threads`, `vm`, `http(s)`, `net`, `dgram`, `fetch(`, `eval(`,
  `new Function` (only `messageOf`/`fallback` identifier matches).
- MCP + router packages contain ZERO filesystem writes (all `writeFile` /
  `mkdir` uses live in CLI init/import paths only).
- No SQL writes outside registry/importer (MCP FTS probe is `temp.`-schema).
- Live fixed-binary audit: ZERO socket fds before and after serving.

## Surface D — MCP / project-policy / lock enforcement: CLEAN

- Read-only is now CAPABILITY-enforced on every MCP path: search/inspect/
  get_content via verified `query_only` handles, resolve via SQLite
  `readonly: true` connections. Not convention.
- Live adversarial probe (locked project, task matching non-locked skill):
  `lock: LOCKED`, `selected: []` — no bypass. Tool-level lock/deny suites
  (E_VERSION_NOT_LOCKED, E_SKILL_NOT_FOUND) green.
- Skills/scripts never execute (catalogued only); network never required.

## Secrets hygiene

- Repo-wide + full-history scan for PATs/keys/tokens: clean.
- All temporary credential copies from client-acceptance runs deleted
  (`/tmp/ega595/codex-home`, `/tmp/ega596/fakexdg`, 597 XDG + Codex homes).
  Procedure docs now mandate mktemp + install -m 600 + immediate deletion.

## Residual notes for EGA-602

- `packages/mcp/bin/ega-mcp.mjs` ships WITHOUT the exec bit in git (all
  clients launch via explicit `node <path>`; verified working). Harmless but
  noted: `chmod +x` + commit would make direct execution work.
- CLI `list`/`inspect` still use read-write opens (auto-migrate legacy
  behavior, user-invoked). Only `resolve` was hardened (the flagged path).
