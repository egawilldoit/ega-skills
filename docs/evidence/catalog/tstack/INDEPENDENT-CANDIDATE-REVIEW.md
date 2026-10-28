# Independent publication and candidate review

Verdict: APPROVE the verified candidate and reviewed publication changes; production remains BLOCKED.
Reviewer: independent native reviewer /root/candidate_publication_review.
Review date: 2026-10-28.
Committed observation patch: 9e34ea5d8bac8eec6269bb0e02fbc16ea5c01358; base 98b0581d7a16be0785c29c82ac26eca20c401dcf.
Final independently reviewed head: ac54c156c2541da278504875641e77cb8d854e6c. All six reviewed file hashes match the final committed blobs exactly. This is not CI certification.

## Findings

- HIGH, resolved by observation patch: GitHub deployment notification setting and deployment-policy allowlists were being interpreted as production auto-deployment disable controls. Removed those inferences. Unknown/missing controls fail closed. Overlapping true or unknown branch rules cannot be concealed by an exact false rule.
- HIGH/reliability, resolved by observation patch: recent deployment-list responses lacked the full alias/check identity needed to establish the actual canonical predecessor. Canonical alias is now resolved directly, immutable deployment is read, complete deployment aliases are checked, and alias is read again after probing.
- MEDIUM, resolved in reviewed exporter diff: I1 schema3 was passed to V1 exporter and rejected. Explicit schema dispatch uses full I1 verifier. Additional review found a differently named schema3 input could select sibling candidate.json rather than supplied identity. Canonical-basename guard and rejecting regression resolve this.
- No remaining CRITICAL/HIGH/MEDIUM code findings in reviewed scope. Alias bracketing is not atomic CAS and cannot detect change-and-restore; this remains an explicit operational limitation, not a platform-enforced guarantee.

## Independent candidate certification

I ran verifyInvocationCandidate independently against both candidate/ and artifact/, not just summary.json. Both verify envelope, sidecars, policy/profile/version binding, package identities, release projection/FTS, SQLite integrity and referenced cache blobs. I separately recomputed JSON-envelope SHA-256 identities with a Python implementation and physical SQLite SHA-256. I reran issue-168-independent-release.mjs from canonical inputs; it independently assembled the approved semantic digest.

- Semantic HubRelease: sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266
- Candidate: sha256:bcc1f72e30f36deaa16fbaee5af00ab19ebf1022029a77207244d0794e902775
- SQLite: sha256:dfe974301b67cd36aa53208c24e2bc3b2bfca3d3d306488dc0aa772e141b6896
- Policy: sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6
- Preflight: sha256:644fff8181836b6fbcfece543bac65bb1d771000eb1089277c0efdb8abb7b967
- Release diff: sha256:82f90d305b8a89b4817b55aa2d1894a229f98aacc4dcf2cad7b0f1a2e0c46c68
- 126 skills: all117 baseline hashes identical; exactly nine additions equal approved plan.
- All fourteen manifest-declared upstream files independently fetched read-only from ORIGINAL t3dotgg/tstack pinned commit 7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd and compared byte-for-byte and SHA-256 against candidate cache. All match.
- Candidate and exported artifact trees contain 869 byte-identical files.
- All nine governed owner-decision review records match their exact preflight references, versions and plan identity. Preserved owner evidence contains two user-authored messages, including exact publisher confirmation. These records are agent transcriptions of the genuine owner decision, not reviewer signatures or independent external-operator certification.

## Tests and platform sources

31/31 focused observation/publication tests passed independently. Exporter targeted checks on final committed tree are pending parent-run heavy slot; no duplicate build started. Full CI/exact-head certification remains required after commit.

Primary sources checked: https://vercel.com/docs/project-configuration/git-configuration and https://raw.githubusercontent.com/vercel/terraform-provider-vercel/main/vercel/resource_project.go . They support conservative branch-rule handling and the distinction between deployment_status notifications and Git-triggered Vercel builds. Production API behavior was not independently queried in this review; the supplied live observations are operational evidence, not my independent live verification.

## Unresolved production prerequisites

The legacy readiness endpoint does not identify its served release; a separately reviewed supported migration is required. Observable Git auto-deployment control, successful deployment checks, single canonical production alias and fresh genuine external operator-readiness certification remain unsatisfied per current evidence. The external certification must review actual ACL/single-writer controls and accept residual alias race. Owner version/publisher approval does not substitute for it. Do not promote or fabricate checks, readiness digests or operator records.

Production authentication/live acceptance and external agent-host action enforcement are not certified by this review. Hosted babysit-pr companion execution remains unsupported; pinned retrieval/checksum fallback must remain explicit.

## Reviewed file identities

- `scripts/hosted/publish-production.mjs`: `f61bb67c7e6ffdb2ad81d63e5cd461e8e38301e89b5e1c7a495e4e34155170be`
- `scripts/hosted/build-deployment-artifact.mjs`: `172fa0f5343f280125e4e62c8a83c8b24e498fb785d0ff2dcab184eab08ddd91`
- `tests/hosted/production-publication.test.mjs`: `0f5b30126b9566d47ecd9037efd4aa2d578ea1a7f2fc550e50801c9682288575`
- `tests/hosted/vercel-observations.test.mjs`: `26ee6ecc77e7a731683fece597e545ec74bd80f1960ed7202db7bcfba7d1e963`
- `tests/project/hub-release-candidate.test.mjs`: `9d1a408a90ec22b6fcd495820c8c460da4b1bea94d11657d10f45aa9a53dd8e4`
- `docs/operations/RELEASE-2.0-RUNBOOK.md`: `4dcc5e4afdc9d0da68012296e4245d8b8494f4bc452e4043be81474af84b0a67`
