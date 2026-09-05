# SPEC-003 — Local Registry and Content Cache

**Status:** FROZEN (V1 normative behavioral contract).
**Incorporates:** AMEND-02 (EGA-607: binary token persistence, import namespace rule,
collection-discovery boundary), AMEND-03 (EGA-608: trust default, alias lifecycle,
current-version lifecycle, FTS exactness, re-import semantics, reference-ambiguity
terminology), AMEND-07 (EGA-612: real source-observation timestamps with documented
migration backfill; timestamps stay excluded from version identity).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority;
Linear amendment tickets (EGA-605..EGA-612) are provenance/history only.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

Section numbering and titles are preserved from the frozen bundle.

---

## §5.1.1 Local home layout

1. Default home is `~/.ega-skills`, overridden by the `EGA_SKILLS_HOME` environment
   variable (used to isolate test instances).
2. The default local layout contains:
   - `registry.sqlite` — metadata database (§5.1.3);
   - `cache/sha256/` — content-addressed blob cache (§5.1.8);
   - `logs/` — local diagnostics;
   - `config/` — local registry configuration.
3. Home/open/migration/newer-schema failures map to `E_REGISTRY_HOME`,
   `E_REGISTRY_DB_OPEN`, `E_REGISTRY_MIGRATION`, and `E_REGISTRY_SCHEMA_NEWER`
   respectively. A newer on-disk DB schema than the running code is rejected safely,
   never auto-downgraded.
4. Migrations are immutable and ordered.
5. Performance target: opening a 100-skill local registry in `<= 250 ms` on the
   documented reference machine.

## §5.1.2 Engine requirements

1. SQLite access uses `better-sqlite3`.
2. Full-text search uses SQLite FTS5 with tokenizer `unicode61 remove_diacritics 1`
   (§5.1.5). FTS5 absence at startup fails with `E_REGISTRY_FTS5_UNAVAILABLE`.
3. No cloud database and no remote source checks exist in V1.

## §5.1.3 SQLite schema (V1 tables)

1. V1 tables: `skills`, `skill_versions`, `skill_files`, `token_counts`,
   `skill_aliases`, `skill_sources`, plus the FTS5 index table for search (§5.1.5).
2. Notable frozen constraints:
   - `skills.current_version_hash` — pointer to the current immutable version;
   - `skill_versions` rows are immutable once committed; history is never rewritten;
   - `skill_aliases.alias` is GLOBALLY UNIQUE (one owner per alias, §5.1.13);
   - `token_counts` is keyed by `(blob_hash, estimator_id)`; binary blobs have NO row
     (AMEND-02, §5.1.16);
   - `trust_level` is `NOT NULL` administrative metadata defaulting to `UNKNOWN`
     (AMEND-03, §5.1.12);
   - there is NO required `display_name` column (SPEC-001 §5.1.1).
3. Foreign keys and indexes MUST match this frozen model. Exact column DDL is owned by
   EGA-564 implementation against this contract; any column added later requires a
   reviewed spec amendment.

## §5.1.4 FTS5 indexed columns (exact)

The FTS5 row is limited to EXACTLY these columns:

```text
skill_id UNINDEXED, version_hash UNINDEXED,
name, description, domains, platforms, frameworks, triggers, aliases
```

Do NOT index `anti_triggers`, L1/L2 bodies, references, assets, or scripts.
L1/L2/reference bodies are never searchable.

## §5.1.5 Tokenizer and query normalization

1. FTS5 tokenizer is `unicode61 remove_diacritics 1`, frozen.
2. No Porter stemmer, no embeddings, no vector index.
3. Query normalization is deterministic (AMEND-03 exact contract):
   1. trim the raw query;
   2. extract lexical terms as maximal Unicode letter/number runs: `/[\p{L}\p{N}]+/gu`;
   3. lowercase each extracted term with locale-independent JavaScript `toLowerCase()`;
   4. remove empty terms; deduplicate preserving first occurrence;
   5. escape FTS syntax per term and wrap each term in double quotes;
   6. join quoted terms with `OR` to build the MATCH input.
4. NEVER concatenate raw user syntax into MATCH. Use parameterized SQL only, so an
   injection-like query cannot alter MATCH syntax.
5. Canonical routing-array values stored in FTS text columns are joined with `\n`
   (newline) in their canonical array order (SPEC-002 §5.1.15).
6. Public behavior depends on RELATIVE result order only; absolute BM25 values are
   private and MUST NEVER be asserted, surfaced, or compared as contract thresholds.
7. SQL result order is `bm25, skill_id, version_hash`. Full rebuild deletes and
   reinserts rows sorted by `skill_id, version_hash` inside ONE transaction, so a
   rebuild produces the same relative order.
8. Performance target: warm FTS search p95 `<= 100 ms` for a 100-skill reference
   registry.

## §5.1.6 Search visibility (version selection)

1. Unlocked ordinary search/router exposes ONLY `current_version_hash` rows.
2. Locked project search exposes ONLY exact locked-version rows (SPEC-005).
3. Historical FTS rows MAY remain internally for immutable versions but MUST NEVER
   compete in ordinary visible search. Public search filters to the visible version
   set BEFORE returning results.
4. A normal import mutates only the exact version FTS row, in the same per-skill
   transaction.
5. Exact lexical ties are stable by `(skill_id, version_hash)` order (TEST-001 G041).

## §5.1.7 Exact-version lookup

An exact historical `version_hash` lookup that is absent locally MUST return
`E_VERSION_NOT_FOUND`. It MUST NEVER silently substitute `current_version_hash`
(no fall-forward, no fall-back).

## §5.1.8 Content-addressed cache layout

1. Cache path for a blob is `cache/sha256/ab/<remaining-digest>`, where `ab` is the
   first 2 hex characters of the SHA-256 digest (lowercase).
2. Cache reads verify the expected content hash BEFORE returning data.
3. Cache key identity uses canonical bytes for TEXT (SPEC-002 §5.1.6) and exact bytes
   for BINARY.

## §5.1.9 Atomic cache writes

1. Write protocol (exact order): temp write → close/fsync → verify SHA →
   atomic rename into final path.
2. The DB transaction may commit references ONLY to finalized required blobs.
3. Cache write failures map to `E_CACHE_WRITE`; hash verification failures map to
   `E_CACHE_HASH_MISMATCH`.
4. Invariant: orphan blobs after a failed DB transaction are ACCEPTABLE; broken
   COMMITTED references are FORBIDDEN.
5. Interrupted writes MUST NEVER leave a committed broken DB reference.
6. Performance target: typical warm cache get `<= 50 ms` on the documented
   reference machine.

## §5.1.10 Skill discovery

1. Recursive collection discovery default depth is 5. Discovery depth applies ONLY
   while locating candidate skill-root directories — NOT to files inside an
   identified skill package (SPEC-002 §5.1.17).
2. Discovery excludes EXACTLY: `.git`, `node_modules`, `dist`, `build`, `.next`,
   `coverage`, `.venv`, `__pycache__`. (This discovery set is broader than the
   SPEC-002 hashing exclusion set by design; the two sets MUST NOT be confused.)
3. If the explicit import path itself contains `SKILL.md`, it is ONE skill root; do
   not recursively discover nested `SKILL.md` files inside that package as siblings.
4. During collection traversal, a directory containing `SKILL.md` becomes a candidate
   root and descent STOPS beneath it.
5. Collection discovery does NOT follow symlink/junction directories. An explicitly
   imported symlinked skill root is handled by SPEC-002 realpath/link rules AFTER
   root selection.
6. Candidate skill roots are processed in deterministic canonical lexical-path order.
7. An empty import directory is handled deterministically without partial state.

## §5.1.11 Import command and namespace (AMEND-02)

1. The frozen V1 public import surface is exactly:

```text
ega-skills import <path> --namespace <namespace>
```

2. Every V1 import REQUIRES an explicit `--namespace <namespace>`. There is no
   "configured source metadata" exception in V1; that wording is removed. Source
   profiles / configured sources are post-V1.
3. Author/namespace is NEVER guessed or inferred (from path, Git remote, or otherwise).
4. Batch siblings commit INDEPENDENTLY: one invalid sibling does not roll back valid
   siblings. Batch reporting exposes the frozen summary shape
   `{ imported, unchanged, failed, failures }` with per-skill transactional
   independence preserved.
5. Capacity contract: 80 real-style skills import successfully under valid fixtures;
   500 synthetic skills are supported. Cold import of a 100-skill reference corpus
   targets `<= 5` seconds on the documented reference machine.

## §5.1.12 Import pipeline and version lifecycle (AMEND-03)

1. Pipeline order (exact): discover → parse/normalize/hash → write blobs → ONE DB
   transaction per skill including metadata, alias, source, token-count, and FTS rows.
2. Import outcomes:
   - `NEW_LOCAL_VERSION` — imported hash differs from `skills.current_version_hash`;
     the new immutable version row is inserted (or reused if historically known,
     see §5.1.14) and `current_version_hash` MOVES to it.
   - `NO_CHANGE` — imported hash EQUALS `skills.current_version_hash`; the pointer
     does not move and no duplicate version row is created. (`NO_CHANGE` means
     "hash equals current hash", NOT merely "hash exists somewhere in history".)
3. Old versions remain immutable and retrievable after the current pointer moves.
4. `trust_level` for every V1 import defaults to `UNKNOWN` (SPEC-001 §5.1.20):
   administrative, excluded from identity, no V1 routing effect, never guessed.
5. Source directories/files are never rewritten or silently repaired.

## §5.1.13 Alias persistence (AMEND-03)

1. `skill_aliases.alias` has a global UNIQUE constraint; the database enforces single
   ownership.
2. A cross-skill alias claim fails the EXACT skill's import transaction with
   `E_ALIAS_CONFLICT`, leaving NO partial new version/source/FTS/alias rows.
3. Same alias re-imported for the SAME canonical skill is valid and idempotent.
4. Alias ownership is skill-level and MONOTONIC while retained local versions exist:
   a new version may ADD aliases; OMISSION/removal of an alias in later source
   metadata does NOT delete or release it; an alias can NEVER be reassigned to
   another canonical skill ID. Alias GC/reassignment is post-V1.
5. SQLite uniqueness failures MUST be translated into the domain error
   `E_ALIAS_CONFLICT` without leaking driver-specific text.

## §5.1.14 Re-importing a previously known historical version (AMEND-03)

1. Compute imported hash `H` BEFORE deciding the re-import outcome.
2. If `H == skills.current_version_hash` → `NO_CHANGE`; do not move the pointer or
   create a duplicate row.
3. If `H != current_version_hash` → `NEW_LOCAL_VERSION` for the purposes of the
   frozen V1 import contract (meaning "new current local version"):
   - if version row `H` already exists historically for the SAME skill, REUSE that
     immutable row and move `current_version_hash` back to `H`; do NOT insert a
     duplicate SkillVersion row;
   - if `H` does not exist, insert the immutable version row, THEN move the current
     pointer to `H` in the same per-skill transaction.
4. In either changed-current case, source/alias/FTS state is reconciled
   transactionally under the existing V1 rules.
5. Active project locks remain UNCHANGED until explicit lock refresh; moving the
   global current pointer MUST NOT silently mutate a locked project.

## §5.1.15 Sources and provenance

1. The same SkillVersion MAY have multiple source rows (identical content imported
   from multiple locations records multiple observations).
2. Provenance fields follow SPEC-001 §5.1.18 (source type, local path, repository,
   commit SHA, repository path) and remain EXCLUDED from version identity.
3. Provenance updates do not change version identity and do not move the current
   pointer by themselves.
4. Every source row carries `observed_at`: the ISO-8601 UTC instant the
   observation was recorded — import time for importer-written rows
   (AMEND-07). Registries created before this amendment receive the migration
   instant for pre-existing rows (documented backfill; order among those rows
   remains insertion order). Like all provenance fields, `observed_at` remains
   EXCLUDED from version identity: recording or migrating timestamps MUST NOT
   alter version hashes, manifests, or blob identities.
5. Readers that require an observation instant fail closed on rows lacking a
   stored value instead of deriving one; see SPEC-006 §5.1.7 (AMEND-07).

## §5.1.16 Token-count records and binary rule (AMEND-02)

1. `token_counts` rows are keyed by `(blob_hash, estimator_id)` and deduplicate
   naturally across versions sharing blobs.
2. Binary blobs have NO row in `token_counts`. API/in-memory projections expose the
   binary token count as `null`/unavailable. Storing `0` as a binary sentinel is
   FORBIDDEN. (This is consistent with the `NOT NULL` column: the row itself is absent.)
3. Token recounts MUST NOT alter version hashes.

## §5.1.17 Reference-ambiguity terminology (AMEND-03)

A valid global alias is NEVER ambiguous. `E_SKILL_REFERENCE_AMBIGUOUS` applies ONLY
to an exact bare portable-name reference matching multiple visible canonical skills
(SPEC-001 §5.1.12). Do not implement an "ambiguous alias" branch; alias collision is
import-time `E_ALIAS_CONFLICT` (§5.1.13).

## §5.1.18 CLI surface (import required, inspection optional)

1. REQUIRED public CLI: `ega-skills import <path> --namespace <namespace>`, returning
   the `{ imported, unchanged, failed, failures }` summary (§5.1.11).
2. `list` / `inspect` CLI helpers are OPTIONAL implementation conveniences only: they
   MUST reuse registry APIs, remain local and read-only, work offline after import,
   and MUST NOT redefine the MCP contract (SPEC-006) or invent new V1 behavior.
   - `list` shows canonical IDs and current versions;
   - `inspect` shows metadata, versions, L1 status, token sizes, and provenance;
   - neither mutates state.

## §5.2 Frozen error-code inventory (SPEC-003)

`E_REGISTRY_HOME`, `E_REGISTRY_DB_OPEN`, `E_REGISTRY_MIGRATION`,
`E_REGISTRY_SCHEMA_NEWER`, `E_REGISTRY_FTS5_UNAVAILABLE`, `E_CACHE_WRITE`,
`E_CACHE_HASH_MISMATCH`, `E_ALIAS_CONFLICT`, `E_VERSION_NOT_FOUND`.
(Import outcomes `NEW_LOCAL_VERSION` / `NO_CHANGE` are status values, not errors.
Schema-validation codes owned by SPEC-001 also surface through import transactions.)
