# Routing adjudication — final 114-skill hub (SUPERSEDES the pre-fix run)

Run date: 2026-09-29
Hub under test: `/home/ubuntu/worktrees/ega-release-114-v2/hub` (114 skills)
Software: `ega-rel114-verify` @ `185b8e3` (== origin/release/2.0)
Source: `egawilldoit/skills` @ `f48e0ed8197bdfddae3a4c6ae5a12ca6f6f085df`
Corpus: cross-catalog collision corpus, 456 tasks (2 corpus corrections: auto-373,
auto-383 — dual valid owners). Results: `routing.json`.

## Final totals
- total 456
- passed 445
- AUTO_SELECTION_FAILURE 0
- POSITIVE_ROUTING_FAILURE 0
- STRICT_CANDIDATE_FAILURE 0
- BAD_EXPECTATION remaining 0
- LOW_CONFIDENCE_CANDIDATE_WARNING 11 (documented below; non-blocking)

## History (pre-fix → fix)
The first run against the hub built from source pin `b8c3e9f` produced 26
failures = 14 auto-routing blockers + 5 BAD_EXPECTATION + 7 warnings. The 14
blockers were genuine metadata defects in the new source (over-broad
domains/triggers and self-defeating anti_triggers). They were fixed in
`egawilldoit/skills` issue #4 → PR #5, pin advanced to `f48e0ed`, and the
corpus corrections (auto-373, auto-383) applied. This file records only the
final state.

## Fixes applied (source: issue #4 / PR #5)
- `record-evidence`: drop broad domain `[evidence]`.
- `understand-codebase`: drop broad domain `[codebase]`; add subsystem-explanation triggers.
- `preflight-repository`: drop broad domain `[repository]`.
- `create-verification-workflow`: drop generic trigger `verification workflow`; add audit/maintain anti-triggers.
- `typescript-best-practices`: drop generic trigger `typed`.
- `parallelize-work`: add context-window anti-triggers.
- `design-architecture`: add improve-existing-architecture anti-triggers.

## Corpus corrections (Section 21)
- auto-373: `resolving-merge-conflicts` vs `fix-merge-conflicts` are both valid
  owners (duplicate topic) → expected_ids includes both.
- auto-383: two skills literally named `tdd` → expected_ids includes both.

## Remaining LOW_CONFIDENCE_CANDIDATE_WARNING (11) — documented, non-blocking
All have `selected=[]`, confidence LOW, no dangerous/high-risk leading
candidate, and no strict-forbidden violation.

| id | expected | leading candidate | note |
|---|---|---|---|
| auto-165 | egawilldoit/principle-boundary-discipline | principle-type-system-discipline | principle skill (explicit/narrow) |
| auto-181 | egawilldoit/principle-experience-first | mattpocock/implement | principle skill (explicit/narrow) |
| auto-189 | egawilldoit/principle-foundational-thinking | principle-type-system-discipline | principle skill (explicit/narrow) |
| auto-213 | egawilldoit/principle-model-the-domain | principle-foundational-thinking | principle skill (explicit/narrow) |
| auto-229 | egawilldoit/principle-separate-before-serializing-shared-state | principle-foundational-thinking | principle skill (explicit/narrow) |
| auto-346 | mattpocock/grill-with-docs | mattpocock/grill-me | both `disable-model-invocation: true` (user-only) |
| auto-377 | mattpocock/setup-matt-pocock-skills | mattpocock/triage | expected is user-only |
| auto-394 | mattpocock/to-spec | anthropic/internal-comms | expected is user-only |
| auto-398 | mattpocock/to-tickets | anthropic/internal-comms | expected is user-only |
| auto-418 | mattpocock/writing-for-agents | anthropic/internal-comms | retrieval near-miss (auto-invocable) |
| auto-437 | vercel/react-view-transitions | mattpocock/implement | confidence near-miss (expected is candidate[1]) |

## Security
All 114 negative/forbidden cases pass (114/114); 13 target high-action skills,
13/13 pass. No forbidden or high-risk skill becomes a selected or leading
candidate. `STRICT_CANDIDATE_FAILURE = 0`.

Release blocker count: 0.
