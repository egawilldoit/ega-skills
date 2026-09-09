# Contract E — Remote Projects v1

Status: frozen before 1.3 implementation.

This contract adds remote project contexts to the read-only hosted personal
runtime. It does not define multi-user workspace authorization or shared Hub
visibility; those require Contract F.

## 1. Resource model

The control-plane hierarchy is:

`authenticated subject → workspace → project → ProjectContext`.

A Project may have many contexts. A context is an immutable published
selection of project configuration, lock, release, and optional fingerprint;
there is no mutable `project.current_lock` authority.

## 2. ProjectContext identity

The canonical context artifact binds exactly:

- workspace identity;
- project identity;
- project config digest;
- project lock digest;
- exact HubRelease digest;
- fingerprint digest, or explicit `null` when no fingerprint is configured;
- context contract version.

The artifact uses the repository's canonical envelope/JCS rules. Publication
does not mutate the artifact. Revocation is separate mutable control-plane
state and never substitutes another context.

## 3. Publication and release binding

Context publication reads and validates the local project config and lock,
resolves one exact declared HubRelease, and requires every locked SkillVersion
to exist in that release. It computes the config and lock digests and, when
configured, the bounded package-scoped fingerprint. It does not write project
files.

The initial contract permits only one release per published lock. Cross-release
unions are rejected.

## 4. Remote lock plans

`RemoteLockPlan` is immutable and binds the project config digest, existing lock
digest, exact target HubRelease digest, candidate lock, and deterministic
added/removed/changed sets. Planning never performs a later implicit stable
pointer lookup.

Remote-lock apply writes only the reviewed candidate `.egaskills.lock` locally,
using atomic safe-write semantics. The server never writes the developer
repository.

## 5. Fingerprints and revision provenance

Fingerprints are bounded and package-scoped. They bind the selected package
root, workspace scope, workspace ambiguity, languages, platforms, frameworks,
evidence records, revision evidence, and a relevant-input digest. Absolute
machine paths and arbitrary source contents are excluded.

Revision provenance is one of:

- `git-clean` with an exact commit SHA;
- `git-dirty` with base commit SHA and relevant-input digest;
- `unversioned` with relevant-input digest.

Only fingerprint-relevant inputs contribute to the relevant-input digest.

## 6. Hosted context requests

When `context_id` is supplied, the runtime loads and authorizes that exact
context, its exact release, lock, fingerprint, and policy. Missing, invalid,
unauthorized, or revoked contexts fail explicitly and never fall back to
personal mode. If both `context_id` and `release_digest` are supplied, they
must match exactly.

## 7. Boundary

This contract does not define workspace sharing, roles, public/private Hub
visibility, quotas, audit policy, source credential management, or multi-user
authorization. Those semantics require Contract F.
