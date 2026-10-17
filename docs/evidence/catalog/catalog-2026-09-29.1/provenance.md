# Provenance

Per-skill provenance for all 66 egawilldoit skills records: source repository,
commit pin, selected root, version hash, selected tree digest, vendored snapshot
digest.

- Source repository: `https://github.com/egawilldoit/skills`
- Resolved commit (pin): `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df`
- `selected_skill_tree_digest`: `sha256:781191b7746188fd6c7392efbe168906c62ad43ff8a6f7bf683c8e3b6e59ab30`
- `vendored_snapshot_digest`: `sha256:4ca997798d8d0b09fdaf3036029cac59a0d017b25b356b7c5471183fe36c0943`

(Values read from `hub/sources.lock.yaml` and independently recomputed with the
official `digestStagedTree()` over `hub/external/egawilldoit-skills/repo`.)

- 66/66 provenance coverage; unknown provenance = 0.
- `upstream-sources.json`: 66 entries (mode: copied 32, adapted 24, original 10).
  Copied/adapted skills retain upstream lineage; e.g. `adversarial-review` ←
  `cursor/plugins` `interrogate`, mode `adapted`, MIT.
- Original 48 owned namespaces (anthropic/mattpocock/vercel) retain their
  original adoption provenance from `catalog-2026-09-24.1`.

FACT: 48 existing SkillVersion hashes are byte-identical to parent
`catalog-2026-09-24.1` (48/48).

NOTE (P2): the exported artifact's `cache/` does not embed the `LICENSE`,
`THIRD_PARTY_NOTICES.md`, or `upstream-sources.json` blobs; their digests are
bound into the adopted-source snapshot digest. Attribution text therefore lives
in the source/bundle, not the source-independent artifact.
