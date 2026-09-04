# EGA Skills

EGA Skills is a local-first registry and deterministic resolver for coding-agent
skills. It imports portable Agent Skills into immutable local storage, selects a
small relevant set for a repository/task, and exposes them through a read-only
local MCP for Codex and OpenCode/T3.

Current state, in three lines:

- **Specified:** the V1 behavioral contract is frozen under `docs/specs/`.
- **Workspace bootstrap implemented:** seven buildable TypeScript package boundaries,
  strict project references, and real root build/typecheck/test scripts exist.
- **Product behavior not started yet:** package entrypoints are intentionally empty;
  no SPEC-001+ business logic exists.

## Problem

A coding agent may have access to dozens or hundreds of skills. Sending every
skill to the model is expensive and noisy. EGA Skills is intended to answer:

> Given this task, repository and project policy, what small trusted instruction
> set should this agent receive?

The product normally recommends only the relevant skill content — typically one
or two skills — rather than loading the whole registry.

## V1 architecture

```text
skill directories
      ↓
strict import + validation
      ↓
immutable SkillVersions
      ↓
SHA-256 content cache
      ↓
SQLite metadata + FTS5
      ↓
project config + lockfile
      ↓
project fingerprint
      ↓
deterministic router
      ↓
normally 1–2 relevant skills
      ↓
read-only local MCP
      ↓
Codex + OpenCode/T3
```

Automatic selection has a hard maximum of 3 under the frozen V1 composition
rules (SPEC-004); 1–2 is the normal case and 3 is exceptional.

## V1 principles

- Local-first; offline after import.
- Deterministic routing: same inputs produce byte-identical meaningful outputs on Linux and Windows.
- Immutable content versions; content-addressed cache.
- Small model context: metadata routes, bodies follow only after selection.
- Project reproducibility through lockfiles.
- No hidden LLM router, no embeddings, no vector database.
- No automatic skill execution: skill scripts are catalogued, never run.
- Read-only MCP runtime.
- Cross-platform deterministic hashing (SHA-256 + RFC 8785 JCS).

## Progressive disclosure

- **L0** — compact discovery metadata: identity, routing sets, token counts,
  size class, L1 status. Used for discovery and routing; never contains
  instruction body text.
- **L1** — optional authored `SKILL.core.md`, the exact canonical full text when
  present. Automatic routing prefers L1 when authored and valid.
- **L2** — full `SKILL.md`, the exact canonical full text including frontmatter.

Full content is retrieved only after a skill has been selected. References,
assets, and scripts are catalogued according to the specs, but V1 does not
execute skill scripts (see SPEC-001, SPEC-006).

## Project configuration

Projects are configured with two files:

- `.egaskills.yaml` — project routing/policy (namespaces, skills, budgets,
  locking requirement).
- `.egaskills.lock` — freezes the exact eligible SkillVersions for the project.

The config defines policy; the lock freezes eligible versions. Unrelated future
imports do not silently change a locked project's behavior — new skills enter
only through explicit lock refresh. Both files are designed to be committed to
the project repository. Details live in SPEC-005, not here:

- [`docs/specs/SPEC-005-Project-Config-and-Lockfile.md`](docs/specs/SPEC-005-Project-Config-and-Lockfile.md)

## MCP

V1 exposes exactly four local MCP tools:

```text
resolve
search
inspect
get_content
```

Runtime properties:

```text
stdio
read-only
offline
project-scoped
no shell execution
no skill script execution
no network requirement after import
```

Target clients:

```text
Codex
OpenCode/T3
```

See [`docs/specs/SPEC-006-MCP-Runtime-Contract.md`](docs/specs/SPEC-006-MCP-Runtime-Contract.md).

## Frozen V1 technology

This is the frozen implementation stack. The TypeScript compiler is present for
the workspace baseline; product/runtime dependency pinning remains Wave 0 work
under EGA-548.

```text
Node.js 24 LTS
TypeScript strict
pnpm workspaces
Zod v4
yaml
better-sqlite3
SQLite FTS5
unicode61 remove_diacritics 1
SHA-256
RFC 8785 JCS
canonicalize@4.0.0
js-tiktoken@1.0.21
o200k_base
Vitest
@modelcontextprotocol/server v2
serveStdio
```

## What is intentionally not in V1

```text
cloud registry
team/RBAC system
marketplace
automatic GitHub updater
embeddings/vector database
LLM-based routing
automatic L1 generation
skill script execution
web dashboard
remote HTTP MCP
```

## Repository structure

```text
docs/specs/   frozen V1 behavioral contract (normative)
packages/     buildable modular-monolith TypeScript package boundaries
fixtures/     frozen fixture trees for hashing/projects/skills (populated by later waves)
tests/        token vectors, router goldens, integration tests (populated by later waves)
scripts/specs/  spec-drift checker (implemented)
.github/      issue/PR templates with mandatory spec-contract sections
```

The package directories (`cli`, `hashing`, `mcp`, `project`, `registry`,
`router`, `schema`) are real TypeScript packages with strict composite configs
and intentionally empty entrypoints. Product behavior remains for later issues.

## Specification authority

`docs/specs/` is the normative V1 behavioral contract.

| File | Contract |
| ---- | -------- |
| [`SPEC-001`](docs/specs/SPEC-001-Skill-Schema-v1.md) | Canonical skill schema |
| [`SPEC-002`](docs/specs/SPEC-002-Canonical-Hashing.md) | Canonical hashing + immutable version identity |
| [`SPEC-003`](docs/specs/SPEC-003-Local-Registry-and-Cache.md) | Local registry + content cache |
| [`SPEC-004`](docs/specs/SPEC-004-Router-and-Resolution-Contract.md) | Router + resolution contract |
| [`SPEC-005`](docs/specs/SPEC-005-Project-Config-and-Lockfile.md) | Project config + eligible-catalog lockfile |
| [`SPEC-006`](docs/specs/SPEC-006-MCP-Runtime-Contract.md) | Local MCP runtime contract |
| [`TEST-001`](docs/specs/TEST-001-Router-Golden-Scenarios.md) | Frozen 42-case router golden scenarios (G001–G042) |
| [`TEST-002`](docs/specs/TEST-002-Token-Estimator-Vectors.md) | `ega-o200k-v1` token estimator vectors (T001–T009) |

If implementation reveals a contradiction, update and review the relevant
specification and tests before changing product behavior. Code must not
silently become the new contract.

## Current status

| Item | State |
| ---- | ----- |
| Architecture | frozen |
| V1 specifications (SPEC-001–006) | complete |
| Amendment review (AMEND-01–06) | complete |
| TEST-001 42-case corpus (G001–G042) | frozen |
| TEST-002 token vectors (T001–T009, `ega-o200k-v1`) | frozen |
| Repository foundation (workspace, checker, templates) | complete |
| Spec drift checker (`pnpm specs:check`) | complete |
| GitHub repository | initialized |
| Product implementation (schema/router/registry/MCP) | not started |
| Wave 0 workspace bootstrap (EGA-547) | implemented on review branch |

Schema, router, registry, and MCP are **not** implemented. Nothing in
`packages/` contains product behavior.

## Implementation roadmap

| Wave | Scope |
| ---- | ----- |
| Wave 0 — Bootstrap | Workspace, strict TS baseline, repo automation |
| Wave 1 — Schema + token estimator | SPEC-001 validation, `ega-o200k-v1` (TEST-002) |
| Wave 2 — Canonical hashing | SPEC-002 hashing + version identity |
| Wave 3 — Registry + cache + importer | SPEC-003 storage, cache, import pipeline |
| Wave 4 — Router + resolve CLI | SPEC-004 routing, TEST-001 goldens, CLI |
| Wave 5 — Project config + lockfile | SPEC-005 config, locks, refresh |
| Wave 6 — MCP runtime + Codex | SPEC-006 server, Codex acceptance |
| Wave 7 — OpenCode/T3 | Second client acceptance |
| Wave 8 — Real corpus + hardening | Real skills, performance gates, edge coverage |
| Wave 9 — V1 release | Docs, release checklist, V1 tag |

Detailed execution tickets are managed in Linear.

## Current next step

The specification gate (EGA-550) is complete. After EGA-547 is reviewed and
merged, Wave 0 continues with dependency/runtime pinning (EGA-548) and the
remaining bootstrap tickets.

## Development rules

Contributors start at [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

- Every behavioral PR cites the relevant SPEC/TEST
  (`SPEC-00X §...`, TEST-001 scenario IDs, TEST-002 vector IDs).
- Run `pnpm specs:check` — it must pass.
- Run `git diff --check` — it must be clean.
- Do not modify frozen behavior only in code: amend the spec and its tests
  first, then change behavior.
- Linux + Windows become required implementation gates (determinism,
  hashing, token vectors, goldens).
