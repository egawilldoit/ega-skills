# Review R2 — routing / security / client / deployment

Independent reviewer pass (read-only). Verdict at time of review: FAIL
(routing/security PASS; evidence-integrity and deployment-readiness findings).

## Routing (independently reproduced)
- total 456, passed 445, warnings 11, blockers 0
- AUTO_SELECTION_FAILURE 0, POSITIVE_ROUTING_FAILURE 0, STRICT_CANDIDATE_FAILURE 0
- negatives 114/114 pass; high-action negatives 13/13 pass
- The 11 warnings all have `selected=[]`, LOW confidence, no dangerous lead
  (documented in `routing-adjudication.md`) — non-blocking.

## Security
- P0 = 0, P1 = 0.
- No forbidden/high-risk skill becomes a selected or leading candidate.

## Findings and disposition
- **F1 (blocker) Evidence bundle self-contradicted on the release gate** (stale
  `routing-adjudication.md` from the pre-fix run declared a release blocker).
  **Disposition: RESOLVED** — adjudication rewritten for the final 445/456 run;
  pre-fix history retained as a clearly-marked section.
- **F2 (high) Saved artifact-only smoke/read-only proof pointed at the earlier
  candidate artifact.** **Disposition: RESOLVED** — re-run against the v2
  artifact (`sha256:1efdbc3d…`): 4 tools, 7/7 representatives, mutation 0;
  `artifact-mcp-smoke-result.json` + before/after manifests committed.
- **F3 (high) No immutable release SHA existed yet.** **Disposition: RESOLVED**
  — candidate committed on `catalog/2026-09-29-egawilldoit-66-final`; merged SHA
  becomes the deploy SHA.
- **F4 (medium) `provenance.md` cited a superseded tree digest.** **Resolved** —
  corrected to `781191b77461…`.
- **F5 (medium) Production env snapshot insufficient** (audience `authenticated`,
  no `EGA_HOSTED_RESOURCE_URL`, no `EGA_HOSTED_AUTHZ_JSON` → fail-closed).
  **Disposition: OPEN — pre-production blocker requiring release-owner action**
  (Vercel env vars + OAuth token hook). Not changed here.
- **F6 (medium) Secret hygiene:** a live Supabase `service_role` key sits in a
  world-readable temp file. **Disposition: FLAGGED** — out of the artifact; the
  release owner must rotate it and purge the temp file.
- **F7 (low) `registry.sqlite` leaks build-host absolute paths.** P3-class,
  consistent with prior accepted findings; not a blocker.
- **F8 (low) Runbook `jq` digest command returns null** (top-level `digest`, not
  `payload.release_digest`). Doc fix, not in this diff.
- **F9–F11 (info)** Negative corpus is narrow; principle skills are narrow but
  self-suppressing (warnings only); catalog integration itself is clean
  (48/48 identical, +66, 0 removed/changed, preflight blockers=[]).

## Deployment prerequisites (release-owner actions; not performed)
1. Commit + PR + merge the candidate (this PR).
2. Exact-SHA CI green on `release/2.0`.
3. Fix production env: `EGA_HOSTED_RESOURCE_URL`, `AUDIENCE == RESOURCE_URL`,
   `EGA_HOSTED_ISSUER/AUDIENCE/JWKS_URL` together, `EGA_HOSTED_AUTHZ_JSON`,
   `EGA_HOSTED_ARTIFACT_DIR=./artifact`; remove any static token.
4. Enable the Supabase custom access-token hook (OAuth gate remains closed).
5. Capture the current production deployment as the rollback target.
6. Post-deploy smoke + Direct MCP + Codex + OpenCode parity.

P0 = 0, P1 = 0 in routing/security. Release readiness blocked on F5 (env/OAuth).
