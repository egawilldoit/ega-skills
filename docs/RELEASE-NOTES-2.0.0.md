# EGA Skills 2.0.0 release notes

Release candidate identity: `2.0.0` across the root package, every workspace
package, and both MCP server identities. The authoritative candidate identity
remains the final `release/2.0` Git SHA plus the release digest emitted by the
artifact exporter — see `docs/evidence/RELEASE-2.0-FINAL.md`.

This release freezes the MCP-driven skill system: external sources are
acquired, planned, staged, quality-checked, reviewed, applied, optionally
derived, preflighted, previewed, exported, validated, and then served
read-only through EGA MCP to compatible clients. The EGA Hub remains
authoritative for source provenance, skill identity, skill version, approval,
release identity, artifact identity, and historical versions.

## What 2.0 delivers

- **Governed intake.** Acquisition, deterministic planning, staged adoption,
  quality evaluation, review batches, and append-only approvals are separate
  governed steps with exact identities; publication requires the exact
  approved candidate.
- **Source provenance.** Every imported skill records its upstream source and
  observed revision; vendored snapshots are hashed and replayable.
- **Deterministic plan identity.** Same inputs produce identical plan,
  snapshot, tree, version, and plan digests; registry writes are
  transactional.
- **Quality checks.** Deterministic quality evaluation gates publication and
  refuses ambiguous or unsafe candidates.
- **Append-only approvals and exact approval enforcement.** Stale approvals,
  stale previews, and mismatched approval-set digests are rejected.
- **Transactional adoption.** Apply is all-or-nothing with crash recovery at
  every durable barrier; the upstream checkout bytes are never mutated.
- **Owned derivatives.** Derivative intake preserves original input digests,
  owned target identity, and provenance/license lineage; tampering is
  rejected.
- **Immutable releases.** Export produces one immutable, validated release
  artifact (`hub-release.json`, `release-package.json`, `registry.sqlite`,
  blobs) tied to the exact approved revision.
- **Artifact validation.** Exported artifacts are verified before serving;
  missing blobs, wrong hashes, wrong release digests, and extra skills fail
  closed.
- **Retained releases with rollback.** Promotion, rollback, CAS, concurrent
  one-winner behavior, interrupted-write recovery, retry idempotency, and
  historical pinned selection are covered.
- **MCP read-only serving.** Exactly four tools — `resolve`, `search`,
  `inspect`, `get_content` — served from the immutable artifact only; the
  runtime mutates nothing, and protected control-plane files such as
  `hub-release.json` are never skill content.
- **Legacy MCP support.** `initialize`-based sessions, HTTP and stdio, all
  four tools.
- **Modern MCP support (2026-07-28).** `server/discover` sessions with no
  `initialize`, HTTP and stdio, same four tools, same product results as
  legacy; auto-negotiation selects modern when the client requires it.
- **OAuth hosted access.** RFC 9728 protected-resource metadata, anonymous
  challenge, authorization-code + PKCE, refresh, exact issuer/audience
  binding, first-party token rejection, hostile-Origin rejection, and RLS
  isolation; credentials never appear in logs.
- **Codex support.** Real Codex client connects to the hosted MCP over
  Streamable HTTP with OAuth, discovers exactly four EGA tools, and observes
  the same skill identity, version hash, and content digest across processes
  and restarts.
- **OpenCode support.** Real OpenCode client connects to the hosted MCP with
  OAuth, discovers exactly four EGA tools, and observes the same skill
  identity, version hash, and content digest as Codex and the direct MCP
  probe.

## Supported protocol eras

- Legacy MCP sessions (initialize) — supported on HTTP and stdio.
- Modern MCP `2026-07-28` sessions (`server/discover`) — supported on HTTP
  and stdio, proven by SDK-level acceptance.
- Client-tooling note: the OpenCode 1.18.32 client negotiates the newest
  revision its bundled SDK supports (`2025-11-25`); it has no configuration
  surface to require `2026-07-28`. That client limitation is recorded in the
  evidence ledger; the server modern era is verified independently.

## Explicit exclusions (post-2.0)

Not implemented in 2.0, by design:

- native `.agents/skills`, `.claude/skills`, `.opencode/skills` installation
- cross-machine native skill sync
- skill marketplace, ratings, catalog UI
- AI Skill Doctor / automatic skill rewriting
- billing and team features

## Compatibility

- Node 24 (repo pins `engines.node = 24`, `.nvmrc = 24`).
- pnpm 10.0.0 (`packageManager = pnpm@10.0.0`).
- Vercel Node runtime for the hosted MCP (`packages/mcp`, `server.mts`).
- Supabase Auth OAuth 2.1 as the hosted authorization server.

## Verification

`pnpm release:verify` runs every deterministic, credential-free release gate
as named stages: frozen lockfile, lockfile cleanliness, build, typecheck,
frozen specs, Contracts A/B/C/G, version consistency, registry performance,
token vectors, lifecycle termination regression, the full bounded test
suite, publication and derivative E2E, retained serving, OAuth offline
tests, artifact validation, and `git diff --check`.

Hosted, OAuth, client, and deployment evidence is recorded in
`docs/evidence/2.0-C-STAGING.md` and summarized in
`docs/evidence/RELEASE-2.0-FINAL.md`. Operate it with
`docs/operations/RELEASE-2.0-RUNBOOK.md`.
