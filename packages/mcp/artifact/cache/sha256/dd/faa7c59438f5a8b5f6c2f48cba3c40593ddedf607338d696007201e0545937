---
name: adversarial-review
description: "Independently challenge a completed or proposed change for correctness, security, and maintainability before it ships. Use for 'adversarial review', 'stress test this', 'find blind spots', 'tear this apart', or when an important change needs a deep independent review rather than a normal pass. Findings use severity CRITICAL, IMPORTANT, MINOR, UNPROVEN, or FALSE_POSITIVE, and every real finding carries claim, evidence, affected surface, impact, reproduction or reasoning, originating change, minimal repair, verification required, and confidence. Does not auto-apply fixes. Use blast-radius for what a change could break elsewhere; use review-and-ship to finish an ordinary branch or PR."
---

# Adversarial review

Challenge a change from independent angles and return a synthesized verdict. The value is catching what a normal review misses, and being honest about what was verified versus assumed.

The deliverable is a review, not a repair. Do NOT auto-apply fixes unless the user explicitly asks.

## When to use

- "Adversarial review", "stress test this", "find blind spots", "tear this apart".
- An important change is about to ship and a single reviewer is not enough.
- A diff you do not trust yet, after a large or subtle change.
- Before a release or a high-impact merge.

Not for: an ordinary branch that just needs finishing (`review-and-ship`), a specific claim that needs proof (`verify-this`), what a change breaks elsewhere (`blast-radius`), or a first-pass bug sweep.

## Workflow

1. Fix the scope. Identify the change under review: a diff, a branch against its base, named files, or a design. Capture the exact base and head when the change is committed.
2. State the intent in one paragraph, derived from the request, commit messages, and the change itself. Reviewers challenge the execution against that intent, not the intent itself. If the intent is genuinely unclear, ask before spending the review.
3. Assemble context. Give reviewers the change plus the surrounding code they need to judge it: callers, callees, types, tests, and the contract it must satisfy.
4. Run independent review passes. Prefer two or more subagents that work in parallel and do not see each other's output, each with the same brief and rubric. Use independent passes with fresh attention when subagents are unavailable. Different reviewers catch different real defects; do not assign personas.
5. Synthesize. Parse every finding, deduplicate findings that describe the same issue, and mark which passes raised each. Findings raised independently by two or more reviewers are the highest signal. Note direct disagreements.
6. Apply lead judgment. You are the lead reviewer, not a neutral aggregator. Trace the call chain, check the context, and decide which findings are real and which are noise. See `references/lead-judgment.md`.
7. Verify cheap findings before reporting. A finding that names an execution path is stronger than one that asserts a risk. When verification is not possible, mark the finding UNPROVEN and say what evidence would settle it.
8. Report to the output contract. Do not apply fixes.

## Severity

```text
CRITICAL       bugs, data loss, security holes, or fundamentally broken behavior; would block a real change
IMPORTANT      correctness or design defect that will cause pain; maintainability risk; broken contract
MINOR          small, low-impact improvement; style, naming, legibility
UNPROVEN       a plausible problem that could not be verified; state what evidence would settle it
FALSE_POSITIVE raised but dismissed; give the reason (wrong, nitpick, missing context, preference)
```

CRITICAL, IMPORTANT, and MINOR are real findings. UNPROVEN is a finding you could not establish. FALSE_POSITIVE records what you rejected and why, so the reader can override you. An empty review is a valid outcome.

## Finding contract

Every real finding (CRITICAL, IMPORTANT, MINOR) carries all of these fields. UNPROVEN carries them except that verification is the open question. See `references/finding-schema.md`.

```text
claim                     one sentence: what is wrong
evidence                  the specific code, line, or reasoning that shows it
affected surface          the file, function, endpoint, or user path it touches
impact                    what breaks, for whom, and how bad
reproduction or reasoning the exact path that reaches the defect, or the argument that it does
originating change        the commit or change that introduced it, when knowable
minimal repair            the smallest fix, not a redesign
verification required     the check that would prove the fix
confidence                high, medium, or low, with the reason
```

## Hard rules

- Do not auto-apply fixes. Report findings only, unless the user explicitly asks for repairs.
- Do not approve on vibes. Every real finding must be checkable.
- Separate "this is broken" from "I would have done it differently". The second is FALSE_POSITIVE unless the reviewer shows a concrete problem with the current approach.
- Do not inflate nits to fill the review. If a pass only produced style preferences, say the change is likely fine.
- Trace the call chain before flagging a hypothetical. A null that no caller can pass is not a finding.
- Give security and correctness findings more scrutiny, even from a single reviewer.
- Review is read-only by default, mutation level L0. Any fix is a separate, explicitly authorized task.
- Cite real locations with `file:line`. Do not invent callers, APIs, or versions.

## Output contract

```text
Intent:            <the one-paragraph intent from step 2>
Reviewers:         <one bullet per pass: identity or lens, and finding count>
Findings:          grouped by severity, each with the full finding contract
Agreement map:     where passes agreed, where they diverged, and what the pattern means
Counts:            CRITICAL n, IMPORTANT n, MINOR n, UNPROVEN n, FALSE_POSITIVE n
Next action:       the single most useful next step, such as "fix finding 1, then re-review"
```

Name the evidence level (E0 to E6) each verified finding reached. Vocabulary comes from `references/operating-contract.md`.

**Reply:** the review above. Do not apply changes.
