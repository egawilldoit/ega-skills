# Review R1 — governance / provenance / artifact

Independent reviewer pass (read-only). Verdict at time of review: FAIL (2 P1, 2 P2).

## Checks
| # | Check | Result |
|---|---|---|
| 1 | Parent catalog identity (digest, 48 = 14/25/9) | PASS |
| 2 | Final count 114 = 25+14+9+66 | PASS |
| 3 | 48 old SkillVersions hash-equal to parent | PASS |
| 4 | 66 new source identities bound to pin + digests | PASS |
| 5 | Official reader: 114 latest, 114 APPROVED, 0 rejected | PASS |
| 6 | License + provenance files present; 66/66 coverage | PASS |
| 7 | Source checkout HEAD == pin; 134 source tests | FAIL (see P1-1) |
| 8 | Preflight READY, 114 reviews, 0 blockers | PASS |
| 9 | Preview added 66 / removed 0 / updated 0 / final 114 | PASS |
| 10 | Artifact validator OK + digest match | PASS |
| 11 | Excluded IDs absent | PASS |

## Findings and disposition
- **P1-1 Source worktree HEAD was the PR branch tip, not the merge pin.**
  `skills-routing-fix` HEAD was `db85f14d…`; the pin is `f48e0ed…` (its merge).
  Trees are identical (`git diff f48e0ed db85f14` empty; tree `5b675ce5…`), and
  the vendored snapshot recomputes to the pinned digests, so content and tests
  are equivalent. **Disposition: RESOLVED** — pin recorded as `f48e0ed…`; tree
  equality documented.
- **P1-2 `provenance.md` cited the superseded tree digest `1264e1c88…`.**
  **Disposition: RESOLVED** — corrected to `781191b77461…` (lock + independent
  recomputation).
- **P2-1 Exported artifact does not embed LICENSE / THIRD_PARTY_NOTICES.md /
  upstream-sources.json blobs.** Their digests are bound into the adopted-source
  snapshot digest. **Disposition: ACCEPTED / DOCUMENTED** (in `provenance.md`);
  not a release blocker because attribution lives in the source bundle.
- **P2-2 Parent approval recovery not reproducible from the provided artifact
  set alone.** Independently verified directly against the parent hub
  `/home/ubuntu/ega-catalog-main/hub` via the official reader (48/48). **Disposition:
  CLARIFIED.**

P0 = 0. Remaining P1 = 0 after fixes.
