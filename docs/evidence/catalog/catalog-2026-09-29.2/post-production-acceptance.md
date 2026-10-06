# Post-production release record — catalog-2026-09-29.2

> **Collected AFTER catalog tag creation and AFTER production promotion.**
> Additive. The immutable tagged history is not rewritten, and nothing below was
> known at tag time.

## 1. Immutable identity

| identity | value |
|---|---|
| catalog tag | `catalog-2026-09-29.2` → `9c8b0eb98cc608bdc727287fdeb285040fb2771a` |
| software tag | `v2.0.1` → `8ef464ee9f4e75dceecf1324cbbff3c451ead909` |
| parent catalog | `catalog-2026-09-29.1` → `2ab47e6b370ab7b3e1cd66f0f987cb00a9b33892` |
| source pin (unchanged) | `egawilldoit/skills` @ `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df` |
| unmoved | `v2.0.0` → `065421c0…`, `catalog-2026-09-24.1` → `22d58320…` |

### Three identities

| kind | value |
|---|---|
| **software** | `v2.0.1` → `8ef464ee9f4e75dceecf1324cbbff3c451ead909` |
| **semantic catalog** | `release_digest` → `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77` |
| **physical artifact** | `registry.sqlite` → `sha256:ec83966dfd5a3bdd5edc34b1842d6a314b5ced9d689763168c2412cd19418729` |

`release_digest` is **unchanged** from the parent and that is correct: it proves
*semantic* catalog identity and does not cover `skill_sources` provenance rows.
This catalog is therefore distinguished from its parent by the **physical**
artifact identity, not by `release_digest`. This is recorded design debt, not a
defect — see §7.

Reproduce the physical identity from the repository root:

```
sha256sum packages/mcp/artifact/registry.sqlite
# ec83966dfd5a3bdd5edc34b1842d6a314b5ced9d689763168c2412cd19418729

find packages/mcp/artifact -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum
# f5a1ddae2bc645881e500653321c843e68d7b4ddb311e759b49a521e6404c65a   (845 files)
```

## 2. Exact-SHA CI at the catalog commit

| run | jobs | result |
|---|---|---|
| `36696275182` (CI) | foundation ubuntu-latest, foundation windows-2022, contract-f rls | **success** |
| `36696275307` (hashing traversal) | ubuntu-latest, windows-2022 | **success** |

## 3. Production deployment

| | |
|---|---|
| canonical URL | `https://ega-skills-mcp.vercel.app` |
| deployment | `ega-skills-2edzorm3z-egas-projects-4fb87621.vercel.app` |
| state | `READY` |
| git SHA served | `9c8b0eb98cc608bdc727287fdeb285040fb2771a` — **exact match** |
| holds canonical alias | yes |

Deploy sequence: the ignored-build guard was set to `exit 0` before each
production-branch merge, read back, allowed to propagate, and every
merge-window deployment was confirmed **CANCELED**. The guard was then restored
to `null` and the exact catalog commit deployed explicitly.

## 4. Post-production acceptance — 0 failures

| check | result |
|---|---|
| `GET /healthz` | 200 `{"status":"ok"}` |
| `GET /readyz` | 200 `{"status":"ready"}` |
| `GET /.well-known/oauth-protected-resource` | 200, resource `/mcp`, authorization_servers = Supabase auth/v1 |
| anonymous `POST /mcp` | 401 + valid `WWW-Authenticate` resource-metadata challenge |
| hostile `Origin` | 403 |
| unknown route | 404 |
| tools advertised | exactly 4 — `get_content`, `inspect`, `resolve`, `search` |
| `effective_release_digest` | `sha256:1efdbc3d…` |

### Runtime path invariant (the proof that matters here)

Full sweep of **every** served skill, 114/114:

| | |
|---|---|
| `local_path` logical/relative | **114/114** |
| host-absolute paths in any `inspect` response | **0** |
| host-absolute paths in `get_content` (decoded) | **0** |
| rows retaining the old build-host prefix `/home/ubuntu/worktrees/` | **0** |

Zero rows retaining the old prefix is what proves the sanitized catalog
**replaced** the old one rather than overlaying it.

Observed live:

| skill | `local_path` |
|---|---|
| `egawilldoit/certify-release` | `external/egawilldoit-skills/repo/skills/certify-release` |
| `mattpocock/diagnosing-bugs` | `owned/mattpocock-owned/diagnosing-bugs` |
| `anthropic/mcp-builder` | `owned/anthropic-owned/mcp-builder` |
| `vercel/react-best-practices` | `owned/vercel-owned/react-best-practices` |

Scanning method: **decoded** values only, host patterns anchored to `/home/`,
`/Users/`, `/tmp/`, `/var/task`. A generic `[A-Za-z]:[\\/]` alternative is
deliberately excluded — it matches the escaped newline in ordinary prose
("…**tighten** it:") and produces phantom findings.

## 5. Client certification

| client | version | OAuth | tools | search | resolve | inspect | get_content |
|---|---|---|---|---|---|---|---|
| Direct MCP | — | delegated PASS | 4 | PASS | PASS | PASS | PASS |
| Codex | 0.159.1 | PASS (`Auth: OAuth`, `streamable_http`) | 4 | PASS | PASS | PASS | PASS |
| OpenCode | 1.18.33 | PASS (real DCR + PKCE S256) | 4 | PASS | PASS | PASS | PASS |

### Both release-pin forms

| form | Direct MCP | Codex | OpenCode |
|---|---|---|---|
| `release_digest` only | PASS | PASS | PASS |
| `context_id` only | unauthorized → fail closed | `E_CONTEXT_UNAVAILABLE` | `E_CONTEXT_UNAVAILABLE` |
| **neither** | `Input validation error: … Missing required selector: provide release_digest or context_id` | identical | identical |
| unknown `release_digest` | `E_RELEASE_MISMATCH`, no content | fail closed | fail closed |
| both, disagreeing | `E_RELEASE_MISMATCH`, no content from either release | fail closed | fail closed |

Neither-selector produced an **argument-validation** failure in all three
clients and never surfaced `E_RELEASE_MISMATCH`.

## 6. Cross-client byte parity — EQUAL

`egawilldoit/certify-release`

| metric | Direct MCP | Codex | OpenCode |
|---|---|---|---|
| `version_hash` | `sha256:6cf6aedc…47861fe` | same | same |
| content bytes | 3636 | 3636 | 3636 |
| content sha256 | `sha256:08c2a1df…34540f7` | same | same |

`mattpocock/diagnosing-bugs`

| metric | Direct MCP | Codex | OpenCode |
|---|---|---|---|
| `version_hash` | `sha256:f56e6a33…18ebf48` | same | same |
| content bytes | 8529 | 8529 | 8529 |
| content sha256 | `sha256:77f3cf31…5af3e84` | same | same |

Content is byte-identical to the values certified for `catalog-2026-09-29.1`,
confirming the provenance sanitization changed no skill content.

## 7. Recorded design debt

- **#133** — `release_digest` does not cover `skill_sources` provenance rows, so
  it cannot by itself prove a provenance-affecting change reached production.
  Mitigated in 2.0.1 by the three-part proof: source SHA + physical artifact
  hash + runtime path invariant.
- **#134** — `registry.sqlite` bytes are not byte-reproducible because
  `skill_sources.observed_at` is a wall-clock timestamp. `sqlite_artifact_digest`
  is a build-instance fingerprint. Semantic build reproducibility is **PASS**
  (skill IDs, version hashes, content hashes, logical `local_path` all
  deterministic); byte-for-byte SQLite reproducibility is **BLOCKED**.
- **#121** — legacy `service_role` credential. Copies purged, rotation deferred:
  5 Vercel projects hold Supabase privileged keys and whether they share a
  Supabase project could not be established, so global JWT-secret rotation has
  an unquantified blast radius. Runbook: `docs/operations/SUPABASE-KEY-MIGRATION.md`.
- **#117**, **#120** — open, out of scope.
- Doc-only, recorded not rewritten: the `v2.0.1` tag annotation cites its
  parent catalog SHA as `22d58320`, which is `catalog-2026-09-24.1`;
  `catalog-2026-09-29.1` is `2ab47e6b`. The digest and skill count in that
  annotation are correct, and the tag is not moved. `catalog-2026-09-29.2`'s own
  annotation cites `2ab47e6b` correctly.

## 8. Independent review

R1 and R2 both returned **APPROVE, P0=0, P1=0 candidate-introduced**, and both
confirmed the candidate is a pure artifact republication: zero files changed
outside `packages/mcp/artifact`, all source byte-identical to `v2.0.1`, and the
only database changes are `skill_sources.local_path` and `observed_at`.

## 9. Release gate

| gate | result |
|---|---|
| **CODE** | PASS — exact-SHA CI 5/5 green, artifact validates 114, no artifact/contract drift |
| **RUNTIME** | PASS — exact SHA deployed, health/ready/OAuth/security boundaries PASS, 114/114 path invariant, physical identity matches |
| **PRODUCT** | PASS — Codex and OpenCode tool invocation PASS, cross-client byte parity EQUAL |

**Verdict: CATALOG RELEASED TO PRODUCTION — PRODUCT_READY**

## 10. Manual follow-up

ChatGPT Web validation remains manual and is the only client path not certified
by automation.
