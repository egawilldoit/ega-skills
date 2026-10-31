# Prepared immutable I1 release — not production acceptance

Hub `personal`; 126 skills: the original 117 unchanged, plus nine TStack skills.

- Semantic release: `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`
- Candidate: `sha256:bcc1f72e30f36deaa16fbaee5af00ab19ebf1022029a77207244d0794e902775`
- Policy: `sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6`
- SQLite: `sha256:dfe974301b67cd36aa53208c24e2bc3b2bfca3d3d306488dc0aa772e141b6896`

Exported from the governed candidate without rebuilding source inputs. Runtime
activation requires the complete I1 policy, candidate and approval sidecars;
older runtimes must reject it. Validate with `scripts/hosted/validate-artifact.mjs`.

The release owner approved the exact nine versions and semantic identity, then
confirmed publisher MORTAKI0 / mortaki0, Vercel user Dc0U1Ov3Zh5zeFKeic10bVWj.
Recorded evidence: https://github.com/egawilldoit/ega-skills/issues/168#issuecomment-6471216248
This is an operator transcription of the genuine owner decision, not a new approval.

Production publication remains gated by the release runbook. These committed
bytes and a preview deployment do not establish production availability.
The previous 117-skill release `sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297`
and its governed candidate remain retained for rollback.

Original TStack content is unmodified at commit
`7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd`, under the MIT license.
Hosted get_content serves text, not executable companion installation.
For babysit-pr/scripts/pr-wait, retrieve from the pinned original upstream and
verify SHA-256 `90393f85b95b78bff1b039744bdfb09dc88ff2b430e1c3df687ee6f449c97214`
before any separately authorized host-side use. Skill selection grants no
permission to delegate, merge, deploy or write; external hosts enforce permissions.

registry.sqlite and cache blobs are immutable binary inputs, explicitly tracked
with git add -f. Never edit adopted snapshots or normalize their bytes.
