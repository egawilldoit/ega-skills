# SPEC-002 — Canonical Hashing and Immutable Version Identity

**Status:** FROZEN (V1 normative behavioral contract).
**Incorporates:** AMEND-02 (EGA-607: §5.1.2 path-escape code, §5.1.13 byteSize,
raw-`ega.yaml` identity, canonical wire keys, routing-array sort, collection
discovery vs traversal, description code-point units; L1/L2 exact content).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority;
Linear amendment tickets (EGA-605..EGA-611) are provenance/history only.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

Section numbering and titles are preserved from the frozen bundle.

---

## §5.1.1 Hash primitives

1. Blob and version identifiers use SHA-256 exclusively.
2. `canonicalize@4.0.0` is NORMATIVE for RFC 8785 JSON Canonicalization Scheme (JCS).
   No custom almost-JCS serializer is permitted.
3. All hashes render as lowercase `sha256:<64 hex characters>`.

## §5.1.2 Canonical path-escape error (AMEND-02)

1. The single canonical V1 runtime code for traversal/hash path escape is
   `E_HASH_PATH_ESCAPE`.
2. The stale `E_SKILL_PATH_ESCAPE` MUST NOT appear in any implementation, error
   mapping, or documentation. SPEC-001 defines no path-escape code.
3. Collection discovery and selected skill-root traversal are distinct (see §5.1.17):
   discovery never follows symlink/junction directories; an explicitly selected root
   uses the realpath/link safety rules of §5.1.7–§5.1.10.

## §5.1.3 SkillVersion identity rule

1. `SkillVersionHash = SHA256(JCS-UTF-8(canonical manifest))` where the canonical
   manifest is the exact snake_case wire object defined in §5.1.15.
2. The manifest MUST be I-JSON-compatible. Absent optional properties are omitted —
   never `null`, never `undefined`. Non-I-JSON/canonical-JSON failures map to
   `E_HASH_CANONICAL_JSON` / `E_HASH_IJSON` distinctly and deterministically.
3. Identity inputs: canonical file records (§5.1.11), normalized portable fields and
   normalized parsed EGA routing metadata (§5.1.15, SPEC-001 §5.1.6–§5.1.11).
4. Excluded from identity: provenance/source observations, token counts, source paths,
   trust level, derived size classes, L0 metadata.
5. Token recount, provenance update, or source-path change MUST NOT alter the version hash.
6. Hash schema version is `1`. Any future semantic hash change requires an explicit
   schema bump plus a reviewed spec amendment.

## §5.1.4 Control-file text requirement

1. Control files (`SKILL.md`, `SKILL.core.md`, `ega.yaml`) MUST be text. Invalid
   control-file encoding fails before hashing (SPEC-001 `E_CONTROL_FILE_ENCODING`).

## §5.1.5 Text vs binary classification

1. Every non-control file is `TEXT` if and only if its bytes are valid UTF-8 AND
   contain no NUL byte; otherwise it is `BINARY`.
2. Classification is by content bytes only — never by extension, filename, or
   Git attributes.

## §5.1.6 Text canonicalization

1. Canonical text bytes derive from source bytes by exactly these steps, in order:
   1. remove ONE leading UTF-8 BOM (`EF BB BF`) if present;
   2. map every `CRLF` (`0D 0A`) and every lone `CR` (`0D`) to `LF` (`0A`);
   3. preserve ALL remaining code points and whitespace exactly, including trailing
      whitespace and final-newline presence/absence.
2. There is NO Unicode normalization: NFC and NFD source variants remain distinct and
   hash differently. There is no case folding, no whitespace collapsing.
3. Canonical text bytes are the shared input for blob hashing AND the token estimator
   (TEST-002 `ega-o200k-v1` canonical text input). CRLF/LF and BOM/no-BOM variants
   MUST converge to identical canonical bytes; fixtures prove it.
4. `ega-o200k-v1` counts canonical text; Unicode source is not normalized before
   counting; `<|endoftext|>` is ordinary text (TEST-002).

## §5.1.7 Safe realpath traversal

1. Before traversal, resolve the lexical root and the real root SEPARATELY:
   - the lexical root is the user-supplied path as written;
   - the real root is its `realpath` (symlinks/junctions resolved).
2. The real root MUST exist and MUST be a directory before traversal begins.
3. Every candidate entry is examined with `lstat` BEFORE any link-following decision.
4. Opened files are revalidated with `fstat` before read/hash (TOCTOU rule), so a
   validated type/path cannot silently change between check and use.
5. Symlink/junction targets MUST remain inside the real root, tested with
   relative-path containment semantics. Raw string-prefix (`startsWith`) containment
   checks are FORBIDDEN. On Windows, containment is case-insensitive (drive/UNC case
   differences MUST NOT create false escapes).
6. Stored relative paths use lexical in-root paths with preserved observed case
   (realpath is used for security/containment only, never for identity).
7. Failure mapping is exact:
   - target outside real root → `E_HASH_LINK_ESCAPE`;
   - broken link → `E_HASH_LINK_BROKEN`;
   - link cycle → `E_HASH_LINK_CYCLE` (POSIX cycle identity may use `dev+ino`;
     Windows may use normalized realpath);
   - source type/path mutation detected → `E_IMPORT_SOURCE_CHANGED`.

## §5.1.8 Canonical package enumeration

1. Stored paths are relative to the lexical root, use `/` separators on ALL operating
   systems, contain no `.` or `..` segments, and preserve observed case.
2. File records sort ascending by canonical path using UTF-16 code-unit order.
3. Duplicate canonical paths fail with `E_HASH_DUPLICATE_PATH`.
4. Hard-linked regular files are allowed as independent lexical files: they keep
   distinct canonical paths and MAY share blob hashes. A hard link outside the root
   is irrelevant; only in-root lexical entries are enumerated.

## §5.1.9 Hashing exclusion set (exact)

For SPEC-002 version-manifest hashing, exclude EXACTLY:

```text
.git/**
node_modules/**
.venv/**
__pycache__/**
.DS_Store
Thumbs.db
desktop.ini
```

Do NOT substitute the broader SPEC-003 collection-discovery exclusion set (`dist`,
`build`, `.next`, `coverage`) into the hashing contract. Paths excluded here never
enter the manifest.

## §5.1.10 Stored-path containment

Relative-path containment (§5.1.7) applies to every enumerated entry: any entry that
would escape the lexical root fails with `E_HASH_PATH_ESCAPE`.

## §5.1.11 Canonical file records

Each manifest `files[]` record contains exactly:

| Wire key       | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `path`         | canonical relative path (§5.1.8)                                |
| `role`         | frozen file role (skill body, core, ega-metadata, reference, asset, script, other) |
| `blob_hash`    | `sha256:<hex>` of canonical bytes (text) or exact bytes (binary) |
| `byte_size`    | §5.1.13 byte size                                              |
| `content_kind` | `TEXT` or `BINARY` (§5.1.5)                                    |

No unknown record fields exist in V1.

## §5.1.12 TOCTOU summary (normative restatement)

`realRoot` exists + is directory → `lstat` every candidate → relative-path containment
→ open → `fstat` revalidation → read/hash. Any check-then-use divergence fails with
`E_IMPORT_SOURCE_CHANGED`.

## §5.1.13 Canonical file byte size (AMEND-02)

1. TEXT `byte_size` = byte length of the SPEC-002 canonical UTF-8 bytes AFTER
   BOM/line-ending normalization (§5.1.6). NEVER pre-normalization source byte size.
2. BINARY `byte_size` = exact binary byte length.
3. A CRLF/BOM fixture MUST prove that source-byte-size differences do not change the
   final SkillVersion hash.

## §5.1.14 JCS conformance

1. The implementation MUST pass the official RFC 8785 conformance vectors with
   `canonicalize@4.0.0`.
2. The SkillVersion hash changes on any semantic content change and is stable across
   Linux and Windows for identical canonical inputs (frozen fixtures, §5.1.20).

## §5.1.15 Canonical manifest wire object (AMEND-02)

1. The object passed to RFC 8785 JCS uses EXACTLY these snake_case wire keys —
   TypeScript camelCase implementation names MUST NEVER be serialized into identity:

```text
top level:      schema_version, skill_id, portable, routing, files
portable optionals (omit when absent): name, description, license,
                compatibility, metadata, allowed_tools
routing:        domains, platforms, frameworks, triggers, anti_triggers, aliases
file record:    path, role, blob_hash, byte_size, content_kind
```

2. Only normalized parsed EGA semantic metadata enters identity. Raw `ega.yaml` is
   NOT a behavior-defining `files[]` record; formatting-only `ega.yaml` changes
   (comments, key order, whitespace) MUST NOT alter the manifest or version hash.
   A dedicated fixture proves comment/key-order/whitespace invariance.
3. V1 does NOT require persisting or caching the raw `ega.yaml` as a separate
   administrative blob, and no new persistence schema may be added solely for that
   purpose. The raw file may be exposed only from the original source while that
   source exists. (No orphan administrative `ega.yaml` cache contract exists.)
4. All six routing arrays are sorted ascending by UTF-16 code units AFTER their
   field-specific normalization/deduplication (SPEC-001 §5.1.9–§5.1.10). This is the
   same deterministic ordering basis as canonical file paths (§5.1.8).

## §5.1.16 Exact L1/L2 content (AMEND-02)

1. L1 = canonical full `SKILL.core.md` text. L2 = canonical full `SKILL.md` text,
   including frontmatter.
2. `l1Tokens` / `l2Tokens` are counts of those exact canonical texts.
3. `get_content` returns those exact canonical texts (SPEC-006).
4. No hidden frontmatter stripping and no derived-body blob exist in V1.
5. SPEC-001, SPEC-003, SPEC-004, SPEC-006 and TEST-002 use this single content
   definition; any wording suggesting a stripped "body" is superseded.

## §5.1.17 Collection discovery vs skill-package traversal (AMEND-02)

1. SPEC-003 discovery depth 5 applies ONLY while searching an imported collection for
   candidate skill-root directories.
2. If the explicit import path itself contains `SKILL.md`, it is ONE skill root; do
   NOT recursively discover nested `SKILL.md` files inside that package as siblings.
3. During collection discovery, once a directory containing `SKILL.md` is found,
   register it as a candidate skill root and STOP discovery descent beneath it.
4. Collection discovery does NOT follow symlink/junction directories. A user may
   explicitly import a symlinked skill root; then §5.1.7 realpath/link rules apply
   inside that selected root.
5. After a skill root is selected, package traversal is NOT limited by the collection
   discovery depth: include the complete in-root package tree subject ONLY to the
   hashing exclusions (§5.1.9) and link-safety rules (§5.1.7).
6. Candidate skill roots are processed in deterministic canonical lexical-path order
   for stable reporting.

## §5.1.18 Human-text length units (AMEND-02)

Portable `description` 1–1024 "characters" means Unicode code points after YAML
parsing — not UTF-16 code units, not UTF-8 bytes (SPEC-001 §5.1.5). The
emoji/non-BMP boundary fixture makes 1024/1025 deterministic.

## §5.1.19 Binary token persistence pointer (AMEND-02)

Binary blobs have NO row in `token_counts`; API/in-memory projections use
null/unavailable; zero is never a binary sentinel. Full rule in SPEC-003; SQL schema
declares no nullable-token workaround because the row itself is absent.

## §5.1.20 Cross-platform frozen hash fixtures

1. The same imported skill MUST produce the same SkillVersion hash on Linux and Windows.
2. Frozen fixtures cover: CRLF/LF convergence, BOM convergence, NFC/NFD distinctness,
   symlink/junction/hard-link edges, exclusion handling, `ega.yaml`-formatting
   invariance, canonical-byte-size invariance.
3. Expected hashes are committed under `fixtures/hashes/` and asserted in CI on both
   platforms. Token recount MUST NOT alter version hashes.
4. Performance gate: 100 typical skills cold-hash in `<= 5` seconds on the documented
   reference machine. Hashing uses zero model tokens. Hash schema remains `1`.

## §5.2 Frozen error-code inventory (SPEC-002)

`E_HASH_PATH_ESCAPE` (sole canonical path-escape code), `E_HASH_LINK_BROKEN`,
`E_HASH_LINK_ESCAPE`, `E_HASH_LINK_CYCLE`, `E_IMPORT_SOURCE_CHANGED`,
`E_HASH_DUPLICATE_PATH`, `E_HASH_CANONICAL_JSON`, `E_HASH_IJSON`.
