# EGA Skills Hub V1

Local-first, deterministic agent-skill registry and resolver for coding agents.

Given a task, a repository, and a project policy, EGA Skills Hub selects the
**smallest useful set of skills** — normally 1–2, hard max 3 — without loading the
entire skill library into model context.

```text
local skill folders
        ↓
strict import + validation            (SPEC-001)
        ↓
immutable SkillVersions               (SPEC-002 / SPEC-003)
        ↓
SQLite metadata + FTS5                (SPEC-003)
        ↓
SHA-256 content cache                 (SPEC-002 / SPEC-003)
        ↓
project config + eligible-catalog lock (SPEC-005)
        ↓
project fingerprint                   (SPEC-004)
        ↓
deterministic routing                 (SPEC-004, TEST-001)
        ↓
normally 1–2 relevant skills
        ↓
local read-only MCP                   (SPEC-006)
        ↓
Codex + OpenCode/T3
```

## V1 scope

- Single-user, local-first, offline-capable.
- Node.js 24 LTS, TypeScript strict, pnpm workspaces.
- SQLite via `better-sqlite3`, FTS5 (`unicode61 remove_diacritics 1`), SHA-256,
  RFC 8785 JCS (`canonicalize@4.0.0`), token estimator `ega-o200k-v1`
  (`js-tiktoken@1.0.21`, `o200k_base`), Vitest, MCP TypeScript SDK v2 over stdio.
- Immutable versioned skill storage; deterministic project-aware routing;
  eligible-catalog project lockfiles; read-only local MCP with exactly four tools
  (`resolve`, `search`, `inspect`, `get_content`).

## V1 non-goals

Cloud registry, teams/RBAC, marketplace, automatic GitHub skill updates,
embeddings/vector database, LLM router, automatic L1 generation, skill script
execution, web dashboard, remote HTTP MCP, stateful skill activation.

## Normative contract

**`docs/specs/` is the normative V1 behavioral contract.**

| File | Contract |
| ---- | -------- |
| `SPEC-001-Skill-Schema-v1.md` | Canonical skill schema |
| `SPEC-002-Canonical-Hashing.md` | Canonical hashing + immutable version identity |
| `SPEC-003-Local-Registry-and-Cache.md` | Local registry + content cache |
| `SPEC-004-Router-and-Resolution-Contract.md` | Router + resolution contract |
| `SPEC-005-Project-Config-and-Lockfile.md` | Project config + eligible-catalog lockfile |
| `SPEC-006-MCP-Runtime-Contract.md` | Local MCP runtime contract |
| `TEST-001-Router-Golden-Scenarios.md` | Frozen 42-case router golden scenarios |
| `TEST-002-Token-Estimator-Vectors.md` | `ega-o200k-v1` token estimator vectors |

> If implementation reveals a contradiction, update/review the relevant spec and
> tests **before** changing product behavior. Code must never silently become the
> specification (see `CONTRIBUTING.md`).

## Repository layout

```text
packages/   schema | hashing | registry | router | project | mcp | cli  (structure only in W0)
fixtures/   skills | projects | hashes
tests/      tokens | router/golden | integration
scripts/    specs/ (spec-drift checker)
```

Package directories are structure-only until Wave 1+ implementation issues begin
(blocked on EGA-550). Run `pnpm specs:check` to verify spec integrity.
