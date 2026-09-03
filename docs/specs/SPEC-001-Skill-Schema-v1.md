# SPEC-001 — Canonical Skill Schema v1

**Status:** FROZEN (V1 normative behavioral contract).
**Incorporates:** AMEND-02 (EGA-607: canonical path-error code, description code-point units),
AMEND-03 (EGA-608: TrustLevel assignment, alias lifecycle terminology).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority;
Linear amendment tickets (EGA-605..EGA-611) are provenance/history only.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

Section numbering and titles are preserved from the frozen bundle.

---

## §5.1.1 Portable Agent Skills source format

1. The portable source format is Agent Skills `SKILL.md`. EGA V1 adds two optional
   companions without rewriting third-party sources:
   - `SKILL.core.md` — optional authored compact instructions (L1).
   - `ega.yaml` — optional EGA routing/semantic metadata.
2. `SKILL.md` is REQUIRED in every skill root. A skill root without `SKILL.md` fails
   import/validation with `E_SKILL_FILE_MISSING`.
3. Strict import never repairs, renames, or rewrites source files. Source
   directories and files are never mutated by validation, hashing, or import.
4. There is no separate persisted `display_name` concept in V1. The user-facing
   default name of a skill is its portable name.

## §5.1.2 Control-file encoding

1. `SKILL.md`, `SKILL.core.md`, and `ega.yaml` must be UTF-8 text with no NUL byte.
2. Invalid UTF-8 or a NUL byte in any control file fails with `E_CONTROL_FILE_ENCODING`.
3. `SKILL.md` with unparseable frontmatter fails with `E_SKILL_FRONTMATTER_INVALID`.
4. Control-file checks run before name/description validation.

## §5.1.3 Portable name

1. The portable name MUST satisfy all of the following:
   - matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` (lowercase ASCII alphanumerics, hyphens only
     as single internal separators; no `_`, `.`, uppercase, leading/trailing or
     consecutive hyphens);
   - length 1–64 characters;
   - equals the name of its parent (skill-root) directory exactly.
2. A missing name fails with `E_SKILL_NAME_REQUIRED`.
3. A name violating the regex or length fails with `E_SKILL_NAME_INVALID`.
4. A name that does not match the parent directory fails with
   `E_SKILL_DIRECTORY_NAME_MISMATCH` (even when the name itself is otherwise valid).
5. Punctuation fixtures MUST prove that `_` and `.` are rejected in portable names
   even though EGA namespaces (§5.1.4) allow them.

## §5.1.4 Namespace and canonical skill ID

1. Namespace syntax: `^[a-z0-9][a-z0-9._-]{0,63}$` (1–64 chars; `.`, `_`, `-` allowed
   after a leading lowercase alphanumeric). Namespaces are NOT lowercased silently:
   invalid input is rejected, never repaired.
2. An invalid namespace fails with `E_NAMESPACE_INVALID`.
3. Canonical skill ID is `<namespace>/<portable-name>` (exactly one `/` separator).
4. The same portable name may coexist in different namespaces.
5. Explicit namespace fixtures MUST include a `.` case (e.g. `my.company/...`) and a
   `_` case (e.g. `personal_v1/...`) to prove namespace punctuation acceptance is
   independent of portable-name validation.

## §5.1.5 Description

1. `description` is REQUIRED, non-empty after outer-whitespace trimming, and at most
   1024 characters.
2. "Characters" means Unicode code points after YAML/frontmatter parsing — not
   UTF-16 code units and not UTF-8 bytes. An emoji/non-BMP boundary fixture MUST
   prove 1024/1025 behavior is deterministic (a 1024-code-point description is
   accepted; a 1025-code-point description is rejected).
3. A missing or empty description fails with `E_SKILL_DESCRIPTION_REQUIRED`.
4. A description longer than 1024 code points fails with
   `E_SKILL_DESCRIPTION_TOO_LARGE`.
5. Description text participates in FTS indexing (SPEC-003) as lexical evidence only;
   description-only relevance is never strong evidence (SPEC-004).

## §5.1.6 Optional portable metadata

1. The following optional portable fields are preserved with frozen types when present:
   `license`, `compatibility`, `metadata`, `allowed-tools`.
   (`allowed-tools` uses the portable hyphenated key in source; see §5.1.15 for the
   canonical wire-key mapping.)
2. Absent optional properties are omitted from all canonical forms — never materialized
   as `null`/`undefined` (see SPEC-002 manifest identity).
3. Unknown portable semantic fields are rejected by the strict V1 schema; they are
   never silently dropped (consistent with §5.1.10).

## §5.1.7 Content levels L0 / L1 / L2

1. V1 progressive disclosure has exactly three levels:
   - **L0** — compact discovery metadata: identity, routing sets, token counts,
     size class, L1 status. L0 target is `<= 250` `ega-o200k-v1` tokens and L0
     NEVER contains instruction body text.
   - **L1** — the exact canonical full text of `SKILL.core.md` when present
     (AMEND-02). No frontmatter stripping, no derived body, no hidden transform.
   - **L2** — the exact canonical full text of `SKILL.md`, including frontmatter
     (AMEND-02).
2. `l1Status` is exactly `AUTHORED` or `MISSING` — no other value exists.
   - Missing `SKILL.core.md` → `MISSING`.
   - Valid authored `SKILL.core.md` → `AUTHORED`.
3. Authored L1 target is 500–2,000 `ega-o200k-v1` tokens; hard max is 4,000 tokens.
   An L1 exceeding 4,000 tokens fails that level with `E_L1_TOO_LARGE`; the skill may
   still import with `l1Status=MISSING` while a valid L2 remains (L1 rejection never
   mutates or invalidates L2).
4. Rejected/oversized authored L1 is reported as warning/error detail; it is never
   silently discarded.
5. L1/L2 token counts (`l1Tokens` / `l2Tokens`) are counts of the exact canonical
   texts defined above, using estimator `ega-o200k-v1` (TEST-002). `get_content`
   returns those exact canonical texts (SPEC-006).
6. Boundary fixtures MUST cover 4000/4001 (L1), 5000/5001 and 12000/12001 (L2 classes).

## §5.1.8 `ega.yaml` presence and version

1. `ega.yaml` is OPTIONAL. A skill without `ega.yaml` is valid.
2. When present, `ega.yaml` MUST declare `schema_version: 1`. A missing or other
   `schema_version` fails with `E_EGA_METADATA_INVALID`.
3. Malformed or semantically unsupported `ega.yaml` content fails with
   `E_EGA_METADATA_INVALID`. Unknown future semantic keys are rejected in V1, never
   silently omitted from identity.

## §5.1.9 Routing identifier sets

1. `domains`, `platforms`, `frameworks`, and `aliases` are identifier sets. Each entry
   MUST validate against `^[a-z0-9][a-z0-9._+-]{0,63}$`.
2. Normalization per set: trim ASCII outer whitespace, ASCII-lowercase, deduplicate,
   sort ascending by UTF-16 code units. Thus `Web` and `web` collapse to one entry.
3. Invalid entries are never silently lowercased, repaired, or dropped; they fail
   with `E_EGA_METADATA_INVALID`.

## §5.1.10 Routing triggers

1. `triggers` and `anti_triggers` preserve Unicode and case exactly.
2. Normalization: normalize line endings, trim outer whitespace, deduplicate exact
   canonical strings, sort ascending by UTF-16 code units. No lowercasing, no
   stemming, no tokenization at this layer.
3. Trigger/anti-trigger matching semantics are defined solely by SPEC-004 (strong
   task evidence uses identifier-phrase normalization; generic FTS remains lexical).

## §5.1.11 Aliases

1. Aliases are globally unique: the same alias MUST NOT map to two canonical skill IDs.
2. Alias entries are normalized as identifier sets (§5.1.9) before collision comparison.
3. Re-importing the same alias for the same canonical skill is valid (idempotent);
   no first-import-wins behavior exists.
4. A cross-skill alias claim fails with `E_ALIAS_CONFLICT` and MUST leave no partial
   version/source/FTS/alias state for the conflicting skill (SPEC-003 transaction rule).
5. Alias ownership is monotonic while locally retained versions exist (AMEND-03,
   frozen detail in SPEC-003): a later local version may ADD aliases; removing an
   alias from later source metadata does NOT release or reassign it in V1; a global
   alias can never move to another canonical skill ID. Alias GC/release is post-V1.
6. A valid global alias is never ambiguous. `E_SKILL_REFERENCE_AMBIGUOUS` applies ONLY
   to an exact bare portable-name reference matching multiple visible canonical skills
   (§5.1.12). There is no "ambiguous alias" branch in a valid registry; alias collision
   is always import-time `E_ALIAS_CONFLICT`.
7. The schema layer exposes a pure (side-effect-free) collision helper so the registry
   can pass the existing alias owner into validation.

## §5.1.12 Skill-reference resolution order

1. Explicit references resolve in this exact order against the visible catalog:
   1. exact canonical ID (`<namespace>/<portable-name>`);
   2. exact global alias;
   3. bare portable name, ONLY if it matches exactly one visible canonical skill.
2. A bare portable name matching zero visible skills → `E_SKILL_NOT_FOUND`.
3. A bare portable name matching multiple visible canonical skills →
   `E_SKILL_REFERENCE_AMBIGUOUS`, reported in deterministic visible-catalog order.
4. Resolution is deterministic for a fixed visible catalog. "Visible" means
   current-version (unlocked) or exact locked-version (locked) scope per SPEC-003;
   historical versions are never reference candidates.
5. `inspect`/`get_content` accept canonical IDs only (SPEC-006); alias/bare-name
   discovery belongs to `search`/explicit router references.

## §5.1.13 References, assets, scripts

1. `references/`, `assets/`, and `scripts/` entries present in the skill package are
   catalogued and hashed (SPEC-002) with derived metadata `hasScripts`, `hasAssets`,
   and `referenceCount` matching the imported package.
2. `references/` content is NOT auto-routing-indexed, NOT loaded with L2, and NOT
   sent to the model.
3. `assets/` content is not interpreted by V1.
4. `scripts/` content is NEVER executed by any V1 surface (importer, router, MCP,
   CLI). Script presence is metadata only.
5. Size classification (§5.1.14) is derived metadata; it never affects content identity.

## §5.1.14 L2 size classes

1. L2 size class derives from the `ega-o200k-v1` token count of the exact canonical
   L2 text:
   - `NORMAL`: `<= 5000` tokens;
   - `LARGE`: `5001–12000` tokens;
   - `OVERSIZED`: `> 12000` tokens.
2. Routing consequences are defined solely by SPEC-004 (NORMAL/LARGE may auto-select
   within budget; OVERSIZED never auto-selects; over-budget LARGE remains a candidate).

## §5.1.15 Canonical manifest participation (portable side)

1. The canonical SkillVersion manifest (SPEC-002) carries the portable fields using
   AMEND-02 snake_case wire keys: `name`, `description`, and when present `license`,
   `compatibility`, `metadata`, `allowed_tools`. TypeScript camelCase implementation
   names MUST NEVER be serialized into the hash manifest.
2. Normalized parsed EGA routing metadata (identifier sets, triggers) enters version
   identity; raw `ega.yaml` formatting does not (SPEC-002).
3. All six routing arrays use canonical UTF-16 ascending sort after their
   field-specific normalization (§5.1.9–§5.1.10).

## §5.1.16 Structured import-error shape

1. Every validation/import failure surfaces a structured error with:
   - `code`: exact `E_*` code from this spec family;
   - `message`: human-readable detail;
   - `path` and `field`: included whenever applicable (file path / offending field).
2. Opaque thrown-string-only errors are forbidden. (MCP transport mapping in SPEC-006.)

## §5.1.17 Routing normalization reuse

1. Canonical storage forms (§5.1.9–§5.1.10) are distinct from derived
   search-normalized text (SPEC-003 FTS). Import stores canonical forms; search
   derivation never mutates stored canonical values.

## §5.1.18 Provenance (administrative, non-identity)

1. Each import records source observations with at minimum: source type (`local` |
   `git`), local path, repository, commit SHA, and repository path.
2. Provenance is administrative metadata: it is EXCLUDED from SkillVersion identity
   (SPEC-002) and may be multi-row per version (SPEC-003).
3. Removing the original source after import does not make cached historical content
   or version metadata unretrievable.

## §5.1.19 Token estimator binding

1. All token counts in this spec (`l1Tokens`, `l2Tokens`, L0/L1/L2 thresholds) use
   estimator `ega-o200k-v1` as defined by TEST-002 (`js-tiktoken@1.0.21`,
   `o200k_base`, ordinary-text behavior, canonical text input).
2. Binary blobs have no token count: no `token_counts` row in SQLite (SPEC-003) and
   `null`/unavailable in API/in-memory projections. Zero is NEVER a binary sentinel.
3. The router/golden harness refuses to run when the estimator ID is not
   `ega-o200k-v1` (TEST-001).

## §5.1.20 TrustLevel (AMEND-03, EGA-608)

1. `TrustLevel = OWNED | EXTERNAL | UNKNOWN`.
2. `trust_level` is administrative metadata: it is stored `NOT NULL` per version row
   (SPEC-003) but EXCLUDED from SkillVersion identity.
3. Default for every V1 import is `UNKNOWN`. There is no user-controlled
   trust-setting surface in V1; a future amendment must introduce one before any
   other default is possible.
4. V1 routing does not filter or rank by trust. Trust has no routing effect unless a
   future reviewed amendment explicitly specifies one.
5. OWNED/EXTERNAL MUST NOT be inferred from author name, path, namespace, or Git
   repository. No importer may guess trust.

## §5.2 Frozen error-code inventory (SPEC-001)

`E_CONTROL_FILE_ENCODING`, `E_SKILL_FILE_MISSING`, `E_SKILL_FRONTMATTER_INVALID`,
`E_SKILL_NAME_REQUIRED`, `E_SKILL_NAME_INVALID`, `E_SKILL_DIRECTORY_NAME_MISMATCH`,
`E_SKILL_DESCRIPTION_REQUIRED`, `E_SKILL_DESCRIPTION_TOO_LARGE`,
`E_NAMESPACE_INVALID`, `E_SKILL_REFERENCE_AMBIGUOUS`, `E_EGA_METADATA_INVALID`,
`E_ALIAS_CONFLICT`, `E_L1_TOO_LARGE`.

Historical note (AMEND-02): `E_SKILL_PATH_ESCAPE` is REMOVED. The single canonical
traversal/hash path-escape code is `E_HASH_PATH_ESCAPE`, owned by SPEC-002. This spec
defines no path-escape code.
