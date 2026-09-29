# Post-production release record — catalog-2026-09-29.1

> **This evidence was collected AFTER catalog tag creation and after production
> promotion.** It is additive. It does not rewrite the immutable tagged history
> and it does not retro-date any fact.
>
> The pre-existing files in this directory describe the state as it stood at tag
> creation and are left untouched. Where they disagree with this file, this file
> records what was later observed; where they were correct for their timestamp,
> they remain correct for that timestamp. Specifically:
>
> - `final.md` is a **pre-merge candidate verdict** and was never advanced.
> - `review-r2.md` is a **pre-production review**; several of its findings were
>   later disproven or resolved in production.
> - `production-baseline.md` is a **pre-deployment** baseline and is superseded
>   by the deployment record below.

---

## 1. Release identity (immutable)

| Field | Value |
|---|---|
| Catalog ID | `catalog-2026-09-29.1` |
| Catalog tag | `catalog-2026-09-29.1` (annotated) |
| Tag object | `37c737c58936fd19460b45fce7a5853bb13e6b93` |
| Tag target | `2ab47e6b370ab7b3e1cd66f0f987cb00a9b33892` |
| Catalog Git SHA | `2ab47e6b370ab7b3e1cd66f0f987cb00a9b33892` |
| `origin/release/2.0` | `2ab47e6b370ab7b3e1cd66f0f987cb00a9b33892` |
| Catalog digest | `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77` |
| Parent catalog | `catalog-2026-09-24.1` → `22d58320ed9eb5f11759ef7a9f4423c9b165f083` |
| Source pin | `egawilldoit/skills` @ `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df` |
| Product | EGA Skills 2.0.0 (`v2.0.0` → `065421c03909089eb6077c1d285af24121329862`) |
| Merge | PR #119, merged `2026-09-29T11:17:36Z`, head `ff79cf14a515c6efb163b6e0b45111058baaa81d` |

Unchanged and verified at closure time: `v2.0.0` still `065421c0…`,
`catalog-2026-09-24.1` still `22d58320…`, source pin still `f48e0ed…`.

## 2. Production deployment record (post-cutover)

| Field | Value |
|---|---|
| Canonical URL | `https://ega-skills-mcp.vercel.app` |
| Deployment | `ega-skills-oqbllomzn-egas-projects-4fb87621.vercel.app` |
| State | `READY` |
| Git SHA served | `2ab47e6b370ab7b3e1cd66f0f987cb00a9b33892` |
| Deployed explicitly as | a Vercel git-pinned deployment of the exact catalog SHA |
| Retained rollback target | `ega-skills-idezkq62c-egas-projects-4fb87621.vercel.app` (Git SHA `185b8e3f…`, previous parent catalog) |

Merge guard: the project ignore-build step was set to `exit 0` **before** the
merge, so the merge-window deployment (`ega-skills-kynv06h6q…`) reached state
`CANCELED` and production was not replaced by the merge itself. The guard was
restored to its previous value (`null`) after the explicit deploy.

## 3. Production baseline (read-only, re-verified at closure)

| Check | Result |
|---|---|
| `GET /healthz` | 200 `{"status":"ok"}` |
| `GET /readyz` | 200 `{"status":"ready"}` |
| `GET /.well-known/oauth-protected-resource` | 200 |
| `GET /.well-known/oauth-protected-resource/mcp` | 200 |
| Authorization-server metadata (at the Supabase issuer) | 200 |
| Anonymous `POST /mcp` | 401 |
| `WWW-Authenticate` | valid `Bearer resource_metadata=…` challenge |
| Hostile `Origin` | 403 |
| Unknown route | 404 |
| Tools advertised | exactly 4 — `get_content`, `inspect`, `resolve`, `search` |
| Effective release digest (from `search`) | `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77` |

Representative skills confirmed live in production:

| Skill | Version hash |
|---|---|
| `egawilldoit/certify-release` | `sha256:6cf6aedc14e04689b2c3723da51a9712b27f7b9c67dc172c8fe08504947861fe` |
| `mattpocock/diagnosing-bugs` | `sha256:f56e6a33a7200be2f172c455ca35718a3345deb3e65ffb250b2c4fe6718ebf48` |

Inventory: **114** — mattpocock 25, anthropic 14, vercel 9, egawilldoit 66.
All 114 version hashes matched the shipped artifact; all 7 excluded IDs
remained unavailable; 9 production routing smoke cases passed.

## 4. Exact-SHA CI (all four runbook-required checks)

| Workflow | Run | Conclusion | Jobs |
|---|---|---|---|
| CI | `36560835165` | success | contract-f rls (ubuntu-latest), foundation (ubuntu-latest), foundation (windows-2022) — all success |
| Hashing traversal verification | `36560835215` | success | hashing traversal (ubuntu-latest), hashing traversal (windows-2022) — all success |

## 5. Client acceptance

| Client | Version | OAuth | Tools | search | resolve | inspect | get_content |
|---|---|---|---|---|---|---|---|
| Direct MCP (main-agent probe) | n/a | delegated OAuth PASS | 4 | PASS | PASS | PASS | PASS |
| Codex | `codex-cli 0.158.0` | PASS (`Auth: OAuth`, transport `streamable_http`) | 4 | PASS | PASS | PASS | PASS |
| OpenCode | `1.18.33` | PASS (real `opencode mcp auth`, own DCR client + PKCE S256) | 4 | PASS | PASS | PASS | PASS |

Codex used an isolated `CODEX_HOME`; OpenCode used isolated
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`. Neither
touched the operator's normal client configuration. Observed negotiated protocol
by OpenCode: `2025-11-25` (the server's maximum supported version; it does not
negotiate `2026-07-28`).

## 6. Cross-client parity (exact equality required)

`egawilldoit/certify-release` (L2):

| Metric | Direct MCP | Codex | OpenCode |
|---|---|---|---|
| version_hash | `sha256:6cf6aedc…47861fe` | same | same |
| content bytes | 3636 | 3636 | 3636 |
| content sha256 | `sha256:08c2a1df…34540f7` | same | same |
| effective release digest | `sha256:1efdbc3d…de31b77` | same | same |

`mattpocock/diagnosing-bugs` (L2):

| Metric | Direct MCP | Codex | OpenCode |
|---|---|---|---|
| version_hash | `sha256:f56e6a33…18ebf48` | same | same |
| content bytes | 8529 | 8529 | 8529 |
| content sha256 | `sha256:77f3cf31…5af3e84` | same | same |

All three clients agree exactly. Each `content_sha256` was independently
cross-checked against the `inspect` manifest `SKILL.md` `blob_hash` and
`byte_size`, so `inspect` and `get_content` also agree.

## 7. Credential closure

- The exposed privileged credential was classified structurally (values never
  printed) as a **legacy `service_role` JWT** (`HS256`, no `kid`,
  `iss=supabase`, long-lived expiry) — **not** a modern individually-revocable
  secret key.
- Production is configured with the same legacy class, so no modern replacement
  exists, and the project's secret-key management surface is unavailable
  (404). There is therefore **no safe individual revoke path**.
- **Rotation was deliberately not performed**: revoking it requires rotating the
  project-wide HS256 JWT signing secret, which would invalidate the `anon` key,
  every `service_role` JWT, and all user access tokens for every consumer of the
  project. Tracked as issue **#121** with the migration path.
- 50 release-scope credential files were inventoried and purged; 6 of them held
  the live key and 2 of those were group/other-readable. Post-purge rescan:
  **0 files** containing `service_role` JWT material.
- 1281 tracked files of the release commit were scanned against the exact
  credential bytes and every JWT in the environment snapshot: **0 hits** — the
  credential is not in the repository, the artifact, or committed evidence.
- Production re-verified healthy after purge.

## 8. Review-finding closure ledger

| Finding | Disposition after production |
|---|---|
| R1 P1-1 (source pin labeling) | RESOLVED — trees byte-identical, recorded in `source.md` |
| R1 P1-2 (wrong tree digest) | RESOLVED — corrected to `sha256:781191b7…` |
| R1 P2-1 (artifact omits license blobs) | ACCEPTED / documented in `provenance.md` |
| R1 P2-2 (parent approval recovery) | CLARIFIED — verified against the parent hub |
| R2 F1 (self-contradicting adjudication) | RESOLVED — adjudication rewritten for the final run |
| R2 F2 (stale artifact-only proof) | RESOLVED — re-run against `1efdbc3d…` |
| R2 F3 (no release SHA) | RESOLVED — `2ab47e6b…` |
| R2 F4 (stale tree digest) | RESOLVED |
| R2 F5 (production env insufficient) | **DISPROVEN** — the env snapshot used at review time was stale; the live project env carries `EGA_HOSTED_RESOURCE_URL`, `EGA_HOSTED_AUTHZ_JSON`, `EGA_HOSTED_AUDIENCE`, `EGA_HOSTED_ISSUER`, `EGA_HOSTED_JWKS_URL`, `EGA_HOSTED_ARTIFACT_DIR`, `EGA_HOSTED_ALLOWED_ORIGINS`, Supabase URL + secret, with **no** static-token mode. `/readyz` 200 proves startup validation passes |
| R2 F6 (temp credential) | PURGED + tracked as #121 |
| R2 F7 (registry absolute paths) | **RECLASSIFIED** — not dormant: confirmed served by `inspect` on every call. Tracked as **#123** |
| R2 F8 (runbook digest command) | **FIXED** in this closure (`.release_digest` → `.digest`, plus the stale `RELEASE-2.0-FINAL.md` cross-reference) |

New findings raised by client acceptance:

| Finding | Tracked |
|---|---|
| `inspect`/`get_content` declare `release_digest` optional but require it at runtime; schema-valid calls fail with `E_RELEASE_MISMATCH`. Reproduced independently by both real clients. | **#124** |
| `E2E-01` fails on this VM, identically at the pre-catalog base `185b8e3f…`; real bound is a 2 s fixed-count poll, not 20 s. CI green. | **#122** |

## 9. Known open issues carried forward

- **#117** — governed metadata overlays for immutable third-party sources (OPEN, future architecture work).
- **#120** — local/git multi-skill root normalization between plan and stage (OPEN; explicit repeated roots remain the proven workaround).
- **#121** — legacy `service_role` credential: migration to revocable secret keys (OPEN).
- **#122** — E2E-01 local VM failure / CI parity (OPEN).
- **#123** — build-host absolute paths in exported registry provenance, served by `inspect` (OPEN).
- **#124** — `release_digest` schema/runtime under-specification (OPEN).

## 10. Release gate verdict

| Gate | Result |
|---|---|
| **CODE** | PASS — exact-SHA CI green (4/4 required checks), artifact validates 114, routing blockers 0, R1/R2 reviews satisfied |
| **RUNTIME** | PASS — exact artifact deployed on `2ab47e6b`, health/ready/OAuth PASS, direct MCP PASS, inventory 114 exact, all 114 version hashes matched |
| **PRODUCT** | PASS — Codex tool invocation PASS, OpenCode tool invocation PASS, cross-client parity PASS |

**Verdict: CATALOG RELEASED TO PRODUCTION — PRODUCT_READY.**

## 11. Manual follow-up

ChatGPT Web validation remains manual. The only client certification not executed
by automation is the ChatGPT Web path; the Direct MCP, Codex, and OpenCode paths
are all certified above.
