# PR #77 remediation report

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
Protected audit checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92`.
Historical implementation candidate: `cf4d85b2d83e8c9fa0cfbf1fa7d1aa89fc7c5df3`.
The current pre-staging repair is recorded separately in
`docs/reviews/PR-78-PRESTAGING-REPAIR.md`.
Branch: `repair/pr77-release-readiness`.

This report records the validated disposition of every finding. Contract D
and Contract E behavior is implemented and tested as a freeze candidate. Their
repository-authoritative freeze still requires the dedicated integration
process described by the canonical specification.

| Finding | Classification | Normative reference | Reproducer | Fix | Regression test | Commit | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 exact approved commit | VALID | Spec §3.14, §3.16 | A to B to C ref movement | Added exact commit fetch and used it during apply | `hub-adoption.test.mjs` lifecycle; `hub-planning.test.mjs` exact fetch | `5ea545a` | Full suite and focused adoption suite pass | FIXED |
| F2 prospective full-Hub validation | VALID | Spec §3.16, §3.22 | Global duplicate during source update | Build a temporary prospective Hub before journal publication | `hub-adoption.test.mjs` prospective conflict | `5ea545a` | Atomic state-preservation assertion passes | FIXED |
| F3 final snapshot integrity | VALID | Spec §3.16, Contract B | Provenance-only staged tamper | Recompute and compare tree and snapshot digests after landing | `hub-adoption.test.mjs` provenance tamper | `a8ec090` | 17/17 adoption tests pass | FIXED |
| F4 alias exact ownership | VALID | Spec §3.24, Contract C | Invented alias targeting selected skill | Derive aliases from selected manifests and compare exact map | `hub-release-state.test.mjs` invented alias | `5ea545a` | Release and Contract C tests pass | FIXED |
| F5 SearchIndexInput exact binding | VALID | Spec §3.26 | Wrong valid version hash and malformed rows | Derive and compare exact selected rows at release validation | `hub-release-state.test.mjs`, release tests | `5ea545a` | Contract C and full suite pass | FIXED |
| F6 complete hub build | VALID | Spec §3.22 | CLI emitted only partial result | Added `buildHubRelease` orchestration and artifact outputs | `cli.test.mjs` emitted artifact E2E | `5ea545a` | CLI, build, and full suite pass | FIXED |
| F7 retained rollback authority | VALID | Spec §3.30 | Arbitrary hash, cross-Hub, and unretained rollback | Rollback accepts only a verified same-Hub `HubRelease` whose digest is present in the authoritative retained-reference set | `hub-release.test.mjs` negative tests | `5ea545a`, remediation follow-up | Contract C and release tests pass | FIXED |
| F8 canonical authoring commands | VALID | Spec §3.10 | Missing validate/init-skill commands | Added validator-backed `validate` and exact two-file scaffold | `cli.test.mjs` subprocess tests | `5ea545a` | CLI tests and full suite pass | FIXED |
| F9 canonical real 1.1 lifecycle | VALID | Spec §3.35 | Corpus smoke lacked B to C lifecycle | Added immutable plan lifecycle and release preservation assertions | `hub-adoption.test.mjs`; real upstream E2E | `2aaff25`, `cf4d85b` | Exact A/B/C upstream lifecycle and 18/18 local ledger rows pass | FIXED |
| F10 result-level authorization | VALID | Spec §4.13 | Search/resolve could authorize only release | Authorize every concrete SkillVersion result before return | `hosted-runtime.test.mjs` result authorization | `d5f1331` | Hosted focused suite passes | FIXED |
| F11 resource-level emergency deny | VALID | Spec §4.14 | Mixed-source deny could disable or leak incorrectly | Map skills to sources and filter denied concrete results | hosted mixed-source result tests | `d5f1331` | Hosted focused suite passes | FIXED |
| F12 startup semantic binding | VALID | Spec §4.4 | FTS/catalog binding checked by shape only | Verify release package, SQLite, metadata, artifacts, exact FTS rows, blobs, and deny state | hosted startup tamper tests | `d5f1331` | Hosted focused suite passes | FIXED |
| F13 JWT trust order | VALID | Spec §4.12 | Revocation callback saw invalid claims | Verify header, key, signature, claims before revocation lookup | hosted OAuth callback-count test | `d5f1331` | Hosted focused suite passes | FIXED |
| F14 transport limits | VALID | Spec §4.16, Contract D vector | Content limit duplicated request limit; connections unrepresented | Independent gates plus explicit deployment connection adapter seam | hosted transport adversarial tests | `d5f1331` | All seven local gates pass; physical socket metric is deployment-supplied | FIXED |
| F15 RemoteLockPlan release binding | VALID | Spec §5.10, §5.11 | Self-consistent lock outside target release | Apply requires exact release artifact and containment check | remote-project forged-candidate test | `d5f1331` | Remote focused suite passes | FIXED |
| F16 actual publication path | VALID | Spec §5.6 | Local artifact generation was not a client/server path | Added authenticated HTTP control-plane handler, client, immutable persistence, new-identity republication, revoke | remote-project local HTTP E2E | `d5f1331` | Authenticated publication and revoke pass | FIXED |
| F17 fingerprint confinement | VALID | Spec §5.14–§5.19 | Caller inputs and symlink escape could affect identity | Derive bounded evidence and enforce lstat/realpath/root containment | remote-fingerprint adversarial tests | `d5f1331` | Fingerprint focused suite passes | FIXED |
| F18 contract CI coverage | VALID | Spec §7–§10 | CI omitted candidate Contract D/E gates | Added A to E check/test commands and package E scripts on matrix CI | workflow plus local command run | `d9bf5a6` | Exact-head CI `34138751456` passes Ubuntu and Windows; hashing CI `34138751458` passes both | FIXED |
| F19 D/E status accuracy | VALID | Spec §7–§10 | Local candidate docs claimed FROZEN | Reclassified D/E docs as FREEZE CANDIDATE with required process | contract docs and validators | `d9bf5a6` | Governance text is explicit; authoritative freeze remains external | FIXED |
| F20 exact evidence | VALID | User remediation gate | Stale counts and missing 1.1/1.2 ledgers | Added ledgers, report, decision trail, skip classifications, exact commits | this report and acceptance ledgers | `13a23037030630eb0fb32d6d289e826af2e8e5ce` | Final clean-head verification records exact final SHA | FIXED |

## Exact-head independent review follow-up

The exact implementation candidate was independently reviewed after the
original remediation. The review reproduced and closed these residual gaps;
the original F1–F20 table remains the historical disposition record.

| Finding | Reproducer and disposition | Regression | Commit |
| --- | --- | --- | --- |
| F2 stale mutation lock | Dead-owner lock with a recovery journal now permits recovery; live or malformed owners still fail closed. | `hub-adoption.test.mjs` dead-owner recovery | `05f70f2` |
| F11 incomplete source provenance | Mixed-source snapshots without an exact skill-to-source map now fail startup; denied source results cannot leak. | `hosted-runtime.test.mjs` provenance and mixed-source deny tests | `05f70f2` |
| F12 deny policy readiness | Deny-policy loading and failure are part of startup integrity before READY. | `hosted-runtime.test.mjs` startup deny-policy test | `05f70f2` |
| F14 transport and cancellation | Unknown-length request streams, response/content bytes, abort propagation, and timed-out concurrency are independently bounded. | hosted adversarial transport tests | `05f70f2` |
| F15 mutable change summary | Apply recomputes candidate lock change sets against the current lock before writing. | `remote-projects.test.mjs` forged summary test | `05f70f2` |
| F16 local control-plane durability | Authenticated context publication now has file persistence, GET/reconstruction, revoke persistence, and new-identity republication. | `remote-projects.test.mjs` process reconstruction test | `05f70f2` |
| F17 evidence read boundary | Evidence reads reject symlinks, escapes, non-regular files, and oversized files with bounded reads. | `remote-fingerprint.test.mjs` oversized/symlink tests | `05f70f2` |

Review disposition: historical F1–F20 remediation complete. The current
pre-staging repair and its exact-head review are recorded in
`docs/reviews/PR-78-PRESTAGING-REPAIR.md`; no old review SHA is reused as
current evidence.

## Skipped tests

The full regression has exactly five skips:

1. Two Windows containment tests are platform-only and run on Windows.
2. The Codex smoke is a fresh hosted-client gate, enabled by
   `EGA_CODEX_ACCEPTANCE=1`.
3. The OpenCode smoke is a fresh hosted-client gate, enabled by
   `EGA_OPENCODE_ACCEPTANCE=1`.
4. The real Matt/Cursor corpus and A-to-B-to-C lifecycle test is one
   real-network gate and passes with `EGA_REAL_UPSTREAM=1`.

The two client skips are not unexplained local behavior. They require fresh
external client environments. The real upstream skip is separately proven by
the command and exact commits in `docs/ACCEPTANCE-1.1.md`.

## Migration review

`supabase/migrations/20260907120000_restrict_public_rls_auto_enable.sql` was
reviewed locally only. It is pre-existing at the protected checkpoint and is
unchanged by PR #78. Its conditional `to_regprocedure` check makes reruns safe
when the helper is absent; the dynamic `REVOKE EXECUTE` removes grants for
`PUBLIC`, `anon`, and `authenticated` without adding a grant. It does not
change owner behavior or SECURITY DEFINER semantics, and no rollback migration
is present. It was not applied to any remote project.

## Remaining external operations

- The dedicated D/E freeze records remain required by governance; the
  implementation candidate has completed the exact-head review and local
  contract gates.
- Fresh Codex/OpenCode acceptance and a real authenticated staging control
  plane remain external.
- No production deployment, release tag, Contract F, or 2.0 work is in scope.

## Later pre-staging repair follow-up

The B1–B11 and fingerprint follow-up repair is recorded in
`docs/reviews/PR-78-PRESTAGING-REPAIR.md`. Its latest implementation code tree
is `610650d44f68023c85a803dc250f1d81696e6279`; the full regression is 845 total,
840 passed, 0 failed, and 5 classified skips. Foundation CI
`34215575847` and hashing traversal CI `34215575864` pass on Ubuntu and
Windows. The latest real-upstream run observed Cursor
`71ed0d1076fec562c1b74ee353121a8d00f75382`, Matt
`3cca18b368ae95cdbdebbff572ccafa662551015`, and run-scoped approved plan
digest
`sha256:b84b3cbca1c48a58d5a75429a738660ccb7265ebe32674b976ccc97336818c10`.
This digest varies with the temporary local-mirror path because that path is
part of the Contract A source configuration digest; it is not a semantic
release identity.
These are current follow-up facts; the F1–F20 table above remains the
historical audit disposition and its commit references are intentionally
unchanged.
