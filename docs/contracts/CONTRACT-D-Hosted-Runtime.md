# Contract D: Hosted Runtime (FREEZE CANDIDATE v1)

**Status:** FREEZE CANDIDATE
**Contract version:** 1
**Milestone gate:** this candidate must pass a dedicated exact-head review, CI,
merge, and freeze record before it becomes repository-authoritative.
**Normative authority:** Final Post-V1 Release Specification §4.2–§4.23 and
`scripts/contracts/examples/contract-d/hosted-runtime.json`.

Frozen vector digest:

```text
sha256:6a0f5a9332cd66f2edf5f9fee22d908c69640da8a09d2a30bfb2893bca476f03
```

Contract D defines the hosted personal EGA boundary. It does not define remote
projects, fingerprints, context publication, multi-user workspaces, or Contract
F. Those are later contracts. The immutable data plane remains the Contract C
`HubRelease`, release-specific SQLite/FTS5 snapshot, and immutable content
blobs.

## §1 Hosted MCP surface

The hosted service uses Node and Streamable HTTP at `/mcp`. It exposes exactly
these four tools and no hosted administrative tool:

```text
resolve  search  inspect  get_content
```

Their local V1 skill arguments remain intact. Hosted schemas add only the
scope fields `release_digest` and `context_id` plus the response fields
`effective_release_digest`, `project_context`, and `fingerprint_status`.
`project_path` is rejected: the server cannot inspect a caller's repository.

## §2 Scope and release pinning

`resolve` and `search` support personal catalog mode. With neither scope field,
the service resolves the stable pointer once, executes against that exact
release, and returns its `effective_release_digest`. `inspect` and
`get_content` require an explicit `release_digest` or `context_id`.

An explicit release is exact. A context is exact. Missing, revoked, or
unauthorized context fails; it never falls back to personal mode. Supplying a
context and a different release digest fails. Context selection is reserved as
the integration boundary for Contract E, but these fail-closed rules already
apply to the field.

Personal responses state `project_context: NONE` and `fingerprint_status: NONE`.
The service never claims project-aware routing in personal mode.

## §3 Authentication and authorization

Authentication is mandatory. OAuth discovery, browser login, MCP
initialization, issuer/audience-resource/signature/expiry/not-before/scope and
revocation validation are part of the acceptance surface. Access tokens,
refresh tokens, authorization codes, and client secrets are never logged.

Every tool independently authorizes the chain:

```text
user → personal workspace → authorized HubRelease → SkillVersion → blob
```

Knowing a digest never grants access. The hosted runtime cannot publish a
release, modify Git or source configuration, modify Hub content, change the
stable pointer, or hold publication credentials.

## §4 Deny, cache, and transport safety

The emergency deny policy is mutable and may deny a HubRelease, SkillVersion,
or source. It is checked before cache delivery and returns `E_CONTENT_DENIED`;
the runtime never substitutes another version.

Cache identity includes workspace, release/context, router and search
contracts, task/query, explicit selections, budgets, policy digest, and
fingerprint digest. Authorization and deny policy are rechecked before serving
a cached result.

HTTPS and Origin allowlisting are mandatory. Contract D freezes the exact
request, response, content, timeout, concurrency, and connection limits in the
executable vector. Malformed requests and limit violations fail closed.

## §5 Startup and recovery

Before readiness, the runtime verifies the HubRelease digest, SQLite artifact,
read-only opening, SQLite integrity, embedded release identity, search
contract, exact index-row identity, required blobs, and emergency deny policy,
in that order. Only then may it report healthy.

Stable/release pointer metadata and authentication/authorization metadata are
backed up. Immutable release storage has a recovery procedure. Restore and
rollback are tested; rollback repoints to a retained immutable release.

## §6 Executable freeze gate

The frozen vector and validator are the contract authority for the details
above:

```bash
node scripts/contracts/validate-contract-d.mjs
node --test tests/contracts/contract-d.test.mjs
```

The validator must print `CONTRACT-D-OK`, exactly four tools, a valid startup
integrity order, and a valid scope matrix. Any fifth tool, weakened limit,
scope fallback, or early readiness is a contract failure.

Contract D does not start 2.0 and does not start Contract F.
