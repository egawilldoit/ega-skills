# SPEC-005 — Project Configuration and Eligible-Catalog Lockfile

**Status:** FROZEN (V1 normative behavioral contract).
**Incorporates:** AMEND-01 (EGA-606: lock/project fixture references used by golden
scenarios), AMEND-03 (EGA-608: lock-generation version source — current versions only),
AMEND-05 (EGA-610: policy list values + precedence, normalized ProjectConfigV1,
numeric validation, lock eligibility/version source, lock validation, budget
precedence, control-file safety, lock entry validation, commit intent).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority;
Linear amendment tickets (EGA-605..EGA-611) are provenance/history only.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

Section numbering and titles are preserved from the frozen bundle.

---

## §5.1.1 Effective project path

1. The effective `projectPath` is the `realpath` of the supplied path (symlinks and
   junctions resolved). A symlinked cwd and its real path MUST resolve identically
   (TEST-001 G042).
2. If the supplied path is a file, use its parent directory.
3. Omitted project path (CLI/MCP default) means `realpath(process.cwd())`. There is
   no global/unscoped project mode in V1.

## §5.1.2 Nearest config discovery

1. From the effective project directory, walk upward: the NEAREST `.egaskills.yaml`
   wins.
2. If no nearer config is found, stop at a `.git` file OR directory (handles normal
   repos, worktrees, and submodules) or at the filesystem root.
3. A nested repo MUST NOT leak an outer config. Config AT the Git root and config in
   a package BELOW the Git root are distinct nearest-wins cases (edge fixtures).
4. Workspace markers (`pnpm-workspace.yaml`, `package.json#workspaces`, `lerna.json`,
   `nx.json`, Cargo `[workspace]`) NEVER stop config discovery. Config discovery is
   independent from fingerprint workspace discovery (SPEC-004 §5.1.9).
5. The lock in force is the `.egaskills.lock` ADJACENT to the selected config ONLY.
   A stray `.egaskills.lock` without a selected `.egaskills.yaml` is IGNORED.

## §5.1.3 No hierarchical merge

There is no config inheritance, no hierarchical merge, and no org/team policy in V1.
Exactly one config (or built-in defaults, §5.1.5) governs a resolve call.

## §5.1.4 Discovery edge fixtures (normative inventory)

Implementation MUST cover: normal repo, worktree (`.git` file), nested repo,
monorepo package, file-as-`projectPath`, symlinked cwd realpath, filesystem-root
termination, config at Git root, config in package below Git root, and stray lock
without config (ignored).

## §5.1.5 ProjectConfigV1 schema and defaults

1. Only `routing.mode = suggest` is accepted in V1.
2. Built-in defaults when NO config file is selected:

```yaml
schema_version: 1
routing:
  mode: suggest
  max_skills: 3
  max_tokens: 5000
namespaces:
  allow: []
  deny: []
skills:
  prefer: []
  deny: []
locking:
  required: false
```

   This is UNLOCKED mode using current local versions.
3. `ega-skills init` writes a deterministic human-readable config with
   `schema_version: 1`, the SAME routing defaults, but `locking.required: true`.
   `init` output is stable (no timestamps).
4. `routing.max_skills`: integer `1–3`. `routing.max_tokens`: integer `1–1,000,000`
   (§5.1.6). Invalid config fails with `E_PROJECT_CONFIG_INVALID`.
5. No profiles, no inheritance, no team policy.

## §5.1.6 Policy list values and normalization (AMEND-05)

1. `namespaces.allow` / `namespaces.deny`: namespace strings ONLY. Trim ASCII outer
   whitespace; validate with the SPEC-001 namespace regex
   (`^[a-z0-9][a-z0-9._-]{0,63}$`); do NOT silently lowercase or repair invalid input.
2. `skills.prefer` / `skills.deny`: canonical skill IDs ONLY
   (`<namespace>/<portable-name>`). Trim outer whitespace; validate BOTH components.
   Aliases and bare portable names are NOT accepted in committed policy.
3. All four lists are ORDER-INSENSITIVE for config semantics: deduplicate and sort
   ascending by UTF-16 code units in normalized config.
4. A syntactically valid policy entry MAY reference a namespace/skill not currently
   installed; that is NOT a config error (policy validation never depends on current
   installation).
5. YAML parsing NEVER silently repairs invalid policy identifiers.

## §5.1.7 Policy precedence (AMEND-05)

For BOTH automatic and explicit eligibility, in exact order:

```text
1. namespaces.deny always denies.
2. If namespaces.allow is non-empty, the skill namespace MUST appear in allow.
   (Empty namespaces.allow means: all valid namespaces except denied ones.)
3. skills.deny always denies the exact canonical skill.
4. skills.prefer NEVER bypasses deny, lock, schema/version validity, platform hard
   filters, or relevance; it is ONLY the existing same-tier tie-break (SPEC-004
   §5.1.14 rule 1) applied after the candidate is relevant and eligible.
```

## §5.1.8 Normalized ProjectConfigV1 and config hash (AMEND-05)

1. The config-hash input is a FULLY MATERIALIZED normalized object — defaults
   populated, policy lists validated/deduplicated/sorted, canonical skill IDs only:

```yaml
schema_version: 1
routing:
  mode: suggest
  max_skills: <explicit or default 3>
  max_tokens: <explicit or default 5000>
namespaces:
  allow: <normalized list>
  deny: <normalized list>
skills:
  prefer: <normalized canonical-ID list>
  deny: <normalized canonical-ID list>
locking:
  required: <explicit or default false>
```

2. An omitted optional field and an explicitly written default produce the SAME
   config hash. YAML comments, key order, and formatting do NOT affect the hash.
3. The normalized object passed to JCS uses EXACTLY the `snake_case` keys shown
   above (`schema_version`, `max_skills`, `max_tokens`, ...). TypeScript camelCase
   implementation names MUST NOT be serialized into the config-hash input.
4. `config_hash = SHA256(RFC8785_JCS(normalized ProjectConfigV1))` using
   `canonicalize@4.0.0` + SHA-256 (SPEC-002 primitives).

## §5.1.9 Lockfile schema

1. `lockfile_version = 1`.
2. `token_estimator` MUST equal `ega-o200k-v1`. Any other estimator fails lock use
   with `E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED`.
3. `generated_from.config_hash` MUST equal the §5.1.8 hash of the active normalized
   config. A mismatch fails with `E_LOCK_CONFIG_MISMATCH` — EVEN when
   `locking.required=false` (an active lock is authoritative).
4. Each `skills` entry key MUST be a valid canonical skill ID; its `name` MUST equal
   the portable-name component of that key; its `version_hash` MUST match
   `sha256:<64 lowercase hex>`; `generated_from.config_hash` uses the same SHA-256
   representation. NO unknown entry fields exist in V1.
5. Lock serialization is deterministic with sorted skill keys.
6. `skills: {}` (empty lock) is a VALID active lock: `LOCKED`, eligible catalog empty,
   `LOW` confidence, `selected=[]`, `candidates=[]`; any explicit skill is blocked
   with `VERSION_NOT_LOCKED` (TEST-001 G039).

## §5.1.10 Lock scope, generation, and refresh (eligible catalog)

1. Lock scope is the FULL eligible candidate catalog — NOT previously used skills.
2. Generation starts from the local CURRENT-version catalog (AMEND-03), then applies:
   - valid skill/version schema;
   - namespace/skill project policy (§5.1.7);
   - required local immutable version + cache availability.
   It does NOT apply task text, fingerprint, FTS rank, redundancy, or token-budget
   routing decisions. Lock eligibility is policy/schema/version/cache based, never
   task/fingerprint based.
3. Each eligible skill contributes EXACTLY its current version hash at generation time.
4. Generation is FAIL-CLOSED for registry/cache integrity: a `current_version_hash`
   with no matching immutable `skill_versions` row fails with `E_VERSION_NOT_FOUND`;
   any required manifest blob that is missing or whose bytes do not match its hash
   fails with `E_CACHE_HASH_MISMATCH`. A broken eligible entry is NEVER silently
   omitted to emit a deceptively complete lock, and a failed regeneration leaves any
   existing lock UNCHANGED.
5. New unrelated global skills do NOT enter an active lock until EXPLICIT lock
   refresh. Locked projects remain stable after unrelated imports.
6. Refresh recomputes the same policy-defined eligible current catalog and reports a
   deterministic add/remove/version-change diff (`+`/`-`/`~` presentation; exact CLI
   spelling is implementation surface). No remote contact, no automatic lock mutation
   from router/MCP. Old locked versions remain selectable while cached.
7. (Management CLI command spelling for generate/refresh is implementation surface,
   not frozen contract — EGA-585.)

## §5.1.11 Lock validation and failure modes (all explicit, non-repairing)

| Condition | Result |
| --------- | ------ |
| `locking.required=true`, no adjacent lock | `E_LOCK_REQUIRED` |
| active lock, config hash mismatch | `E_LOCK_CONFIG_MISMATCH` |
| lock estimator is not `ega-o200k-v1` | `E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED` |
| invalid lock shape/version | `E_PROJECT_LOCK_INVALID` |
| locked version unavailable locally | `E_LOCKED_VERSION_MISSING` (NEVER fall forward to current/latest) |
| empty `skills: {}` | valid LOCKED catalog (§5.1.9 rule 6) |

## §5.1.12 Optional-lock semantics

1. With `locking.required=false` and a VALID present lock: the lock is honored
   (LOCKED behavior, including `E_LOCK_CONFIG_MISMATCH` on stale hash).
2. With `locking.required=false` and NO lock: UNLOCKED behavior using current local
   versions.
3. There is no implicit lock regeneration in any mode.

## §5.1.13 Effective values vs per-call request budget

(Defined normatively in SPEC-004 §5.1.7 and restated here for SPEC-005 ownership:
project `routing.max_skills` / `routing.max_tokens` are DEFAULTS; the per-call
`ResolveRequest` override wins within frozen ranges; `ResolutionResult.maxSkills` /
`maxTokens` report effective values. Required for the frozen custom-budget router
cases, e.g. TEST-001 G036.)

## §5.1.14 Config/lock control-file safety (AMEND-05)

1. `.egaskills.yaml` and `.egaskills.lock` MUST be regular UTF-8 text files with no
   NUL byte.
2. Duplicate YAML mapping keys are INVALID.
3. Unknown V1 config/lock semantic keys are REJECTED, never silently ignored.
4. A discovered config or adjacent lock that is a symlink/junction is REJECTED rather
   than followed in V1.
5. Config symlink/non-text/parse/schema failures map to `E_PROJECT_CONFIG_INVALID`.
   Lock symlink/non-text/parse/schema failures map to `E_PROJECT_LOCK_INVALID`.

## §5.1.15 Resolver integration order

The router MUST discover and validate the effective config + lock BEFORE explicit
resolution, fingerprinting, and candidate load (SPEC-004 §5.1.1). Project preference
influences ONLY candidates that are already relevant and eligible (§5.1.7 rule 4).
All existing router goldens MUST remain green against the real project module
(EGA-587 gate).

## §5.1.16 Git/reproducibility intent

`.egaskills.yaml` and `.egaskills.lock` are DESIGNED to be committed to the project
repository. Runtime does not require Git, but V1 operator/setup docs MUST recommend
committing both files when a project uses EGA project configuration/locking
(Wave-9 documentation requirement, EGA-604).

## §5.2 Frozen error-code inventory (SPEC-005)

`E_PROJECT_CONFIG_INVALID`, `E_PROJECT_LOCK_INVALID`, `E_LOCK_REQUIRED`,
`E_LOCK_CONFIG_MISMATCH`, `E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED`,
`E_LOCKED_VERSION_MISSING`, `E_PROJECT_NOT_FOUND` (missing project path; also
surfaced through MCP, SPEC-006).
(Integrity codes `E_VERSION_NOT_FOUND` / `E_CACHE_HASH_MISMATCH` are owned by
SPEC-003 and reused by fail-closed lock generation, §5.1.10 rule 4.)
