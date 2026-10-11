# PR #137 — implementation map (requirements → files → verification)

Baseline verified at `feat/web-console`, base `release/2.0` = `7bf0d5a`, now merged.

**Integration note.** The branch was 9 commits behind `release/2.0` when work
started. Those commits republish the artifact (catalog-2026-10-06.1, 114 -> 116
skills), so CI — which tests the merge commit — was asserting against an artifact
the PR would never ship. `release/2.0` is now merged in, and the skill count is
derived from `release-package.json`'s `snapshot_rows` rather than hardcoded, so
the next catalog republish moves one number in the place that defines it.

This map is the "short implementation map" the brief requires before editing. It records
what is **already proven**, what is **defective**, and how each row is verified.

## Verification baseline actually reproduced (not assumed)

| Check | Command | Result |
|---|---|---|
| Domain build | `pnpm exec tsc -b` | PASS |
| Web typecheck | `pnpm exec tsc -b --force` (apps/web) | PASS |
| Web server typecheck | `tsc -p tsconfig.server.json` | PASS |
| Frozen lockfile | `pnpm install --frozen-lockfile` | PASS, lockfile unchanged |
| Spec/contract check | `pnpm run specs:check` | PASS |
| `tests/web` | `node --test tests/web/*.test.mjs` | 643/643 |
| `tests/mcp` + `tests/contracts` | `node --test` | 340/340 |
| Cross-workspace isolation | real PostgreSQL 16, scram auth, credentialed URL | 38/38 |

The isolation suite refuses to silently skip: it throws when `EGA_RLS_DATABASE_URL` is
absent. Run without a database it reports one failure, which is correct fail-loud
behavior and must not be "fixed" by skipping. With a real cluster it passes 38/38.

## Wave status

| Wave | Status | Evidence / gap |
|---|---|---|
| 1 Auth + workspace boundary | **PROVEN (unpushed)** | `cross-workspace-isolation.test.mjs` 38/38 on real PG16; delegated-OAuth reads zero control-plane rows; adapter refusal ≠ empty result |
| 2 Frontend/API integration | **FIXED** | Envelope mismatches repaired: `SkillsPage` reads `.skills`, `ReleasesPage` reads `.releases`, compare sends `base`+`candidate` and only after valid submit, overview sends `workspace_id`. New `src/api/decode.ts` validates every response at the boundary and raises `malformed_response`. |
| 3 Catalog search/filter/sort/pagination | **FIXED** | `CatalogControls` drives search/facet filters/sort/paging from the server's own facet values; `total` vs `skills.length` reported separately; a test walks all pages and asserts every skill is reached. |
| 4 Control-plane screens | **PROVEN** | `workspace.ts` `/workspace`,`/workspace/members`; `projects.ts` `/projects`,`/projects/:projectId`; `governance.ts` `/workspace/quotas`,`/workspace/security/denies`,`/audit` — all via the `controlPlaneRoute` authenticated seam. |
| 5 MCP telemetry (CONTRACT-T1) | **NOT IMPLEMENTED** | Zero telemetry code in `apps/web`. `UsagePage.tsx` renders quota accounting, which the brief forbids presenting as MCP tool analytics. `contract-f rls` green, MCP four-tool contract untouched. **Largest remaining build.** |
| 6 Windows fixes + CI | **FIXED** | EPERM teardown race and the `\` vs `/` digest-key mismatch repaired, both reproduced from the live windows-2022 log. `web` job compiles and tests apps/web on ubuntu + windows; `web-isolation` runs the real-PostgreSQL proof on Linux only (Actions rejects service containers on Windows). |
| 7 Artifact staging + preview | **PARTIAL** | Staging, build wiring and env documentation now complete (`scripts/web/stage-artifact.mjs`, verified in CI via `--check-only`). **Live preview acceptance BLOCKED** on two things: no `VERCEL_*`/Supabase credentials, and no Vercel project is attached to `apps/web` at all (the repo's two projects are `packages/mcp` and `packages/oauth-ui`). |
| 8 Independent reviews | **NOT STARTED** | zero reviews performed |

## Execution order chosen

Wave 6 first (CI is red today and it gates every later claim), then Wave 2 (correctness
regression visible to any user), then Wave 3, then Wave 5 (largest), then Wave 7 to the
point the missing credentials allow. Wave 8 runs against the final candidate.

Order rationale: Wave 6 repairs the evidence pipeline — a red Windows job and a CI that
never builds the web app mean no later acceptance criterion could be honestly claimed.

Waves 6, 2 and 3 are done. Next is Wave 5, the largest remaining build, then Wave 7 as
far as the missing credentials allow, then Wave 8 against the final candidate.

## CI naming constraint (load-bearing)

`tests/web/cross-workspace-isolation.rls.mjs` is deliberately **not** named
`*.test.mjs`. `pnpm test:ci` runs `node --test` with no path filter, so Node's
default discovery sweeps every `*.test.mjs` into jobs that have no PostgreSQL —
`foundation` and `hashing traversal`. As `*.test.mjs` it threw there by design and
turned two jobs red. The `.rls.mjs` extension puts it outside discovery, the same
reason `tests/rls/contract-f.rls.mjs` has always needed a job that provisions a
database. The isolation proof is not weakened: it still exits 1 when run directly
without a database, and the `web-isolation` job runs it on every PR.

## Blocked, and why it is not worked around

**Wave 7 live preview acceptance — two independent blockers.**

1. **No credentials.** No `VERCEL_*` or Supabase credentials exist in the build
   environment. Nothing here may claim live-preview evidence.
2. **No Vercel project is attached to `apps/web`.** The repository has two Vercel
   integrations and the PR comment names both: `ega-skills-mcp`
   (`rootDirectory: packages/mcp`) and `ega-skills-auth`
   (`rootDirectory: packages/oauth-ui`). **Neither is the console.** So even with
   credentials there is no deployment target for the web app; one has to be
   created and pointed at `apps/web`. This is why the previews report
   "Canceled by Ignored Build Step" rather than a console build.

What *is* done in Wave 7, and needs no credentials: the artifact is now staged
deterministically for the deployment by `scripts/web/stage-artifact.mjs`, which
verifies envelope, SQLite identity and required content through the domain
package before bundling and never regenerates; `vercel.json` runs it;
`EGA_WEB_EXPECTED_RELEASE_DIGEST` is documented; and `apps/web/artifact/` is
ignored so the derived copy is never committed. What remains is the live
acceptance run itself, which needs (1) and (2).

**CodeRabbit does not review this PR.** `.coderabbit.yaml` sets `auto_review.drafts:
false`, so the bot skips drafts by configuration. The brief requires the PR stay draft
until acceptance is proven, and Wave 5 and Wave 8 are outstanding, so it stays draft.
Auto-review of this branch requires flipping that setting or un-drafting; neither is
done here, because doing either early would misrepresent readiness.