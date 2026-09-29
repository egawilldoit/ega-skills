# Artifact

- Export: `hub release export`
- Artifact path (candidate): the exported bundle committed to `packages/mcp/artifact/`
- Validator: `node scripts/hosted/validate-artifact.mjs <artifact>`
- Result: `OK digest=sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77 hub=personal skills=114`
- NEW_CATALOG_RELEASE_DIGEST: `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77`

## Inventory
- 114 = mattpocock 25 + anthropic 14 + vercel 9 + egawilldoit 66
- Original 48 version hashes identical to parent: 48/48
- Excluded IDs absent: cursor/architect, cursor/setup-pstack, anthropic/docx,
  anthropic/pdf, anthropic/pptx, anthropic/xlsx, anthropic/doc-coauthoring

## Source-independent serving (artifact only)
- MCP started from the exported artifact only (no source checkout in the runtime
  CWD): see `artifact-mcp-smoke-result.json`
- `releaseDigest`: `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77`
- tools: `get_content,inspect,resolve,search` (exactly 4)
- Representatives inspect + get_content PASS: 7/7
  (mattpocock/diagnosing-bugs, anthropic/mcp-builder, vercel/react-best-practices,
  egawilldoit/understand-codebase, egawilldoit/design-architecture,
  egawilldoit/certify-release, egawilldoit/verify-cli)
- search returns egawilldoit matches; resolve selects `egawilldoit/understand-codebase`
  for "Explain how this subsystem works before I modify it".

## Read-only proof
- `artifact-manifest-before.sha256` vs `artifact-manifest-after.sha256`:
  identical → artifact mutation = 0.
