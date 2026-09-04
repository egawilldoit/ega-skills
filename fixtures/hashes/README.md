# Frozen hash fixtures (SPEC-002 §5.1.20)

`vectors.json` commits the expected blob and SkillVersion hashes that MUST be
byte-identical on Linux and Windows.

Covered: CRLF/LF convergence, BOM/no-BOM convergence, NFC/NFD distinctness,
`ega.yaml`-formatting invariance, and a minimal-skill version hash.

Rules:

- Asserted in CI on both `ubuntu-latest` and `windows-latest`.
- Update ONLY through an explicit reviewed spec amendment (hash schema bump).
- Token recount MUST NOT alter these version hashes.
- Current hash schema: `1` (`SKILL_VERSION_HASH_SCHEMA_VERSION`).
