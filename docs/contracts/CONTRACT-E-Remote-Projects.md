# Contract E: Remote Projects (FREEZE CANDIDATE v1)

**Status:** FREEZE CANDIDATE
**Contract version:** 1
**Milestone gate:** this candidate must pass a dedicated exact-head review, CI,
merge, and freeze record before it becomes repository-authoritative.
**Normative authority:** Final Post-V1 Release Specification §5.1–§5.29 and
`scripts/contracts/examples/contract-e/remote-projects.json`.

Frozen vector digest:

```text
sha256:e4a56b717e01e3edc4d571ae7b839757344b0a94953127482390a6f6e39318ac
```

Contract E introduces immutable project-scoped hosted behavior:

```text
Workspace → Project → ProjectContext
```

It does not start Contract F or release 2.0. Multi-user authorization remains
outside this contract.

## §1 Local authority

`.egaskills.yaml` and `.egaskills.lock` remain the local project authorities.
Remote state never silently changes them. Existing `ega-skills lock --refresh`
continues to mean local registry refresh. A reviewed remote-lock apply is an
explicit operation and writes only the local lock file.

## §2 Context identity

An immutable context artifact contains exactly:

```text
workspace_id
project_id
config_digest
lock_digest
release_digest
fingerprint_digest/null
context_contract_version
```

Its own `context_digest` is SHA-256 over the RFC 8785 JCS artifact. Config and
lock digests are respectively the JCS identities of the normalized config and
validated normalized lock. Initial 1.3 contexts bind every lock entry to one
exact HubRelease; cross-release union and fallback are rejected.

## §3 Remote lock planning

`RemoteLockPlan` is immutable and binds the project/config, existing lock,
target release, candidate lock, added/removed/changed entries, and optional
fingerprint digest. Applying it requires explicit review and writes only the
local lock. The control plane never mutates project files during planning or
context publication.

## §4 Fingerprints

Fingerprints select one nearest package scope. Roots and evidence paths are
repository-relative POSIX paths or null; absolute machine paths are invalid.
Evidence is bounded manifest/tooling evidence and never requires uploading
arbitrary application source. Arrays are sorted and unique. Revision provenance
is explicit: `git-clean` has a commit SHA, `git-dirty` has a base commit SHA and
relevant-input digest, and `unversioned` has a relevant-input digest. The
relevant-input digest covers only the bounded repository-relative inputs that
affected the fingerprint.

## §5 Hosted selection and lifecycle

Every hosted tool may select a `context_id`. Selection binds the exact config,
lock, release, fingerprint, and policy. Missing, revoked, or release-mismatched
contexts return their frozen errors and never fall back or silently substitute.
Publication creates an immutable context; old contexts remain retained.
Revocation marks an identity revoked without mutating the artifact, and a
republished project receives a new context identity.

Cache identity includes workspace/project/context, all four artifact digests,
router/search contracts, task/query, explicit selections, and budgets.
Authorization and revocation are rechecked before delivery.

## §6 Executable freeze gate

```bash
node scripts/contracts/validate-contract-e.mjs
node --test tests/contracts/contract-e.test.mjs
```

The validator rejects weakened identity, single-release, local-authority,
fingerprint-portability, selection-failure, lifecycle, cache, or error-code
semantics.
