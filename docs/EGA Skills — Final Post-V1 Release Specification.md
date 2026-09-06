# EGA Skills — Final Post-V1 Release Specification

**Status:** Final candidate for senior approval  
**Implementation status:** Not started  
**Baseline:** EGA Skills V1.0.1  
**Target milestones:** 1.1 → 1.2 → 1.3 → 2.0

---

# 0. Product direction

EGA evolves through four explicit milestones:

```text
1.1 — Skill Hub
      owned + external corpus
      exact source manifests
      explicit update plans
      reproducible complete builds
      immutable Hub Releases

1.2 — Hosted Personal EGA
      authenticated Streamable HTTP MCP
      one personal Hub
      one immutable release per runtime snapshot
      Node + SQLite/FTS5 data plane
      secure personal catalog mode

1.3 — Remote Projects
      workspaces/projects
      immutable project contexts
      remote locks
      remote lock refresh plans
      package-scoped fingerprint publishing

2.0 — Multi-user EGA
      multiple users/workspaces
      public/private Hubs
      full authorization
      auditing/revocation/quotas
      cloud-native control plane
      optional cloud-native search backend only after parity/versioning
```

These are sequential architectural milestones.

---

# 1. Shared invariants

Every release MUST preserve these rules.

## 1.1 Immutable content

A SkillVersion identified by:

```text
sha256:<digest>
```

can never change.

The same identity can never represent different canonical content.

---

## 1.2 Explicit adoption

External updates use:

```text
detect
→ create immutable proposal
→ review
→ apply exact proposal
→ Git review
→ build
→ publish new immutable Hub Release
```

Never:

```text
upstream changes
→ silently update live skills
```

---

## 1.3 Locks never move automatically

Publishing:

```text
Hub Release R2
```

must not change:

```text
Project Context using R1
```

Moving a project requires explicit lock refresh and explicit context publication.

---

## 1.4 MCP remains read-only

The only MCP tools remain:

```text
resolve
search
inspect
get_content
```

The following MUST NOT become MCP tools:

```text
source add
source update
Git fetch
Hub build
release publish
lock refresh
context publish
user administration
```

These belong to the control plane.

---

## 1.5 Content identity is not authorization

Possessing:

```text
SkillVersion hash
blob hash
HubRelease digest
Context digest
```

does not authorize retrieval.

Every hosted read is authorization checked.

---

## 1.6 No ambient build state

A build MUST NOT depend upon:

```text
developer registry history
developer SQLite database
previous imports
unrelated cached aliases
unrelated FTS rows
mutable branch tips
machine-specific absolute paths
timestamps
```

All semantic inputs must be explicit.

---

# 2. Common canonical artifact contract

Before 1.1 implementation, EGA will define one canonical envelope contract for new Hub artifacts.

Examples:

```text
UpdatePlan
AdoptedSource
HubRelease
RemoteLockPlan
ProjectContext
Fingerprint
```

## 2.1 Envelope

Conceptually:

```json
{
  "object_type": "ega.hub-release",
  "schema_version": 1,
  "payload": {},
  "digest": "sha256:..."
}
```

## 2.2 Digest preimage

`digest` is excluded from its own preimage.

Hash:

```text
RFC8785-JCS(
  {
    object_type,
    schema_version,
    payload
  }
)
```

using SHA-256.

Result:

```text
sha256:<64 lowercase hex>
```

---

## 2.3 Parsing rules

For every canonical artifact:

- unknown fields are rejected;
- missing and `null` are different;
- `null` is allowed only where explicitly defined;
- set-like arrays must be normalized and sorted before serialization;
- ordered arrays remain ordered;
- no timestamps participate unless explicitly part of semantic behavior;
- machine absolute paths are forbidden from portable identities;
- canonical verification failure is fail-closed.

---

## 2.4 Semantic identity versus artifact identity

Two identities are distinguished.

### Semantic digest

Represents EGA behavior.

Example:

```text
HubRelease digest
```

### Artifact digest

Represents bytes of a generated deployment artifact.

Example:

```text
SQLite snapshot sha256
```

The SQLite byte hash does **not** define the semantic Hub Release.

Two valid snapshot builds could theoretically have different raw SQLite bytes while representing the same semantic release.

---

# 3. Release 1.1 — Skill Hub

## 3.1 Goal

Create one Git-reviewed Hub containing:

```text
owned EGA skills
+
explicitly selected external skills
+
exact source provenance
+
safe upstream update workflow
+
reproducible immutable releases
```

1.1 is the foundation for every hosted milestone.

---

# 3.2 Canonical Hub layout

```text
skillshub/
├── README.md
├── hub.yaml
├── sources.yaml
├── sources.lock.yaml
│
├── owned/
│   └── ega/
│       ├── pr-review/
│       ├── debugging/
│       └── ...
│
└── external/
    ├── mattpocock/
    │   └── repo/
    │       ├── LICENSE
    │       └── skills/
    │           └── ...
    │
    └── cursor-pstack/
        └── repo/
            └── pstack/
                ├── LICENSE
                └── skills/
                    └── ...
```

External content preserves paths relative to the upstream repository.

---

# 3.3 `hub.yaml`

Authority:

> Which content belongs to this Hub?

Example:

```yaml
schema_version: 1

hub:
  id: personal

owned:
  - path: owned/ega
    namespace: ega

external:
  - source: mattpocock
  - source: cursor-pstack
```

It does not duplicate repository URLs or revisions.

---

# 3.4 `sources.yaml`

Authority:

> Which upstreams do we intend to track?

Example:

```yaml
schema_version: 1

sources:
  mattpocock:
    type: git
    repository: https://github.com/mattpocock/skills
    ref: main
    namespace: mattpocock

    selection:
      roots:
        - skills/engineering/tdd
        - skills/engineering/code-review
        - skills/productivity/grilling

    provenance_files:
      - LICENSE

  cursor-pstack:
    type: git
    repository: https://github.com/cursor/plugins
    ref: main
    namespace: cursor

    selection:
      roots:
        - pstack/skills/architect
        - pstack/skills/typescript-best-practices

    provenance_files:
      - pstack/LICENSE
```

### Important scope decision

1.1 uses **explicit selected roots** for external sources.

It does not automatically import every future directory containing `SKILL.md`.

A newly added upstream skill is reported but does not enter the Hub until explicitly selected.

---

# 3.5 `sources.lock.yaml`

Authority:

> What exact external state has been adopted?

Each source record is self-contained.

Conceptually:

```yaml
schema_version: 1

sources:
  mattpocock:
    source_config_digest: sha256:...
    repository: https://github.com/mattpocock/skills
    requested_ref: main
    namespace: mattpocock

    selection:
      roots:
        - skills/engineering/tdd
        - skills/engineering/code-review

    provenance_files:
      - LICENSE

    resolved_commit: 98abc420...
    selected_skill_tree_digest: sha256:...
    vendored_snapshot_digest: sha256:...

    extraction_contract: 1
```

Changing future `sources.yaml` cannot reinterpret old adopted state.

---

# 3.6 Source integrity identities

Two raw-source digests exist.

### Selected skill tree digest

Covers only selected skill roots.

### Vendored snapshot digest

Covers:

```text
selected skill roots
+
declared license/notice/provenance files
```

This proves both skill integrity and redistribution provenance.

---

# 3.7 Canonical EGA identity remains separate

Example:

```text
Raw upstream changed:
YES

Selected tree digest:
A → B

EGA canonical SkillVersion:
sha256:X → sha256:X
```

This is valid when the raw change canonicalizes away, such as certain line-ending-only differences.

Reports must distinguish:

```text
RAW_CHANGED
CANONICAL_UNCHANGED
```

---

# 3.8 No SOURCE.yaml authority duplication

1.1 does not require an authoritative per-source `SOURCE.yaml`.

`sources.lock.yaml` is the adopted-source authority.

A future generated human-readable projection may be added, but it MUST NOT become a second independent configuration source.

---

# 3.9 Owned skills

Owned skills live under:

```text
skillshub/owned/
```

They are manually authored and reviewed through normal Git workflow.

No updater is required for owned skills.

---

# 3.10 Skill authoring utilities

1.1 includes:

```bash
ega-skills validate <path>
ega-skills init-skill <name>
```

## `validate`

Non-mutating.

Checks:

- Agent Skills frontmatter;
- name;
- description;
- UTF-8;
- directory-name match;
- `ega.yaml`;
- routing normalization;
- `SKILL.core.md`;
- token budgets;
- path safety;
- canonical package structure.

Supports:

```bash
ega-skills validate ./skill
ega-skills validate ./skills
ega-skills validate ./skill --json
```

## `init-skill`

Default:

```text
new-skill/
├── SKILL.md
└── ega.yaml
```

It does **not** create an empty `SKILL.core.md`.

---

# 3.11 External content is generated/adopted state

Files under:

```text
skillshub/external/
```

must match `sources.lock.yaml`.

Manual unexplained changes fail:

```bash
ega-skills hub validate
```

---

# 3.12 Overlays deferred

1.1 does **not** implement overlays.

If upstream content needs deliberate modification:

```text
create an owned derivative
```

instead.

This avoids premature rules around:

- replacement order;
- deletion;
- conflict handling;
- overlay provenance;
- overlay hashing.

---

# 3.13 Update check

Command:

```bash
ega-skills hub check mattpocock \
  --output update-plan.json
```

Process:

```text
read source configuration
→ resolve mutable ref to exact commit
→ fetch exact commit into quarantine
→ extract only declared roots/files
→ apply traversal/symlink policy
→ compute source digests
→ run canonical EGA analysis
→ compare adopted and candidate state
→ generate UpdatePlan
```

Hub state is unchanged.

---

# 3.14 UpdatePlan

UpdatePlan is an immutable proposal.

Contains at minimum:

```text
source_id
source_config_digest
expected adopted source identity
full target commit
old selected tree digest
new selected tree digest
new vendored snapshot digest
planned skill additions
planned skill removals
planned skill changes
old/new SkillVersion hashes
semantic changes
plan digest
```

---

# 3.15 Semantic update report

UpdatePlan/CI report includes:

```text
source commit change
added skills
changed skills
removed skills
raw-only changes
SkillVersion changes
SKILL.md changes
SKILL.core.md changes
ega.yaml changes
aliases
triggers
anti_triggers
allowed-tools
disable-model-invocation
argument-hint
scripts added/removed
external URLs introduced
license/provenance changes
```

Git diff remains the primary human review surface.

---

# 3.16 Apply update

Command:

```bash
ega-skills hub update mattpocock \
  --plan update-plan.json
```

It MUST verify:

```text
plan digest
source config digest
expected old adopted source identity
exact target commit
target tree digest
destination cleanliness
Hub invariant versions
```

It MUST NOT refetch current `main` and silently use a newer commit.

---

# 3.17 Stale-plan scope

Update plans are source-scoped.

Changing Cursor does not automatically invalidate a Matt plan.

However, apply performs full Hub validation before committing its local mutation.

Therefore a new global conflict such as:

```text
duplicate Skill ID
alias collision
```

causes apply to fail.

---

# 3.18 Crash-safe update transaction

`hub update` uses an exclusive Hub mutation lock.

Conceptual states:

```text
PREPARED
TREE_SWAPPED
LOCK_SWAPPED
COMMITTED
```

A journal records:

```text
source ID
expected old source digest
target source digest
staging location
backup location
target sources.lock identity
transaction state
```

Process:

```text
acquire exclusive Hub lock
→ validate UpdatePlan
→ construct staged tree
→ validate staged tree
→ write/fsync journal PREPARED
→ preserve old tree as backup
→ install staged tree
→ journal TREE_SWAPPED
→ atomically install new sources.lock
→ journal LOCK_SWAPPED
→ verify complete adopted state
→ COMMITTED
→ remove backup/journal
→ release lock
```

---

# 3.19 Recovery

Every mutating/build Hub command checks for an incomplete journal first.

If recovery is needed:

```text
resume safely
or
restore exact previous adopted state
```

`hub build` refuses to operate while update recovery is incomplete.

On Windows, an open file preventing rename produces an explicit busy/update error.

It must not continue with a half-updated Hub.

---

# 3.20 External ingestion security

Default 1.1 policy:

```text
Git hooks                 forbidden
install scripts           never executed
skill scripts             never executed
submodule recursion       forbidden
path traversal            forbidden
symlink escape            forbidden
device/special files      forbidden
unbounded extraction      forbidden
Git LFS implicit fetch    forbidden
```

LFS/submodules require future explicit contracts.

---

# 3.21 Review/publish credential separation

Workflow A:

```text
untrusted upstream
→ check
→ update proposal
→ PR
```

has **no production publishing credentials**.

Workflow B:

```text
reviewed main
→ build release
→ publish
```

owns publishing credentials.

---

# 3.22 Complete-build semantics

This is mandatory.

`hub build` MUST NOT simply reuse an existing developer registry.

Every build starts from:

```text
fresh empty isolated registry
+
fresh empty release-specific search index
```

Process:

1. Parse Hub contracts.
2. Determine complete expected catalog.
3. Validate all owned content.
4. Verify all external provenance.
5. Verify vendored tree digests.
6. Discover expected skills.
7. Reject duplicate canonical IDs.
8. Derive release alias ownership.
9. Reject alias conflicts.
10. Import into fresh registry.
11. Require **zero import failures**.
12. Verify resulting catalog exactly equals expected catalog.
13. Verify token counts.
14. Build release-specific FTS corpus.
15. Verify index input identity.
16. Emit HubRelease.
17. Only then may publication begin.

Partial imports never produce releases.

---

# 3.23 Removed skills

If a skill disappears from a new Hub Release:

```text
R1: contains skill X
R2: does not contain skill X
```

R1 remains intact.

Historical SkillVersion blobs remain retained.

R2 simply excludes X.

---

# 3.24 Release-scoped aliases

Aliases are release-scoped.

A new release does not inherit alias ownership from historical local registry state.

Alias map is derived exclusively from the SkillVersions selected by that release.

Example:

```text
R1:
foo → ega/a

R2:
selected SkillVersions no longer claim foo

Result:
R2 has no foo alias
```

No historical alias survives implicitly.

---

# 3.25 Release-specific search index

Each Hub Release has its own exact FTS corpus.

Only rows belonging to that release participate in BM25 statistics.

Never:

```text
R1 rows
+
R2 rows
+
visibility filter
```

Instead:

```text
R1 → FTS corpus R1
R2 → FTS corpus R2
```

Publishing R2 must not change search ordering for R1.

---

# 3.26 Search-index semantic input

A deterministic SearchIndexInput artifact records exact normalized rows used to build FTS.

For every release-selected SkillVersion:

```text
skill_id
version_hash
name
description
domains
platforms
frameworks
triggers
aliases
```

ordered deterministically.

Its digest is bound by the HubRelease.

---

# 3.27 Token-count semantic input

HubRelease binds:

```text
token estimator contract
estimator ID
generated relevant token counts
```

Token counts used for:

```text
L1/L2 recommendations
budgets
routing/composition
```

cannot come from ambient registry history.

---

# 3.28 Compatibility metadata

1.1 compatibility metadata is **advisory only**.

It MUST NOT affect routing eligibility.

Each record keys to:

```text
SkillVersion hash
client
client version/range
status
tested evidence
```

Example:

```yaml
skill_version: sha256:...
client: opencode
client_version: 2.x
status: supported
```

An upstream new SkillVersion does not inherit `supported`.

It returns to:

```text
unknown
```

until reviewed/tested.

Because compatibility is advisory in 1.1, it is not a router semantic input.

A future eligibility-filtering use requires a new policy contract.

---

# 3.29 HubRelease semantic payload

HubRelease binds all runtime-semantic state.

At minimum:

```text
Hub ID
selected Skill ID → SkillVersion map
release-scoped alias map digest
SearchIndexInput digest
token-count artifact digest
adopted-source artifact digests
schema contract version
canonical hashing contract version
router contract version
search contract version
token estimator ID
import/build contract version
```

It excludes:

```text
build timestamp
CI run ID
developer path
publication URL
OAuth configuration
deployment environment
SQLite raw-byte hash
```

---

# 3.30 No retained history as semantic input

Historical SkillVersions may remain in object storage.

They MUST NOT participate in:

```text
alias calculation
FTS statistics
current catalog
routing candidates
token metadata
```

unless explicitly selected by the release.

---

# 3.31 SQLite build artifact

`hub build` may additionally produce:

```text
registry.sqlite
```

Its raw digest:

```text
sqlite_artifact_digest
```

is stored as integrity metadata.

This digest is not the HubRelease semantic identity.

---

# 3.32 Release publication

Publication order:

```text
build complete release
→ upload immutable SkillVersion objects
→ upload release-specific index/snapshot
→ verify every artifact
→ publish immutable HubRelease
→ CAS-update stable pointer LAST
```

---

# 3.33 Concurrent publication

Stable pointer updates use compare-and-swap/version preconditions.

An older CI run cannot overwrite a newer approved publication.

---

# 3.34 1.1 implementation task groups

### A — Canonical artifact framework

- canonical envelope
- hashing
- schema validation
- digest verification

### B — Hub/source schemas

- `hub.yaml`
- `sources.yaml`
- `sources.lock.yaml`
- source selection
- provenance paths
- licenses

### C — Upstream planning

- exact Git resolution
- quarantine fetch
- UpdatePlan
- semantic diff

### D — Crash-safe adoption

- update journal
- exclusive lock
- staging
- recovery
- Windows behavior

### E — Complete Hub builder

- fresh registry
- complete catalog validation
- zero-failure requirement
- exact-result verification

### F — Release-scoped semantic state

- alias map
- token artifact
- SearchIndexInput
- release-specific FTS

### G — HubRelease

- semantic manifest
- release digest
- snapshot artifact
- stable pointer model

### H — Real corpus validation

- owned EGA skills
- Matt selected skills
- Cursor selected skills
- external update E2E

---

# 3.35 1.1 acceptance criteria

1. Build uses a fresh registry.
2. Existing developer registry cannot affect output.
3. Aliases are release-scoped.
4. Search index contains only release rows.
5. Publishing R2 cannot change R1 search results.
6. Zero import failures required.
7. Exact expected catalog required.
8. Source adoption records are self-contained.
9. License files participate in provenance integrity.
10. UpdatePlan is immutable and explicit.
11. Update application is crash recoverable.
12. Exact commit is used.
13. External scripts never execute.
14. HubRelease binds every runtime semantic input.
15. Semantic digest and SQLite artifact digest are separate.
16. Removed skills disappear only from newer releases.
17. Historical releases remain intact.
18. Fresh checkout reproduces the same semantic release.

---

# 3.36 1.1 non-goals

Deferred:

```text
overlays
hosted MCP
remote projects
automatic updater daemon
public marketplace
multi-user
cloud-native search
compatibility-based routing
```

---

# 4. Release 1.2 — Hosted Personal EGA

## 4.1 Goal

Make one personal immutable Hub remotely available from any machine.

Target:

```text
install Codex/OpenCode
→ add EGA MCP URL
→ authenticate
→ use Hub
```

No Matt/Cursor/EGA source clone is needed on the consuming machine.

---

# 4.2 First hosted runtime preserves proven search behavior

1.2 uses:

```text
Node runtime
+
release-specific SQLite snapshot
+
release-specific FTS5 index
+
immutable content blobs
+
Streamable HTTP MCP
```

It does not rewrite search into PostgreSQL.

---

# 4.3 Runtime snapshot

Each semantic HubRelease has a corresponding deployment package:

```text
HubRelease manifest
registry.sqlite
SQLite artifact digest
content blob references
```

A runtime instance serves an exact release snapshot.

---

# 4.4 Startup integrity

Before accepting requests:

1. Verify HubRelease digest.
2. Verify snapshot artifact digest.
3. Open SQLite read-only.
4. Verify database integrity.
5. Verify embedded release identity.
6. Verify search contract version.
7. Verify expected index-row identity.
8. Verify required blobs exist.
9. Load emergency deny policy.
10. Only then mark service healthy.

---

# 4.5 Hosted MCP contract version

Tool names remain:

```text
resolve
search
inspect
get_content
```

but hosted schemas gain explicit scope semantics.

Define:

```text
Hosted MCP Contract v1
```

independently from local V1 stdio assumptions.

---

# 4.6 Request scope fields

Hosted tool calls may carry:

```text
release_digest
context_id
```

Rules are frozen before 1.2 implementation.

---

# 4.7 Personal catalog mode

For:

```text
search
resolve
```

when neither context nor release is supplied:

```text
resolve stable pointer exactly once
→ execute against exact release
→ return effective_release_digest
```

Response always exposes:

```text
effective_release_digest
```

---

# 4.8 Chained-call consistency

For hosted personal catalog mode:

```text
inspect
get_content
```

require either:

```text
release_digest
or
context_id
```

No implicit second lookup of `stable`.

Therefore:

```text
resolve
→ R17
→ get_content(..., release_digest=R17)
```

cannot accidentally cross into R18 published milliseconds later.

---

# 4.9 Context rules reserved for 1.3

Hosted scope rules:

| Input | Behavior |
|---|---|
| none on search/resolve | personal catalog mode |
| exact release | execute exact release |
| context | exact context |
| missing/revoked context | error |
| context + matching release | allowed |
| context + different release | reject |
| project_path | reject |
| no scope on inspect/get_content | reject |

No fallback from failed context to personal mode.

---

# 4.10 Authentication

Authentication is mandatory from first deployment.

Acceptance flow:

```text
remote MCP configured
→ OAuth discovery
→ browser login
→ token
→ MCP initialization
→ authorized tools
```

---

# 4.11 Token handling

Bearer/OAuth tokens are **never logged**.

No debug exception exists.

Also never log:

```text
refresh tokens
authorization codes
client secrets
```

---

# 4.12 OAuth validation

Service validates:

```text
issuer
audience/resource
signature
expiry
not-before
scope
revocation where applicable
```

before authorization.

---

# 4.13 Authorization

Initial relationship:

```text
user
→ personal workspace
→ authorized HubRelease
→ SkillVersion
→ blob
```

Every MCP tool authorizes independently.

Knowing a version/blob hash grants nothing.

---

# 4.14 Emergency deny

1.2 includes mutable emergency security policy.

Can deny:

```text
HubRelease
SkillVersion
specific source
```

without modifying immutable identity.

Denied content returns an explicit security/revocation error.

Never silently substitute another version.

Emergency deny is checked before caches.

---

# 4.15 Cache safety

Any cache must include all behavior inputs.

At minimum:

```text
workspace
release/context identity
router contract
search contract
task/query
explicit skill selection
budget overrides
policy digest
fingerprint digest when present
```

Authorization/revocation is rechecked before cached results are served.

---

# 4.16 Transport security

1.2 includes:

- HTTPS only;
- MCP transport Origin validation requirements;
- bounded request size;
- bounded response size;
- request timeout;
- tool execution timeout;
- concurrency limit;
- connection limit;
- malformed request rejection;
- explicit content-length/budget limits.

---

# 4.17 Runtime credentials

Hosted MCP process uses read-only credentials wherever possible.

It cannot:

```text
publish releases
modify Git
change source config
modify Hub content
change stable pointer
```

---

# 4.18 Publication service separation

Publishing credentials belong to release CI/control plane, not MCP runtime.

---

# 4.19 Backups and restore

Before 1.2 release:

- stable/release pointer metadata backup;
- authentication/authorization metadata backup;
- immutable release storage recovery procedure;
- restore test;
- rollback test.

---

# 4.20 Personal Catalog Mode behavior

Personal catalog mode uses:

```text
task/query
+
exact effective HubRelease
```

It has no local repository fingerprint.

Responses explicitly report:

```text
project_context: NONE
fingerprint_status: NONE
```

It must not pretend to provide project-aware routing.

---

# 4.21 Client compatibility

Separate from skill runtime compatibility.

1.2 records tested:

```text
Codex client version
OpenCode client version
ChatGPT availability where supported
```

Client configuration documentation is versioned/tested independently.

---

# 4.22 1.2 task groups

### A — Hosted MCP contract

- common scope semantics
- hosted tool schemas
- hosted error contract

### B — Snapshot runtime

- immutable release loading
- read-only SQLite
- release-specific FTS

### C — HTTP transport

- Streamable HTTP
- limits
- Origin validation
- health endpoints

### D — Authentication

- OAuth
- token validation
- browser flow

### E — Authorization

- personal workspace
- release/version/blob permissions

### F — Operational safety

- deny mechanism
- caching
- privacy
- backup/restore
- rollback

### G — Deployment

- Node service
- domain/TLS
- CI release publication

### H — E2E

- completely fresh machine
- Codex
- OpenCode
- authentication
- resolve/search/inspect/get_content

---

# 4.23 1.2 acceptance criteria

1. Auth required.
2. Exactly four MCP tools.
3. Hosted Contract v1 frozen.
4. Personal catalog mode explicit.
5. Release identity returned on search/resolve.
6. inspect/get_content cannot silently cross releases.
7. SQLite snapshot contains one exact release corpus.
8. R2/new publication cannot alter old release search.
9. Runtime is read-only.
10. Emergency deny works.
11. Tokens are never logged.
12. Request/response/time/concurrency limits exist.
13. Startup verifies release integrity.
14. Backup restore tested.
15. Rollback tested.
16. Fresh Codex E2E succeeds.
17. Fresh OpenCode E2E succeeds.

---

# 4.24 1.2 non-goals

Deferred:

```text
remote project locks
fingerprint publishing
multi-user workspaces
teams
public Hubs
Postgres FTS
marketplace
```

---

# 5. Release 1.3 — Remote Projects

## 5.1 Goal

Restore project-scoped deterministic behavior in hosted EGA.

Introduce:

```text
Workspace
→ Project
→ immutable Project Context
```

---

# 5.2 Project Context

A Context binds:

```text
normalized project config
exact lock
exact HubRelease
optional fingerprint
context contract version
```

It is immutable.

---

# 5.3 Context identity

Canonical ProjectContext artifact contains:

```text
workspace ID
project ID
config digest
lock digest
release digest
fingerprint digest/null
context contract version
```

and receives its own canonical digest.

---

# 5.4 Projects have multiple contexts

Required:

```text
ega-house
├── main context
├── feature context
├── production context
└── worktree context
```

There is no single mutable:

```text
project.current_lock
```

---

# 5.5 `.egaskills.yaml` remains authoritative

Remote project state does not replace committed local project files.

The canonical project artifacts remain:

```text
.egaskills.yaml
.egaskills.lock
```

---

# 5.6 Context publication

Proposed:

```bash
ega-skills context publish \
  --project ega-house
```

Process:

1. Read local project config.
2. Read local lock.
3. Validate.
4. Resolve exact HubRelease.
5. Verify every locked version exists in that release.
6. Compute config digest.
7. Compute lock digest.
8. Build optional fingerprint.
9. Create canonical ProjectContext.
10. Authenticate.
11. Publish immutable context.

---

# 5.7 Multi-release lock publication

For initial 1.3:

If a lock references SkillVersions that are not all contained in one declared HubRelease:

```text
REJECT
```

with precise error.

No implicit union of releases.

---

# 5.8 Existing local refresh remains unchanged

Current:

```bash
ega-skills lock --refresh
```

continues to mean local registry refresh.

Its behavior is not repurposed for cloud.

---

# 5.9 Remote lock refresh

A new control-plane workflow is introduced.

Conceptually:

```bash
ega-skills remote-lock plan \
  --project . \
  --release sha256:R20 \
  --output lock-plan.json
```

The control plane receives:

```text
normalized project configuration
existing lock identity
exact target HubRelease
optional published fingerprint
```

and computes a candidate lock against that exact release.

---

# 5.10 RemoteLockPlan

Immutable artifact containing:

```text
project config digest
existing lock digest
target HubRelease digest
candidate lock
added entries
removed entries
changed entries
plan digest
```

---

# 5.11 Applying remote lock refresh

After review:

```bash
ega-skills remote-lock apply \
  --plan lock-plan.json
```

writes the candidate:

```text
.egaskills.lock
```

locally.

Then normal Git diff/review occurs.

After commit:

```bash
ega-skills context publish
```

creates a new immutable context.

---

# 5.12 No silent remote mutation

The server never modifies:

```text
.egaskills.lock
```

on the developer's repository.

Lock movement remains explicit and reviewable.

---

# 5.13 Fingerprint purpose

Remote EGA cannot inspect the caller's repository.

Fingerprint publishing supplies bounded routing evidence.

---

# 5.14 Package-scoped fingerprint

Fingerprint MUST include:

```text
selected package root
workspace root
workspace ambiguity
languages
platforms
frameworks
evidence records
repository revision evidence
relevant-input digest
```

---

# 5.15 Relative paths only

Portable identity uses repository-relative paths.

Never:

```text
C:\Users\...
/home/ubuntu/...
```

---

# 5.16 Nearest-package behavior

A monorepo context must select one package scope.

Example:

```text
apps/web
```

and:

```text
apps/mobile
```

must be able to produce different contexts/fingerprints.

Do not union every framework across the whole monorepo.

---

# 5.17 Fingerprint revision provenance

Clean repository:

```json
{
  "mode": "git-clean",
  "commit_sha": "..."
}
```

Dirty working tree:

```json
{
  "mode": "git-dirty",
  "base_commit_sha": "...",
  "relevant_input_digest": "sha256:..."
}
```

Unknown/non-Git:

```json
{
  "mode": "unversioned",
  "relevant_input_digest": "sha256:..."
}
```

---

# 5.18 Relevant input digest

Fingerprint generation records which repository-relative inputs affected fingerprinting.

Their canonical relevant bytes/identities contribute to:

```text
relevant_input_digest
```

It does not hash/upload arbitrary application source.

---

# 5.19 Fingerprint evidence

Example:

```json
{
  "package_root": "apps/mobile",
  "workspace_root": ".",
  "workspace_ambiguous": false,
  "languages": ["typescript"],
  "platforms": ["mobile"],
  "frameworks": ["expo", "react-native"],
  "evidence": [
    {
      "path": "apps/mobile/package.json",
      "kind": "package-manifest"
    }
  ]
}
```

---

# 5.20 Missing fingerprint

If a context has no fingerprint:

```text
fingerprint_status = MISSING
```

Hosted resolve operates deterministically using:

```text
task
+
config
+
lock
+
HubRelease
```

No inferred filesystem evidence is invented.

---

# 5.21 Hosted context selection

Every four-tool request may include:

```text
context_id
```

When provided:

```text
Context
→ exact lock
→ exact release
→ exact fingerprint
→ exact policy
```

governs the request.

---

# 5.22 Context failure behavior

If context is:

```text
missing
revoked
unauthorized
invalid
```

request fails.

No fallback to personal catalog mode.

---

# 5.23 Context + release

If both supplied:

```text
release_digest MUST equal context.release_digest
```

Otherwise reject.

---

# 5.24 Remote project_path

Hosted MCP explicitly rejects:

```text
project_path
```

Server paths have no relation to client project paths.

---

# 5.25 Context cache identity

Resolution cache includes every behavior input:

```text
workspace
context digest
release digest
router contract
search contract
task
explicit skill references
max skill override
max token override
policy digest
fingerprint digest
```

Authorization and emergency deny checks occur before cache delivery.

---

# 5.26 Context revocation

Context may be revoked.

Revocation:

- does not mutate context;
- does not substitute a new context;
- returns explicit error.

---

# 5.27 Skill revocation

A locked SkillVersion may later be denied.

Its hash remains immutable.

Request returns an explicit revoked-content error.

Never automatically upgrade it.

---

# 5.28 1.3 task groups

### A — Project identity

- workspace
- project
- context

### B — Context artifact

- config digest
- lock digest
- release binding

### C — Remote lock planning

- remote candidate computation
- RemoteLockPlan
- local apply

### D — Fingerprints

- package scope
- revision evidence
- relevant input digest

### E — Hosted scope integration

- context authorization
- four-tool behavior
- cache keys

### F — Context lifecycle

- publication
- listing
- revocation

### G — Real monorepo E2E

- web context
- mobile context
- branch contexts
- worktrees
- remote lock refresh

---

# 5.29 1.3 acceptance criteria

1. Multiple immutable contexts per project.
2. Context binds config + lock + release.
3. Lock may reference only one HubRelease in initial 1.3.
4. Local `lock --refresh` unchanged.
5. Remote lock planning requires exact release.
6. Remote lock update is explicit/reviewable.
7. Context publication never mutates project files.
8. Package-scoped fingerprints work.
9. Dirty-tree provenance is explicit.
10. Absolute machine paths excluded.
11. Missing fingerprints handled explicitly.
12. Context failures never fall back.
13. Cache identity covers all routing inputs.
14. Context revocation works.
15. Monorepo web/mobile routing distinction proven.
16. Fresh-machine remote project E2E passes.

---

# 5.30 1.3 non-goals

Deferred:

```text
team sharing
public Hubs
billing
anonymous access
marketplace
automatic CI project discovery
cross-release locks
```

---

# 6. Release 2.0 — Multi-user EGA

## 6.1 Goal

Turn Hosted Personal EGA into a secure multi-tenant product.

Support:

```text
multiple users
multiple workspaces
shared projects
private Hubs
workspace Hubs
public Hubs
full authorization
revocation
auditing
quotas
```

---

# 6.2 Important architecture correction

2.0 does **not** require replacing the proven FTS data plane merely to become multi-user.

2.0 requires a cloud-native **control plane**.

A distributed Postgres search/registry data plane is optional until parity or a newly versioned search contract is proven.

---

# 6.3 Initial 2.0 architecture

Possible:

```text
Cloud-native control plane
    Supabase/Postgres

Immutable data plane
    HubRelease manifests
    release-specific SQLite snapshots
    R2 blobs

Hosted MCP workers/services
    authenticated
    workspace/context scoped
```

This can support multiple users without changing deterministic search.

---

# 6.4 Workspace

A Workspace owns:

```text
members
roles
Hubs
Hub Releases
projects
contexts
policies
source credentials
quotas
audit events
```

---

# 6.5 Roles

Initial RBAC:

```text
owner
admin
maintainer
member
viewer
```

Exact privileges become normative before implementation.

---

# 6.6 Hub visibility

```text
private
workspace
public
```

### Private

Explicit authorization only.

### Workspace

Workspace members according to role/policy.

### Public

Publicly discoverable/useable according to policy.

---

# 6.7 Public source does not mean trusted source

Public Hub metadata may show:

```text
publisher
release digest
source provenance
license
client compatibility
review state
revocation state
```

Structural validation is not trust.

---

# 6.8 Authorization graph

Conceptually:

```text
User
→ Workspace
→ Hub
→ HubRelease
→ Project
→ ProjectContext
→ SkillVersion
→ Blob
```

Every read follows authorization relationships.

---

# 6.9 Hash bypass forbidden

Endpoints cannot expose private content simply because caller knows:

```text
sha256:X
```

Authorization precedes content-addressed retrieval.

---

# 6.10 Search authorization

Search results are filtered to resources authorized under exact workspace/release/context.

No private Skill ID leakage through global search statistics.

---

# 6.11 Per-release search isolation continues

Until an explicitly reviewed new search contract exists:

```text
one HubRelease
→ one search corpus
```

remains true in 2.0.

---

# 6.12 Optional cloud-native search backend

If EGA later implements PostgreSQL-native search:

it cannot silently replace SQLite FTS5.

Required gate:

1. Define search backend contract.
2. Replay frozen router corpus.
3. Replay real Hub corpus.
4. Compare candidate ordering.
5. Compare selected skills.
6. Compare scores where contract-relevant.
7. Prove release isolation.
8. Prove unrelated rows cannot affect results.

If exact semantics differ intentionally:

```text
Search Contract v2
```

must be introduced.

---

# 6.13 OAuth and scopes

2.0 supports:

- browser authentication;
- refresh tokens;
- token revocation;
- MCP authorization discovery;
- workspace-scoped access;
- least-privilege scopes.

Administrative credentials never reach MCP clients.

---

# 6.14 Source credentials

Private Git source secrets:

- encrypted;
- server-side only;
- source-scoped;
- least privilege;
- rotatable;
- inaccessible from MCP;
- unavailable to untrusted source review jobs where unnecessary.

---

# 6.15 Publishing isolation

Source processing and production publication remain separate security domains.

Untrusted upstream processing has no authority to:

```text
advance stable
modify release metadata
write production blobs
modify authorization
```

---

# 6.16 Trust states

Potential:

```text
OWNED
VERIFIED_EXTERNAL
EXTERNAL
UNKNOWN
REVOKED
```

Trust assignment is explicit.

Never inferred merely from:

```text
GitHub stars
namespace
repository owner
valid SKILL.md
successful CI
```

---

# 6.17 Revocation

Revocation is separate from deletion.

Can revoke:

```text
Hub
HubRelease
SkillVersion
ProjectContext
token
source
```

Historic identity remains preserved.

---

# 6.18 No silent substitution

If context references revoked SkillVersion:

```text
fail explicitly
```

Do not substitute newest version.

---

# 6.19 Retention

Objects referenced by retained:

```text
HubRelease
lock
ProjectContext
audit/recovery policy
```

remain available.

Upstream deletion does not delete adopted content.

---

# 6.20 Garbage collection

Garbage collection is reference-aware.

Only unreferenced immutable artifacts may be deleted after retention policy permits.

---

# 6.21 Audit log

Security-sensitive operations record:

```text
actor
workspace
operation
target identity
old identity
new identity
time
request ID
result
```

Examples:

```text
publish release
advance stable
update source
publish context
revoke SkillVersion
change role
change visibility
```

Audit timestamps do not affect canonical content identity.

---

# 6.22 Privacy

Do not log:

```text
OAuth tokens
skill secrets
private skill bodies
full task prompts by default
private companion content
```

Operational telemetry uses identifiers/metrics where possible.

---

# 6.23 Quotas and rate limits

May constrain:

```text
requests
concurrency
Hub size
release count
source checks
published contexts
bandwidth
```

Quota rejection is explicit.

Quota behavior must not silently modify routing.

---

# 6.24 Public Hubs

Public publishing requires:

```text
valid provenance
license information
publisher identity
immutable release
security/revocation support
```

No:

```text
arbitrary URL
→ instantly trusted public skill
```

pipeline.

---

# 6.25 Private engine / private Hub separation

The architecture supports independent repositories:

```text
ega-skills               engine
ega-personal-skill-hub   private Hub
company-skill-hub        organization Hub
community-hub            public Hub
```

No coupling requires Hub source to live inside engine repository.

---

# 6.26 Compatibility catalog

Compatibility records are keyed by:

```text
SkillVersion
client
client version
capability assumptions
test evidence
```

Potential capability requirements:

```text
filesystem writes
shell
subagents
browser
specific MCP
scripts
client-native rules
```

Compatibility remains separate from canonical upstream skill content.

---

# 6.27 Compatibility-based routing

Not automatically enabled in 2.0.

If compatibility later filters candidate eligibility, EGA must define:

```text
Compatibility Policy Contract
```

and bind its digest/version into ProjectContext/HubRelease routing semantics.

---

# 6.28 Local/offline remains supported

Future:

```text
HubRelease
→ download/hydrate
→ local SQLite
→ local cache
→ local stdio MCP
```

Hosted EGA does not eliminate offline EGA.

---

# 6.29 2.0 task groups

### A — Multi-tenant identity

- users
- workspaces
- memberships
- RBAC

### B — Hub visibility

- private
- workspace
- public

### C — Authorization engine

- Hub
- release
- context
- SkillVersion
- blob

### D — Operational security

- audit
- revocation
- rate limits
- quotas
- credential isolation

### E — Storage/control plane

- Postgres metadata
- R2 immutable content
- release snapshots

### F — Public publishing

- provenance
- licenses
- trust
- moderation/revocation

### G — Multi-tenant testing

- isolation
- cache safety
- hash bypass
- search isolation
- authorization

### H — Optional distributed search

Only after explicit parity/versioning gate.

---

# 6.30 2.0 acceptance criteria

1. Multiple users supported.
2. Multiple workspaces supported.
3. RBAC enforced.
4. Private Hubs work.
5. Workspace Hubs work.
6. Public Hubs work.
7. Every MCP tool enforces authorization.
8. Hash knowledge cannot bypass access.
9. Search leaks no unauthorized content.
10. Cross-workspace cache isolation proven.
11. Context authorization proven.
12. OAuth scopes proven.
13. Revocation proven.
14. No silent version substitution.
15. Audit trail exists.
16. Source credentials isolated.
17. Backup/restore tested.
18. Public provenance/license requirements enforced.
19. Rate/concurrency limits exist.
20. Real multi-user isolation E2E passes.

A PostgreSQL-native FTS implementation is **not** required to declare these multi-user guarantees complete.

If implemented, it has its own search-contract gate.

---

# 7. Specification freeze gates

The previous proposal had an inconsistency about freezing every future contract before any code.

This is replaced with milestone-specific gates.

## Before 1.1 implementation

Freeze Contracts A–C.

### Contract A — Hub & Sources

Must freeze:

```text
hub.yaml
sources.yaml
sources.lock.yaml
source selection
self-contained provenance
licenses
raw tree hashing
external vendoring
source safety
```

### Contract B — UpdatePlan & Recovery

Must freeze:

```text
UpdatePlan identity
check semantics
exact commit
stale-plan rules
semantic diff
update transaction
journal
recovery
Windows behavior
```

### Contract C — Complete Build & HubRelease

Must freeze:

```text
fresh-registry build
complete catalog
zero failures
release-scoped aliases
release-specific FTS
token artifacts
search artifact
HubRelease payload
semantic hash
SQLite artifact hash
publication
rollback
retention
```

Only after A–C are frozen does 1.1 implementation begin.

---

# 8. Before 1.2 implementation

Freeze Contract D.

## Contract D — Hosted Runtime

Must freeze:

```text
Hosted MCP Contract v1
personal catalog mode
release/context scope fields
stable resolution
chained-call pinning
authentication
authorization
Origin/security limits
emergency deny
cache behavior
startup integrity
```

Also freeze the **context-selection boundary** needed by future Contract E.

Full remote project implementation is not required yet.

---

# 9. Before 1.3 implementation

Freeze Contract E.

## Contract E — Remote Projects

Must freeze:

```text
workspace
project
context
context hash
remote lock planning
single-release lock requirement
fingerprint contract
package scope
revision evidence
context selection
revocation
```

---

# 10. Before 2.0 implementation

Freeze Contract F.

## Contract F — Multi-user Authorization

Must freeze:

```text
workspace RBAC
Hub visibility
release authorization
project authorization
context authorization
SkillVersion authorization
blob authorization
public/private policy
revocation
audit
quotas
source credentials
```

If search/storage semantics change, freeze that contract separately before implementing the changed backend.

---

# 11. Release dependency graph

```text
V1.0.1
   │
   ▼
Contracts A–C frozen
   │
   ▼
1.1 Skill Hub
   │
   ▼
Contract D frozen
   │
   ▼
1.2 Hosted Personal EGA
   │
   ▼
Contract E frozen
   │
   ▼
1.3 Remote Projects
   │
   ▼
Contract F frozen
   │
   ▼
2.0 Multi-user EGA
```

---

# 12. Required real E2E gates

Every release gets a real post-build test, not only unit/integration tests.

## 1.1 E2E

Use real external repository.

Example:

```text
adopt Matt commit A
→ build R1
→ upstream changes to commit B
→ check
→ UpdatePlan
→ apply exact B
→ inspect Git diff
→ build R2
→ prove R1 unchanged
→ prove R2 changed correctly
```

Also prove:

```text
adding unrelated R2 FTS rows cannot reorder R1 search
```

because R1 has its own corpus.

---

## 1.2 E2E

Completely fresh machine:

```text
install OpenCode/Codex
→ configure remote EGA
→ authenticate
→ search
→ resolve
→ inspect
→ get_content
```

No skill source cloning.

---

## 1.3 E2E

Real monorepo:

```text
main context
web context
mobile context
feature branch context
```

Prove:

```text
different package fingerprints
different locks where appropriate
stable immutable contexts
remote lock plan
reviewed lock change
new context
```

---

## 2.0 E2E

At least:

```text
User A / Workspace A
User B / Workspace B
Private Hub A
Public Hub
shared project
```

Prove:

```text
A cannot inspect B
A cannot retrieve B blob by known hash
search does not leak B
cache does not leak B
revocation works
public Hub remains available according to policy
```

---

# 13. Main deployment evolution

## 1.1

No remote deployment requirement.

```text
Git Hub
→ local canonical build
→ immutable release artifacts
```

---

## 1.2

Initial hosted runtime:

```text
GitHub
   ↓
release CI
   ↓
immutable HubRelease
   ↓
release-specific SQLite + FTS
   ↓
immutable blob storage
   ↓
Node Streamable HTTP MCP
   ↓
OAuth
```

---

## 1.3

Add:

```text
project/context control plane
fingerprint publication
remote lock planning
```

---

## 2.0

Add:

```text
Supabase/Postgres control plane
+
R2/object storage
+
multi-user authorization
+
public/private Hub management
```

The proven release-specific SQLite search data plane may remain until an explicitly versioned replacement is ready.

---

# 14. Final architecture

```text
                    SOURCE PLANE

        owned                    external Git
          │                           │
          │                     resolve commit
          │                           │
          └──────────────┬────────────┘
                         ▼
                   UpdatePlan
                         │
                         ▼
                    Git review
                         │
                         ▼
                     Skill Hub


                    BUILD PLANE

                     Skill Hub
                         │
              fresh isolated registry
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
 SkillVersions      alias map      SearchIndexInput
        │                │                │
        └────────────────┼────────────────┘
                         │
                    token artifact
                         │
                         ▼
                 immutable HubRelease


                  PUBLICATION PLANE

                 immutable HubRelease
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        SQLite/FTS snapshot       blobs
              │                     │
              └──────────┬──────────┘
                         │
                    stable pointer


                   DELIVERY PLANE

              authenticated HTTP MCP
               exactly four tools
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
            Codex     OpenCode   ChatGPT


                   CONTEXT PLANE

                    Workspace
                        │
                     Project
                        │
              immutable Context
                ┌───────┼────────┐
                ▼       ▼        ▼
              config   lock   fingerprint
                         │
                         ▼
                    HubRelease


                MULTI-USER CONTROL

                    Workspace
                 ┌──────┼──────┐
                 ▼      ▼      ▼
               users   Hubs  Projects
                 │      │      │
                 └──────┼──────┘
                        ▼
                  authorization
```

---

# 15. Final product principle

The post-V1 architecture is governed by five boundaries:

> **Git decides what content is adopted.**

> **UpdatePlans decide exactly what external change is being applied.**

> **HubReleases decide the complete immutable runtime catalog and search corpus.**

> **ProjectContexts decide exactly what a project may resolve.**

> **MCP only reads authorized immutable state.**

No mutable upstream reference, old SQLite history, unrelated FTS row, local server path, or known content hash may bypass those boundaries.

---

# 16. Implementation decision

Implementation MUST NOT start immediately from this document.

The next engineering action after senior approval is:

```text
1. Extract and freeze Contract A.
2. Extract and freeze Contract B.
3. Extract and freeze Contract C.
4. Review A–C together.
5. Only then create the 1.1 implementation wave.
```

1.2, 1.3, and 2.0 remain architecture-approved roadmap sections until their respective specification gates are reached.