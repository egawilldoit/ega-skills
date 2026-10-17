# Source

- Catalog ID: `catalog-2026-09-29.1`
- Product: EGA Skills 2.0.0 (original release SHA `065421c03909089eb6077c1d285af24121329862`)
- Software baseline (before catalog merge): `185b8e3f699623b68a10a605c31a1ccc491d954e` (`origin/release/2.0`)
- New source: `https://github.com/egawilldoit/skills`
- Source pin: `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df`
  (PR #5 merged; supersedes `b8c3e9f4de88e7005515602e2c67276501fb1050` after routing-metadata fix for issue #4)
- Namespace: `egawilldoit`
- Selected roots: 66 explicit `skills/<name>` directories
- Provenance files: `LICENSE`, `THIRD_PARTY_NOTICES.md`, `upstream-sources.json`

FACT: the pin is a full 40-hex commit, not a floating ref.
DEFERRED: generic EGA-owned overlays for immutable third-party sources (issue #117) remain out of scope.

## Pin verification (reviewer R1 P1-1)

The pin is merge commit `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df` on `main`
(PR #5). The local fix worktree was checked out at the PR branch tip
`db85f14dc420e8eb55c2080df1880aada3039d24`; its tree is byte-identical to the
pin (`git diff f48e0ed db85f14` empty; tree `5b675ce59d04aada3e402b25f34e08e7aa0356a2`),
and the vendored snapshot recomputes to the pinned digests. The adopted source in
the release hub is the git fetch of the exact pin commit.
