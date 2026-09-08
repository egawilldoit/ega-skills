# PR #78 pre-staging repair report

Canonical specification SHA: `2ca5e6309dd8c3a4ecea5e4b15f50c2aadccdeed`.
Protected checkpoint: `b0b413e75295e55c2d29c646ae50e5af7240dd92`.
Implementation tree verified by the latest repair tests:
`86e819ad7164d9ec96a7ba7aace4829e9462591f`.
The current documentation snapshot is evidence-only after that code-tested
commit; exact branch-head identity is supplied by the PR/CI record.
Branch: `repair/pr77-release-readiness`.

This report records the pre-staging repair wave. It does not claim a hosted
deployment, a release, or repository-authoritative Contract D/E freezes.

## Disposition

| Finding | Status | Evidence | Commit |
| --- | --- | --- | --- |
| B1 exact token artifact authority | FIXED | Forged counts, wrong level, and self-consistent forged release artifacts are rejected; the supplied artifact must equal the freshly derived semantic artifact. | `ec67e4e` |
| B2 Contract C executable gate | FIXED | Independent mutation fixtures recompute dependent digests and reject invented aliases, wrong token values/levels, and invented normalized search metadata. Contract C is 18/18. | `ec67e4e`, `47508e8` |
| B3 mutation lock reclamation | FIXED | Ownership-token lock protocol, fail-closed malformed/live owners, stale recovery, real multiprocess contender tests, and cross-platform child-process completion handling pass. | `037783c`, `651454c`, `04f6c10` |
| B4 declared owned roots | FIXED | Prospective validation parses and copies the configured owned roots using normal Hub confinement; custom-root and traversal tests pass. | `037783c` |
| B5 source provenance authority | FIXED | Per-SkillVersion provenance is persisted in the release SQLite snapshot, digest-bound, checked at startup, and used instead of deployment-supplied authority. | `a647025` |
| B6 eligible selection | FIXED | Authorization and deny filtering produce the eligible view before search/resolve limits, budgets, ranking, and aggregates. | `a647025` |
| B7 timeout capacity accounting | FIXED | Abort signals propagate and live work remains counted until settlement; timeout/concurrency regressions pass. | `a647025` |
| B8 bounded context HTTP | FIXED | Content-Length and unknown-length request bodies are bounded while streaming; remote cleartext bearer transmission is rejected. | `a647025` |
| B9 durable-before-visible context state | FIXED | Failed publish/revoke persistence leaves visible state unchanged; replacement failure restores the prior durable file. | `a647025` |
| B10 revocation before delivery | FIXED | Context authority is rechecked immediately before successful delivery; revoked requests return `E_CONTEXT_REVOKED` without fallback. | `a647025` |
| B11 persisted remote lifecycle | FIXED locally | Authenticated POST/list/GET/restart/runtime/revoke lifecycle uses persisted authority, bounded response handling, base-path support, and malformed-store rejection. Real hosted staging acceptance remains external. | `a647025`, `47508e8`, `036647d` |
| Fingerprint confinement follow-up | FIXED at the portable Node boundary | Discovery uses one bounded, confined reader with symlink, realpath, file-identity, and post-read mutation checks; adversarial static cases pass. A native directory-handle adapter would be required for a stronger OS-specific guarantee. | `90a15c0`, `47508e8` |

## Adjacent review items

| Item | Status | Evidence |
| --- | --- | --- |
| N1 bounded JWKS operations | FIXED | Bounded streaming, timeout/abort, retry-after-error, oversized-body, and timeout tests. |
| N2 physical connections | BLOCKED EXTERNALLY | The local adapter measures in-process work. Physical socket enforcement remains a required deployment-adapter responsibility before hosted acceptance. |
| N3 committed diff formatting | FIXED | CI checks generated-tree formatting and the pull-request merge-base-to-HEAD range. |
| N4 public A/B/C lifecycle | FIXED | The public real-upstream path advances the tracked mirror ref to C before materializing the approved B plan. |
| N5 canonical comparisons | FIXED | Domain byte/canonical comparisons and explicit UTF-16 ordering are used at hosted/release boundaries; punctuation-order regression passes. |
| N6 blob authorization | FIXED | Content access is SkillVersion-authorized and manifest-bound; a blob hash alone is not an accepted request authority. |

## Verification

On the implementation tree above:

- Full suite: 837 total, 832 passed, 0 failed, 5 classified skips.
- Focused exact-head repair suite: 80/80 passed.
- Contract A: 17/17; B: 11/11; C: 18/18; D: 9/9; E: 6/6.
- Real upstream lifecycle: PASS. Cursor commit
  `71ed0d1076fec562c1b74ee353121a8d00f75382`; Matt commit
  `3cca18b368ae95cdbdebbff572ccafa662551015`.
- Controlled lifecycle: A=`5c89081d4bbeb3d039a42093653f90bb698d780e`,
  B=`6a34259e99bc5fed4f8fe5da61c273dad14edf67`,
  C=`3cca18b368ae95cdbdebbff572ccafa662551015`.
- Approved plan digest: `sha256:9c182066cc06a19c43c36ad078a1e18521d47ddb913ee1795386773c4aa3a490`.

The five skips are two Windows-only containment tests, two fresh hosted-client
gates, and one real-network upstream gate. The upstream gate was separately
executed and passed. Exact code-under-test foundation CI `34208168893` and
hashing traversal CI `34208168880` passed on Ubuntu and Windows.

The final context-boundary follow-up also passed the targeted persisted-context
suite (15/15), the mutation-lock suite (23/23), and the full regression above.

The final review-wave regressions also include strict Contract C diagnostics,
bracketed IPv6 loopback, retained-backup-on-double-failure, malformed success
responses, and denied-versus-absent context indistinguishability.

## Readiness boundary

The local 1.1–1.3 implementation gates are complete for this repair wave.
This is not hosted staging readiness: physical connection enforcement, hosted
backup/restore/rollback, fresh Codex/OpenCode clients, and authenticated remote
ProjectContext acceptance still require an isolated staging environment.
Contract D and Contract E remain freeze candidates, not authoritative freezes.

The pre-existing Supabase migration is reviewed locally only, unchanged by
PR #78, and has not been applied remotely.
