# Deployment artifact provenance — catalog-2026-10-06.1

Built with the existing Contract C build (`buildHubRelease` / `hub release export`);
no fixtures, no examples, no invented content.

Built by advancing the governed `mattpocock` namespace from pin
`c55ee46073ed923f86ce59a5eb3b6d895095d1b7` to the exact upstream release
`v1.3.1` = `24fe0ef7737efae15c87225755e9f6f5965e4888`. This is a CATALOG
release: the software remains EGA Skills 2.0.1; no frozen runtime code changed.

Release digest: sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3
Hub id: personal
Skills: 116 (mattpocock 27, anthropic 14, vercel 9, egawilldoit 66)

Parent catalog: catalog-2026-09-29.2 -> 9c8b0eb98cc608bdc727287fdeb285040fb2771a
Parent digest: sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77
Parent skills: 114 (mattpocock 25, anthropic 14, vercel 9, egawilldoit 66)

Evidence: docs/evidence/catalog/catalog-2026-10-06.1/

## Catalog ID resolution (previously inconsistent)

This file previously said `catalog-2026-09-29.1` while `README.md` said
`catalog-2026-09-29.2`. Resolved from evidence, not preference: the promoted
catalog identity was `catalog-2026-09-29.2`. Its tag
(`catalog-2026-09-29.2`) points at `9c8b0eb9…`, that commit is the deployed SHA
recorded in the `catalog-2026-09-29.2` post-production record, and the live MCP
reported `effective_release_digest` `sha256:1efdbc3d…`. `PROVENANCE.md` was the
stale document (last touched at the `.1` publish commit `401d5ae`; the `.2`
republication commit `665f608` updated `README.md` but not this file). This
release supersedes both with `catalog-2026-10-06.1`, allocated by the existing
`catalog-<date>.<n>` convention for a genuine catalog-content change.

## Source change (catalog-2026-10-06.1): mattpocock 25 -> 27

- mattpocock (mattpocock-owned): https://github.com/mattpocock/skills
  @ 24fe0ef7737efae15c87225755e9f6f5965e4888 (tag v1.3.1, annotated tag
  object 0b6cee10f260a2e048279cf737bfd3e37b1fce0b, commit date
  2026-10-04 13:48:05 +0100)
  previous pin: c55ee46073ed923f86ce59a5eb3b6d895095d1b7 (2026-09-18)
  roots: skills/engineering/* (20) + skills/productivity/* (7)
  provenance: LICENSE (MIT, repo-level; byte-identical across both pins)
  Every selected file byte-verified against the upstream git blobs at the pin
  (79 files, 0 mismatches).
- added: mattpocock/implement-spec, mattpocock/pr, mattpocock/retro
- removed: mattpocock/resolving-merge-conflicts (no replacement upstream; not
  aliased, because no frozen contract requires a compatibility alias)
- changed: 9 existing Matt skills; 15 Matt skills unchanged
- The 89 non-Matt SkillVersions (anthropic 14, vercel 9, egawilldoit 66) are
  byte-identical to the parent release. 89/89.

The sections below document the inherited provenance for the unchanged
namespaces and remain the provenance of record for them.

## Documented minimal content repair (Contract D1)

- `mattpocock/pr` (MIT): frontmatter field removal. Upstream ships a NESTED
  `metadata.credits` mapping. The portable Agent Skills specification defines
  `metadata` as "a map from string keys to string values", and SPEC-001 §5.1.6
  freezes the same type, so the strict V1 schema rejects it
  (`E_SKILL_FRONTMATTER_INVALID`) and the A1 plan is BLOCKED. EGA matches the
  published portable spec; upstream is the non-conformant party.
  The repair removes only the unsupported nested `metadata` block. `name`,
  `description` and the entire instruction body remain byte-identical, and the
  attribution is retained in the unmodified `pr/CREDITS.md` which ships in the
  same skill root.
  original sha256: sha256:ab63f1cf78647389edcd386c9427c5dfca27ed2836930c24773ffee834c19bcd
  repaired  sha256: sha256:251c58e16de82f462b1c43065ddf5b774fb5f7a4b4f1848b04d7e04792288246
  SkillVersion:  sha256:43174df8327ef089949f5dce65bc2bc893d8aa280f3efdb91092a67633f59adc
  rule_version:  catalog-matt-v131-pr-nested-metadata-1
  Applied through `hub intake derive` (Contract D1) against the immutable
  BLOCKED stage, then reviewed and adopted. No frozen contract was amended.

## EGA routing overlays carried forward (re-justified, both unchanged)

Both existing Matt overlays were re-checked against the v1.3.1 upstream text.
Neither upstream description changed in v1.3.1, so the original justification
still holds and both overlays are preserved byte-for-byte. See
`docs/evidence/catalog/catalog-2026-10-06.1/governance.md`.

- `mattpocock/diagnosing-bugs`: {"triggers": ["never exits", "hangs", "root cause"]}
  reason: the brief-mandated collision prompt has zero lexical overlap with the
  natural description; the v1.3.1 body still contains none of those phrases.
- `mattpocock/tdd`: {"triggers": ["test-first", "red green refactor", "red-green-refactor"]}
  reason: test-first build prompts must outrank planning/wayfinder vocabulary;
  the spaced "red green refactor" variant is still absent from upstream prose.

No overlay was added, removed, or edited. In particular, no routing metadata was
added for `implement-spec` or `retro`: both are `disable-model-invocation: true`,
and SPEC-001 §5.1.6.4 forbids automatic routing from ever selecting them, so
adding triggers to steer automatic routing would contradict a frozen rule.

The following inherited overlays are unchanged by this release and remain as
documented in the parent records: `anthropic/claude-api`,
`anthropic/mcp-builder`, `vercel/react-best-practices`, `vercel/deploy-to-vercel`,
`vercel/vercel-cli-with-tokens`.

## Parent catalog provenance

## Sources (pinned reviewed commits; every unpatched file byte-verified against the pin)

- mattpocock (mattpocock-owned): superseded by this release; see above.
- anthropic-owned: https://github.com/anthropics/skills@34040c9c568585f6929bedeaad110ad08f079624
  roots: the 14 licensed skill directories (per-skill Apache-2.0 LICENSE.txt at pin)
  excluded and never staged: docx, pdf, pptx, xlsx (EXCLUDED_LICENSE, proprietary);
  doc-coauthoring (EXCLUDED_NO_LICENSE, release-authority amendment)
- vercel-owned: https://github.com/vercel-labs/agent-skills@063bee94c3f4df8453406c830b0a7df0f2860278
  roots: skills/* (9 approved directories; MIT per README ## License at pin)
  ZIP packaging duplicates excluded (5 top-level + Archive.zip)

Why local-owned adoption: ega.yaml routing metadata is required inside each
namespace, and the platform namespace model forbids mixing an adopted Git
source with owned routing-metadata trees in one namespace. Every unpatched
file is byte-identical to the pinned upstream blobs (audited; see
docs/evidence/catalog/catalog-2026-09-24.1-final.md).

## Documented minimal content repairs (license-permitted, review-bound, provenance-bound)

- `anthropic/claude-api` (Apache-2.0 (per-skill LICENSE.txt)): field `description` — SPEC-001 description limit: parsed 1071 code points > 1024. Meaning-preserving compression of the TRIGGER clause (scaffolding words removed; every trigger condition, provider list, and SKIP clause preserved verbatim). Sanctioned D1 repair class: reviewed description rewrite.
  original sha256: sha256:8227f0d1192594bfea04df6c9f1d9d727dd300c3f4b2c42d315dd9fe58b1a421
  repaired sha256: sha256:3e85b0cc9cc35ba167a18544766fc930f0841f6e151a7c0b708ad3f5936baabd
- `vercel/composition-patterns` (MIT (README.md ## License, repository-scoped)): field `name` — SPEC-001 requires frontmatter name == directory name; upstream frontmatter "vercel-composition-patterns" prefixes the directory name "composition-patterns" with the redundant namespace token, making import impossible. Trimmed to the brief-mandated EGA logical ID (catalog-reset brief sections 7 and 11). Reviewed, documented repair — not a silent rename.
  original sha256: e38e0eaa609316b10423a9a138ed95e35099accd3f735585295c8a8f165c28a3
  repaired sha256: 4867652abc03e7a9e12aeafaf4e20933d667877d654042a85fa104aa1c1c1ab6
- `vercel/react-best-practices` (MIT (README.md ## License, repository-scoped)): field `name` — SPEC-001 requires frontmatter name == directory name; upstream frontmatter "vercel-react-best-practices" prefixes the directory name "react-best-practices" with the redundant namespace token, making import impossible. Trimmed to the brief-mandated EGA logical ID (catalog-reset brief sections 7 and 11). Reviewed, documented repair — not a silent rename.
  original sha256: 71ed7794962fa6e803ee83030517b5b93a9f70fbfeb431ec4535c5480a8d8355
  repaired sha256: 74e45648634f8bc59ac21ffb1de71095dc53d15667344084c89315b7834710ab
- `vercel/react-native-skills` (MIT (README.md ## License, repository-scoped)): field `name` — SPEC-001 requires frontmatter name == directory name; upstream frontmatter "vercel-react-native-skills" prefixes the directory name "react-native-skills" with the redundant namespace token, making import impossible. Trimmed to the brief-mandated EGA logical ID (catalog-reset brief sections 7 and 11). Reviewed, documented repair — not a silent rename.
  original sha256: 4012750a5ccbe064ca04af3835d5d1b011979d2d09d9b6df1c8128fac58e0a66
  repaired sha256: 6d4133d2c2e80642e1f08bacb53e884fe1d9bf52c35d6cd557dd730e81d7391b
- `vercel/react-view-transitions` (MIT (README.md ## License, repository-scoped)): field `name` — SPEC-001 requires frontmatter name == directory name; upstream frontmatter "vercel-react-view-transitions" prefixes the directory name "react-view-transitions" with the redundant namespace token, making import impossible. Trimmed to the brief-mandated EGA logical ID (catalog-reset brief sections 7 and 11). Reviewed, documented repair — not a silent rename.
  original sha256: 1520343c8814c972fee001cac6d6185976d6eb3f4edcac33afe95c10f3b3228b
  repaired sha256: bdb77732d3efdc901883329a2c2e6a0d8313301ef10571bd25df765d084ad6c7
## EGA routing metadata (ega.yaml additions — metadata only, content untouched)

- `mattpocock/diagnosing-bugs`: {"triggers": ["never exits", "hangs", "root cause"]}
  reason: brief-mandated collision prompt has zero lexical overlap with the natural description; trigger evidence required.
- `mattpocock/tdd`: {"triggers": ["test-first", "red green refactor", "red-green-refactor"]}
  reason: test-first build prompts must outrank planning/wayfinder vocabulary.
- `anthropic/claude-api`: {"anti_triggers": ["gemini", "openai", "gpt", "langchain", "langchain_openai", "ollama", "mistral", "cohere", "llama"]}
  reason: encodes the description's own SKIP rule; competitor migration/debugging tasks must not select it.
- `anthropic/mcp-builder`: {"triggers": ["build an mcp server", "implement an mcp server", "mcp server exposing"], "anti_triggers": ["diagnose", "fails at startup", "crash", "existing mcp server"]}
  reason: build-intent triggers; runtime-crash debugging and client-side connection config must not select it.
- `vercel/react-best-practices`: {"triggers": ["unnecessary rerenders", "render waterfall", "slow page"]}
  reason: collision cluster: render-performance prompts must rank react-best-practices above composition-patterns/react-view-transitions.
- `vercel/deploy-to-vercel`: {"triggers": ["deploy my app", "give me the link", "push this live", "create a preview deployment"], "anti_triggers": ["access token", "cache"]}
  reason: explicit deploy intent beats vercel-cli-with-tokens; token-context and cache-behavior questions are not deployment intents.
- `vercel/vercel-cli-with-tokens`: {"anti_triggers": ["dashboard"]}
  reason: dashboard questions are not token-based CLI usage.

## Exclusions (intentional; do not count as failures)

- EXCLUDED_LICENSE (4): anthropic/docx, anthropic/pdf, anthropic/pptx, anthropic/xlsx — proprietary Anthropic PBC; never staged or exported.
- EXCLUDED_NO_LICENSE (1): anthropic/doc-coauthoring — no explicit license at the pin; never imported, staged, persisted, exported, or served.

## Reproduce

Build: `hub intake plan/stage/review/apply` for each source, then the D1
derivation for `mattpocock/pr`, then `hub release preflight` →
`hub release preview` (against the previous release) → `hub release export` →
`node scripts/hosted/validate-artifact.mjs packages/mcp/artifact`.
The exact commands, pins, digests and approvals are in
`docs/evidence/catalog/catalog-2026-10-06.1/`.

Validate: node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
Evidence: docs/evidence/catalog/catalog-2026-10-06.1/
