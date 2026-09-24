# Contract Q1: deterministic intake quality

Q1 is a read-only inspection artifact over an intake source. It reuses the
canonical preparation, hashing, schema, and token logic used by import
planning. It does not edit source files, create registry state, or generate
content.

## Command and envelope

```text
ega-skills intake quality <folder> --namespace <namespace> --output <report.json>
```

The output is an `ega.intake-quality-report` schema-1 envelope. Its payload is
bound to the import source snapshot digest and contains the quality policy
revision, each candidate's Skill ID/version identity, routing fields, token
counts, diagnostics, and deterministic summary counts. The output must be
outside the source tree.

## Diagnostics

Diagnostics are sorted by code, severity, file, field, candidate, and related
IDs. Each diagnostic has a stable code, severity (`INFO`, `WARNING`, or
`ERROR`), relative file, field, candidate and related IDs, machine-readable
details, and a suggested action.

The deterministic checks include schema/import diagnostics, missing or
oversized/out-of-target L1, L2 token counts, broken Markdown companion links,
generic platform metadata, missing triggers, missing anti-triggers, alias
conflicts, and duplicate canonical `SKILL.md` bodies. Missing anti-triggers are
informational and do not block intake. A generic platform is diagnosed with
the safe replacement: remove it and use an empty platform list for unrestricted
compatibility.

Duplicate main bodies are reported only; companion files, Skill IDs, and
version identities are never merged automatically. Any future AI suggestions
must be a separate, explicitly accepted artifact and cannot change Q1 output.

## Evaluation evidence

`tests/evaluation/routing-corpus.json` contains 30 reviewed English/French,
near-match, and no-skill tasks. `scripts/eval/routing.mjs` runs the actual
registry search and resolver in an isolated temporary registry and records
search IDs separately from resolved selections, resolver reasons, selected
levels, token counts, release digest, and metadata revision.
