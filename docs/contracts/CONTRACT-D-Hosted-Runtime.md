# Contract D — Hosted Personal EGA v1

Status: frozen for the 1.2 implementation candidate.

This contract defines the read-only hosted runtime over immutable 1.1
HubRelease artifacts. It does not authorize Hub mutation, source fetching,
release publication, ProjectContext publication, or multi-user behavior.

## 1. Runtime authority

The runtime serves exactly one verified personal HubRelease snapshot at a
time. Startup MUST verify the HubRelease envelope and semantic bindings, the
release-specific SQLite artifact digest, SQLite integrity, the embedded
release identity, the search contract, index-row identity, required content
blobs, and the emergency-deny policy before readiness. A failed check keeps the
service unhealthy and MUST NOT expose a partially verified snapshot.

The runtime has read-only credentials. It MUST NOT publish releases, advance a
stable pointer, write Git, mutate Hub content, or expose control-plane
mutation tools.

## 2. MCP surface

The hosted MCP surface contains exactly these four tools:

- `search`
- `resolve`
- `inspect`
- `get_content`

Unknown tools and malformed requests fail with structured errors. Request and
response bodies are bounded, request/tool execution has a timeout, concurrent
requests are bounded, and connection count is bounded. The HTTP transport
validates `Origin` against its configured allow-list and does not treat a
missing or untrusted Origin as authorized browser access.

## 3. Scope and release pinning

`search` and `resolve` without an explicit release or context resolve the
personal stable pointer exactly once, pin that immutable release for the
request, and return `effective_release_digest`. No later operation in the
request performs an implicit second stable-pointer lookup.

`inspect` and `get_content` require `release_digest` or `context_id`. A
`project_path` field is rejected. A supplied release digest MUST identify the
verified release selected for the request. A context is reserved for Contract
E; until then, a context request returns the deterministic context-not-
available error and never falls back to personal mode.

If both `context_id` and `release_digest` are supplied, they MUST resolve to
the same exact release. Invalid, missing, revoked, or unauthorized contexts
fail explicitly; they MUST NOT be replaced by another context or release.

## 4. Authentication and authorization

Authentication is mandatory for every hosted tool. Bearer/OAuth validation
MUST verify issuer, audience/resource, signature, expiry, not-before, required
scope, and supported revocation state. Authentication failures are sanitized.
Access tokens, refresh tokens, authorization codes, client secrets, and source
credentials MUST never be logged or persisted in runtime artifacts.

Every tool authorizes independently before search, resolution, metadata, or
content retrieval. Personal authorization resolves:

`authenticated subject → personal workspace → allowed Hub → exact release →
SkillVersion/blob`

Knowledge of a release, SkillVersion, or blob digest is only an identifier and
never a capability. Emergency denies are checked before cache delivery and
before content retrieval. A denied HubRelease, SkillVersion, source, or blob
fails explicitly; the runtime never silently substitutes another identity.

## 5. Cache and observability rules

Caching is optional. If used, the cache identity MUST include every input that
can affect behavior, including personal workspace, release/context, router and
search contracts, task/query, explicit skill selection, budget overrides,
policy digest, and any fingerprint digest. Authorization and emergency-deny
checks occur before returning a cached result.

Operational records may contain request ID, authenticated subject ID,
workspace ID, effective release/context, tool, latency, result/error class,
rate-limit result, and authorization decision class. They MUST NOT contain
tokens, secrets, private skill bodies, or full task prompts by default.

## 6. Error contract

Errors are structured and deterministic. The v1 classes include authentication
required, token invalid, scope denied, unauthorized, release/context mismatch,
context unavailable/revoked, content revoked, snapshot invalid, runtime
unavailable, request/tool timeout, request/response too large, concurrency
limit, and Origin rejection. Unauthorized private-resource errors MUST NOT
unnecessarily disclose resource existence.

## 7. Contract D boundary

This contract does not define Projects, ProjectContexts, remote locks,
fingerprints, context publication/revocation, workspace sharing, RBAC,
multi-user visibility, quotas, audit policy, or source credential management.
Those semantics require Contract E or Contract F and are not started by this
freeze.
