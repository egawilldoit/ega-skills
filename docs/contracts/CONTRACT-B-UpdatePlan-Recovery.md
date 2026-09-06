# Contract B — UpdatePlan & Recovery (FROZEN v1)

**Status:** FROZEN
**Contract version:** 1
**Milestone gate:** must freeze (with Contracts A and C) before any 1.1 implementation (§7 of the Final Post-V1 Release Specification).
**Linear:** EGA-621
**Normative inputs:** Final Post-V1 spec §2 (canonical envelope), §3.13–§3.19, §3.21; Contract A v1 (source identity, digests, extraction policy).

Checking upstream and applying upstream are SEPARATE operations. This contract
freezes both sides plus the crash-safe journal between them. It defines no
builder behavior (Contract C) and no hosted behavior (Contracts D–F).

## §1 UpdatePlan envelope

An UpdatePlan is an immutable proposal with the canonical artifact envelope:

```json
{
  "object_type": "ega.update-plan",
  "schema_version": 1,
  "payload": {},
  "digest": "sha256:..."
}
```

- `digest` = `SHA-256(RFC8785-JCS({object_type, schema_version, payload}))`,
  rendered `sha256:<64 lowercase hex>`, using the proven V1 primitive
  (`canonicalize@4.0.0` via `packages/hashing/dist/identities.js`).
  The digest is excluded from its own preimage.
- Unknown envelope OR payload fields are REJECTED. Missing and `null` are
  different; explicit `null` anywhere is REJECTED.
- Set-like lists in the payload are stored sorted; ordered lists stay ordered.

## §2 Check semantics (`hub check`, read-only)

```text
read source configuration (Contract A)
→ resolve the tracked ref to an exact commit
→ fetch the exact commit into quarantine
→ extract ONLY declared roots/provenance files (extraction_contract 1)
→ compute source digests (Contract A §6)
→ run canonical EGA analysis (V1 import semantics, no registry mutation)
→ compare adopted vs candidate state
→ emit the UpdatePlan
```

- Check MUST NOT mutate adopted content, the lock, or any registry.
- The plan binds the FULL target commit (40 lowercase hex). A plan carrying a
  mutable ref (`ref`, `target_ref`, `branch`, `rev`) is INVALID — apply must
  never re-resolve a moving ref.
- A check that finds zero changes MUST still describe that outcome, but an
  UpdatePlan whose target equals adopted state with zero changes is a NOOP and
  is REJECTED (`E_PLAN_NOOP`).

## §3 UpdatePlan payload (schema_version 1)

```json
{
  "source_id": "mattpocock",
  "source_config_digest": "sha256:...",
  "expected_old": {
    "resolved_commit": "<40hex>",
    "selected_skill_tree_digest": "sha256:..."
  },
  "target_commit": "<40hex>",
  "new_selected_tree_digest": "sha256:...",
  "new_vendored_snapshot_digest": "sha256:...",
  "added_skills": [{"skill_ref": "<ns>/<name>", "version_hash": "sha256:..."}],
  "removed_skills": [],
  "changed_skills": [{
    "skill_ref": "<ns>/<name>",
    "old_version": "sha256:...",
    "new_version": "sha256:...",
    "raw_changed": true,
    "canonical_changed": false
  }],
  "unselected_new_skills": ["<upstream-relative root>"],
  "provenance_changes": ["LICENSE"],
  "extraction_contract": 1
}
```

Rules:

- `source_config_digest` MUST equal the Contract A frozen vector for the
  source (mattpocock: `sha256:d8ed1c9a…af734f547`). Changing `sources.yaml`
  cannot reinterpret an adopted plan.
- `expected_old` MUST equal the currently adopted state at apply time,
  otherwise the plan is STALE (`E_PLAN_STALE`) and apply MUST refuse.
- `changed_skills` entries MUST carry boolean `raw_changed`/`canonical_changed`
  so reports distinguish `RAW_CHANGED` + `CANONICAL_UNCHANGED` (raw bytes moved
  but canonicalization erased the difference, e.g. line endings) from true
  semantic changes.
- `unselected_new_skills` lists upstream additions OUTSIDE the selected roots:
  reported, never silently adopted (explicit-selection-only, Contract A §4).
- `extraction_contract` MUST be `1`.

Frozen vectors (validator-recomputed over
`scripts/contracts/examples/contract-b/`):

```text
update-plan.json  sha256:9d8ee63a3ca988aee71f914c658050f1827edd9a98968c8489332c5283a07f2f  (FRESH)
stale-plan.json   sha256:ec3a9e9eddd0efc7308622c8e8b371cf1176d1338c00cdd51a41c3618fb391df  (STALE vs adopted.json)
```

## §4 Semantic update report

The plan/CI report MUST cover, at minimum:

```text
source commit change
added / changed / removed selected skills (old/new SkillVersion hashes)
raw-only vs canonical changes (SKILL.md, SKILL.core.md, ega.yaml)
aliases, triggers, anti_triggers, allowed-tools
disable-model-invocation, argument-hint
scripts added/removed (catalogued, never executed)
external URLs introduced
license/provenance changes
```

The Git diff remains the primary human review surface; this report is the
machine-checkable companion.

## §5 Apply semantics (`hub update --plan`, exact only)

Apply MUST verify, in order:

```text
plan digest
source config digest
expected old adopted source identity (stale check)
exact target commit (40hex; never refetch the tracked ref)
target tree digest
destination cleanliness (no dirty vendored tree, no uncommitted lock edit)
Hub invariant versions (contracts A–C versions understood by this binary)
```

- Apply MUST NOT fetch current `main`/branch tip. If the network offers a
  newer commit than `target_commit`, apply MUST ignore it.
- Plans are source-scoped: a Cursor change does not invalidate a Matt plan.
  BUT apply runs FULL Hub validation before committing, so a new global
  conflict (duplicate canonical Skill ID, alias collision) fails the apply
  even when the plan itself is fresh.

## §6 Crash-safe journal

`hub update` holds an exclusive Hub mutation lock and records a journal:

```json
{
  "journal_version": 1,
  "source_id": "mattpocock",
  "expected_old_commit": "<40hex>",
  "target_commit": "<40hex>",
  "staging": "<hub-relative staging path>",
  "backup": "<hub-relative backup path>",
  "state": "PREPARED | TREE_SWAPPED | LOCK_SWAPPED | COMMITTED"
}
```

Process:

```text
acquire exclusive Hub lock
→ validate UpdatePlan (§5)
→ construct staged tree + validate staged tree
→ write/fsync journal PREPARED
→ preserve old tree as backup
→ install staged tree → journal TREE_SWAPPED
→ atomically install new sources.lock → journal LOCK_SWAPPED
→ verify complete adopted state
→ journal COMMITTED → remove backup/journal → release lock
```

- `COMMITTED` journals MUST NOT retain `staging`/`backup`.
- Non-`COMMITTED` states MUST carry both locations.
- Unknown journal fields or states are REJECTED.

## §7 Recovery

- Every mutating/build Hub command checks for an incomplete journal FIRST and
  either resumes safely or restores the exact previous adopted state.
- `hub build` MUST refuse while recovery is incomplete (`E_RECOVERY_REQUIRED`).
- On Windows, an open file preventing rename MUST surface as an explicit
  busy/update error; the Hub MUST NOT continue half-updated. POSIX atomicity
  MUST NOT be assumed.

## §8 Credential separation

- Review path (untrusted upstream → check → proposal → PR) MUST NOT possess
  production publication credentials.
- Publication path (reviewed main → build → publish) owns them.
- UpdatePlans carry digests and commits only — never tokens, secrets, or
  credentials.

## §9 Errors (fail-closed)

| Code | Meaning |
| ---- | ------- |
| `E_PLAN_SCHEMA` | envelope/payload shape violation, unknown field, null, bad digest format |
| `E_PLAN_DIGEST` | plan digest recomputation mismatch |
| `E_PLAN_COMMIT` | commit not 40 lowercase hex |
| `E_PLAN_REFETCH` | plan carries a mutable ref (re-resolve risk) |
| `E_PLAN_STALE` | `expected_old` ≠ currently adopted state |
| `E_PLAN_NOOP` | target equals adopted state with zero changes |
| `E_JOURNAL_SCHEMA` | journal shape/version/location violation |
| `E_JOURNAL_STATE` | unknown journal state |
| `E_RECOVERY_REQUIRED` | incomplete journal; build/update must refuse until recovery |

## §10 State transitions

Adopted state moves ONLY `adopted --(exact UpdatePlan)--> adopted'`, with the
journal recording each step (§6). No transition exists for moving refs,
partial trees, or lock-only edits. Builder (Contract C) consumes the adopted
state read-only.

## §11 Compatibility and version policy

- This file is Contract B v1. New plan fields, journal states, or recovery
  semantics REQUIRE a new contract version.
- `schema_version: 1` / `journal_version: 1` artifacts MUST validate under v1
  forever; v2 MUST NOT silently reinterpret them.
- Contracts A and V1 SPEC-001–006 semantics are preserved.

## §12 Acceptance (executable)

1. `node scripts/contracts/validate-contract-b.mjs` exits 0 on the committed
   fixtures and recomputes both frozen plan digests in §3.
2. `node --test tests/contracts/contract-b.test.mjs` passes: FRESH plan
   validates; stale plan is flagged `E_PLAN_STALE`; tampered digest fails;
   mutable-ref plan fails; NOOP plan fails; unknown field fails; null fails;
   `TREE_SWAPPED` journal demands recovery; `COMMITTED` journal is clean.
3. `pnpm specs:check` still passes (V1 frozen set untouched).
4. `pnpm build` + `pnpm typecheck` pass; `git diff --check` clean.
5. Linux + Windows CI green.
