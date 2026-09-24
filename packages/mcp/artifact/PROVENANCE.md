# Deployment artifact provenance — catalog-2026-09-24.1

Built with the existing Contract C build (`buildHubRelease` / `hub release export`);
no fixtures, no examples, no invented content.

Built by the clean 49→48-skill catalog reset (release-authority amendment 2026-09-24).
This is a CATALOG release: the software remains EGA Skills 2.0.0 (v2.0.0 →
065421c03909089eb6077c1d285af24121329862); no frozen runtime code changed.

Release digest: sha256:55b9dba5e0274dc0640c742a8f2ceab2889c1ef312ca16d1b4f9387cb30f752f
Hub id: personal
Skills: 48 (mattpocock 25, anthropic 14, vercel 9)

## Sources (pinned reviewed commits; every unpatched file byte-verified against the pin)

- mattpocock (mattpocock-owned): https://github.com/mattpocock/skills@c55ee46073ed923f86ce59a5eb3b6d895095d1b7
  roots: skills/engineering/* (18), skills/productivity/* (7)
  provenance: LICENSE (MIT, repo-level)
  byte-identity: audited per file vs git blobs at the pin
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

Build: hub plan/stage/review/apply from the three pinned-source trees, then
`hub release preflight` → `hub release preview` (against the previous release)
→ `hub release export` → `node scripts/hosted/validate-artifact.mjs packages/mcp/artifact`
Validate: node scripts/hosted/validate-artifact.mjs packages/mcp/artifact
Evidence: docs/evidence/catalog/catalog-2026-09-24.1-final.md
