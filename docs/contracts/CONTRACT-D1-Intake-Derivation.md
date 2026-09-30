# Contract D1: owned intake derivation

Contract D1 creates a reviewable owned derivative from one immutable Contract
A1 stage. It never edits the upstream source or the original candidate stage.
It is a staging contract only; review, release, and publication remain separate
operations.

## Patch proposal

The patch envelope has `object_type: ega.derivation-patch` and
`schema_version: 1`. Its payload contains exactly:

- `skill_id` and `path` identifying the staged source file;
- `expected_digest` for the exact raw input bytes;
- the complete replacement text;
- a non-empty human reason and `rule_version`.

The derivation envelope has `object_type: ega.derivation-plan` and
`schema_version: 1`. Its `D1` payload binds the A1 candidate digest, source
snapshot digest, original root and version (or `null` for an invalid candidate
that is being repaired), exact input-file digest, patch digest, target owned
ID/root, predicted derived version hash, and a provenance receipt containing
the source locator, Git identity when applicable, selected root, provenance
files, and raw snapshot digest.

## Apply and identity

`ega-skills hub intake derive --candidate <plan.json|digest> --patch
<patch.json> --owned-id <namespace/name> <hub-dir>` verifies the A1 stage,
checks the exact input digest, applies the replacement only in a temporary
copy, and reruns the canonical preparation pipeline. The resulting version
hash must equal the proposal prediction before the new stage is atomically
created at `.intake-staging/<derivation-digest>/`.

The stage contains the derived skill under `source/` and
`derivation-plan.json` outside the hashed skill package. Repeating the same
operation is idempotent. A changed source file, changed patch, invalid strict
candidate, or different existing owned target fails without overwriting any
bytes. A blocked A1 plan may be staged for an explicit compatibility repair
when it has no source/namespace conflict; A2 adoption still rejects it.

Supported repairs are explicit field removal or replacement, including an
unsupported frontmatter field and a reviewed description rewrite. The system
does not truncate text, silently rename a skill, or replace an upstream ID.
