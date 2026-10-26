# Ship One Outcome — approved local release candidate

Source: `egawilldoit/skills@8f264fc5fcb5691694c3653287f4d9370c5b025c`.
Canonical source ID `egawilldoit-skills`, namespace `egawilldoit`.
UpdatePlan: `sha256:2347ce33da9febb3bb8587ccf6e89cd7d34563a34aecbcef455e8ca0c2a7baf3`.

Owner authorization covers canonical adoption and local immutable preparation.
The owner approved the exact five versions in this T3 conversation on 2026-10-26.
The CLI actor explicitly identifies Codex as recorder, not owner or independent
reviewer. `owner-authorization.json` records this scope; the supported canonical
review result is `canonical-owner-approval.json`. No production authority or
release/catalog PR merge authority is implied.

| Skill | Approved and exported version |
| --- | --- |
| egawilldoit/certify-production-target | `sha256:514cb81b926468f8a277900ac78f64d5f6bcec76ee8f3a42e5a53d97056a5258` |
| egawilldoit/certify-release | `sha256:fbf30a715b0a29167c2fb33f37211b1702e55f6a205f91fc236a1c7848ce4675` |
| egawilldoit/design-architecture | `sha256:5f76a0254477a0e2c1c57d77b386d4195c60ae544601f20eb72f37e31407d925` |
| egawilldoit/get-pr-comments | `sha256:10fd167c88adaa4c0dcf513a48c89ee8b154799ef39edb55cffeb8138af577b9` |
| egawilldoit/ship-one-outcome | `sha256:b14717b483f475a5a91f295d1c3b67605a1f753cf6e13a23d97635757728b930` |

The full release contains 112 unchanged existing versions, four metadata-only
updates, one added skill and zero removals. All four updates affect only
`ega.yaml`; `metadata-only-scope.json` records source comparisons.

## Verification

- Remaining post-merge Linux/Windows CI and hashing passed at Hub
  `0152bb7c3d0ff789f48c3ae4461a423ff9beec59` before adoption. See
  `binding-check-before-apply.json` for run URLs and immediate binding checks.
- Canonical CLI update succeeded with strict old-state, source, tree and snapshot
  checks. `canonical-adoption.json` and `sources.lock.yaml` record the result.
- Publication preflight is READY with no blockers. Inherited approvals for the
  112 unchanged versions remain; only the five approved decisions were appended.
- Candidate: `sha256:5c441c3f0d7f5acf0cbdf005e6b4db8d05105783c38f37b4939b3b0ae54a45bc`.
- Immutable release: `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`.
- SQLite: `sha256:7cc2d59db09b3d0276cd623967a99ea0873a1c350f9fd607362b942b3f076704`.
- Export passed the existing hosted loader: release, SQLite integrity/digest,
  manifests, aliases, search/token projections and blobs. All exported file bytes
  match the PR artifact; source paths are relative. See `artifact-validation.json`.
- Actual stdio MCP initialize/tools protocol: 12 checks pass, including search,
  inspect, all required content, positive/negative Ship routing, architecture
  routing and narrow Vercel exclusion. `mcp-artifact-smoke.json` is local artifact
  evidence, not authenticated hosted acceptance or OAuth readiness.
- Full corpus: 82 evaluated, 81 measurable, one pending absent skill. No new
  incorrect automatic selections. Existing wrong automatic selections fall from
  26 to 22; excluded-skill automatic selections fall from two to zero. The broader
  execution/discovery quality targets still fail and are retained truthfully in
  `artifact-discovery-report.json`; this release does not repair that platform.
- Ship One Outcome appears in Build / Delegate. The generated catalog and
  committed release counts/baseline are updated without runtime changes.
- VM installation and local policy are unchanged; portable source content only
  is served by this artifact. Production state has not been modified.

## Reserved release decision and rollback

This PR targets `main`, not production `release/2.0`. Its merge is not authorized.
After exact-head CI and independent review, the owner must authorize its merge.
A separate production workflow must authorize moving the reviewed release to
`release/2.0`, registration of this exact digest/SQLite identity, deployment to
Vercel `ega-skills-mcp` under scope `team_e2x4kf12yL43qmBIs2t2YaD2`, and alias
promotion. These actions have not been executed. No secrets or permissions change
is requested.

Before that rollout, read back the current known-good production deployment ID,
served digest and OAuth/audience/origin settings, retain rollback access, then
follow `docs/operations/RELEASE-2.0-RUNBOOK.md` and `packages/mcp/VERCEL.md`.
Previous known-good release:
`sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3`.
Its original artifact is retained in Git at parent `0152bb7c3d0ff789f48c3ae4461a423ff9beec59`
and the prior immutable production deployment must remain selectable. Use the
runbook's receipt-scoped registration rollback and immutable deployment rollback;
never rewrite the old artifact. The production deployment ID requires fresh
readback at the authorized rollout, not invention here.

Hosted acceptance remains pending until authenticated production search,
resolve, inspect and get_content actually serve this digest and exact skill
version, with OAuth and service health verified.
