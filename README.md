# EGA Skills

EGA Skills is a local-first registry and deterministic resolver for coding-agent
skills. It imports portable Agent Skills into immutable local storage, selects a
small relevant set for a repository/task, and exposes them through a read-only
local MCP for Codex and OpenCode/T3.

Current state:

- **Shipped:** V1.0.0 + patch V1.0.1 (`v1.0.1`, `1.0.1` across root + packages).
- **Implemented:** schema validation, canonical hashing, SQLite registry/cache,
  FTS5 search, deterministic router, project config/locks, four-tool MCP,
  `init` → `lock` → `resolve` CLI workflow, Codex + OpenCode E2E.
- **Contract:** the V1 behavioral contract is frozen under `docs/specs/`.

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

Supporting TEXT companions (for example `references/*.md`) are retrievable
through `get_content` with an exact `file_path` (L2-only); scripts, assets,
binaries, and control files are never served (see `OPERATOR-GUIDE.md` §7
and SPEC-006).

## Shipped V1.0.1 runtime

V1.0.0 shipped the complete local-first runtime. V1.0.1 is a patch over V1.0.0:
no architecture change, no new tools, no LLM routing. It fixes three real-user
defects (third-party frontmatter compat, exact companion access, fresh-project
lock UX). See [`docs/RELEASE-NOTES-1.0.1.md`](docs/RELEASE-NOTES-1.0.1.md).

What exists in `packages/`:

- `schema` — SPEC-001 validation, `ega.yaml` routing normalization,
  L0/L1/L2 metadata and size rules, `ega-o200k-v1` token estimator.
- `hashing` — SPEC-002 canonical text/binary handling, safe traversal,
  canonical enumeration, SkillVersion manifest, JCS + SHA-256 identities.
- `registry` — SPEC-003 SQLite schema/home lifecycle, content-addressed cache,
  transactional importer, alias ownership, versions/sources/token records,
  deterministic FTS5 search.
- `router` — SPEC-004 fingerprint detectors, monorepo isolation, explicit and
  automatic resolution, tiers/evidence/tie-breaks, redundancy suppression,
  content-level and token-budget composition, confidence/reasons, resolver CLI.
- `project` — SPEC-005 effective project path, `ProjectConfigV1` schema and
  `init`, config hash + lockfile validation, eligible-catalog generation and
  `lock --refresh`, empty/optional-lock semantics, resolver policy integration.
- `mcp` — SPEC-006 `serveStdio` server, project realpath/offline/read-only
  boundaries, exactly four tools (`resolve`, `search`, `inspect`,
  `get_content`), tool metadata and structured-output contracts.
- `cli` — `import`, `list`, `inspect`, `init`, `lock`, `lock --refresh`,
  `resolve`; thin surfaces over the registry/router/project pipelines.

## Project configuration

Projects are configured with two files:

- `.egaskills.yaml` — project routing/policy (namespaces, skills, budgets,
  locking requirement).
- `.egaskills.lock` — freezes the exact eligible SkillVersions for the project.

The config defines policy; the lock freezes eligible versions. Unrelated future
imports do not silently change a locked project's behavior — new skills enter
only through explicit lock refresh. Fresh projects run
`init` → `lock` → `resolve` with no hand-editing. Both files are designed to be
committed to the project repository. Details live in SPEC-005, not here:

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

Shipped implementation stack (pinned; install with `pnpm install --frozen-lockfile`):

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
docs/         operator guide, release notes, corpus + evidence records
packages/     shipped modular-monolith TypeScript implementation
fixtures/     frozen fixture trees for hashing/projects/skills
tests/        token vectors, router goldens, integration/client tests
scripts/specs/  spec-drift checker
.github/      issue/PR templates with mandatory spec-contract sections
```

`packages/` contains shipped V1.0.1 product behavior behind strict composite
project references and real root `build` / `typecheck` / `test` /
`specs:check` scripts.

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

## Shipped evidence

- Operator workflow: [`docs/OPERATOR-GUIDE.md`](docs/OPERATOR-GUIDE.md)
  (install, home lifecycle, import rules, `init` → `lock` → `resolve`,
  Codex/OpenCode MCP setup, four-tool reference).
- Release: [`docs/RELEASE-NOTES-1.0.1.md`](docs/RELEASE-NOTES-1.0.1.md)
  (V1.0.1 patch scope, 624 pass / 0 fail reference, Ubuntu + Windows CI,
  real-client proofs).
- Post-release validation:
  [`docs/evidence/V1.0.1-REAL-E2E-2026-09-06.md`](docs/evidence/V1.0.1-REAL-E2E-2026-09-06.md)
  (fresh `v1.0.1` checkout, 37/37 third-party import, lock workflow,
  routing, source-removal persistence, OpenCode MCP session).
- Corpus basis: [`docs/V1-CORPUS.md`](docs/V1-CORPUS.md) plus
  [`docs/V1-CORPUS.manifest.json`](docs/V1-CORPUS.manifest.json).

## Current status

| Item | State |
| ---- | ----- |
| Architecture | frozen |
| V1 specifications (SPEC-001–006) | complete |
| Amendment review (AMEND-01–10) | complete |
| TEST-001 42-case corpus (G001–G042) | frozen |
| TEST-002 token vectors (T001–T009, `ega-o200k-v1`) | frozen |
| Product implementation (schema/hashing/registry/router/project/mcp/cli) | shipped in V1.0.0, patched in V1.0.1 |
| Real corpus + hardening + acceptance (W8–W9, EGA-598–604) | complete |
| V1.0.1 release (`v1.0.1`) + operator docs + post-release E2E (EGA-614–618) | complete |
| Final Post-V1 Release Specification (1.1 → 1.2 → 1.3 → 2.0) | merged for review; implementation not started |

## Post-V1 direction

The next milestones are defined (not implemented) in
[`docs/EGA Skills — Final Post-V1 Release Specification.md`](docs/EGA%20Skills%20—%20Final%20Post-V1%20Release%20Specification.md):

```text
1.1 — Skill Hub (curated immutable catalog + reproducible releases)
1.2 — Hosted Personal EGA (authenticated remote MCP, same four tools)
1.3 — Remote Projects (immutable project contexts, remote lock plans)
2.0 — Multi-user EGA (workspaces, authorization, audit/revocation/quotas)
```

Implementation gate: freeze Contracts A–C before any 1.1 code, then Contract D
before 1.2, Contract E before 1.3, and Contract F before 2.0. Local stdio and
offline operation remain supported alongside hosted operation.

Detailed execution tickets are managed in Linear.

## Development rules

Contributors start at [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

- Every behavioral PR cites the relevant SPEC/TEST
  (`SPEC-00X §...`, TEST-001 scenario IDs, TEST-002 vector IDs).
- Run `pnpm specs:check` — it must pass.
- Run `git diff --check` — it must be clean.
- Do not modify frozen behavior only in code: amend the spec and its tests
  first, then change behavior.
- Linux + Windows remain required gates for determinism-sensitive changes
  (hashing, token vectors, goldens, filesystem/CLI behavior).
