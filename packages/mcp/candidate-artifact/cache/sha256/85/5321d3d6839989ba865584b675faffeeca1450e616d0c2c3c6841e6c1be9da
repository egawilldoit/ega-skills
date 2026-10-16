# Epistemics

How to reason about confidence when evidence is historical, fragmentary, and sometimes contradictory, and how to communicate it without flattening it into false certainty.

Code does not carry its own motivation. You can read what code does. You cannot read why it exists. That lives in commits, pull requests, tickets, docs, and conversations, all incomplete, biased, and sometimes missing. Pretending otherwise produces confident-sounding guesses that mislead the reader.

## Confidence tiers

Every claim in the final output sits in exactly one tier. The tier decides which output section the claim goes in and how it is phrased.

### PROVEN

An explicit, textual citation that answers the question. Not "the code does X so the author must have wanted X". Something an author actually wrote that says why.

Examples:

- A pull request description that says "this fixes the bug where users with more than 1000 items could not paginate".
- A ticket that says "we are adding this because customer Acme requested it in their security review".
- A code comment that says "clamp to 100 because the upstream API rejects larger values".
- A design doc that says "we chose option A over option B because we need persistence across restarts".
- A chat message from the author saying "switching to this approach since the old one was flaky in tests".

Phrasing: confident, present tense. "This exists because X." Cite the source.

### SUPPORTED

Multiple pieces of indirect evidence converge. No single source states it explicitly, but the pattern across sources makes it likely.

Examples:

- The pull request title says "improve performance", the ticket is labeled "perf", and the surrounding commits all touch the same hot path.
- Multiple tests were added alongside the change, all exercising edge cases with very large inputs.
- The author's other pull requests from the same week all mention the same incident.

Phrasing: confident but clearly derived. "The evidence points strongly to X: [the specific pieces]." Cite multiple sources.

### INFERRED

A reasonable reading of the context, but nothing explicitly supports it. The reader should understand this is your interpretation, not a fact from the record.

Examples:

- The pull request does not say why, but given the error was happening in production and the fix was merged the same day, it was likely a hotfix.
- The function name suggests retry logic. The retry count is 3, matching the convention seen elsewhere in the codebase.

Phrasing: hedged. "It appears", "likely", "suggests", "is consistent with", "one reading is". Make the inference chain explicit: "Given A and B, C seems likely because D."

### UNKNOWN

You looked and could not find out. A valid and important outcome. Document it.

Phrasing: "We searched X, Y, and Z and found no evidence of why." Be specific about what you searched. "We could not find out" is less useful than "we searched the ticket tracker with keywords A and B, scanned the 6 pull requests that touched this file since 2023, and searched the repo for literals matching the threshold. None surfaced a rationale."

## Phrasing guide

### Words that carry confidence

These imply PROVEN or SUPPORTED. Do not use them for inferences.

- "because". Implies a causal claim with evidence.
- "the reason is". Same.
- "was designed to". Claims author intent.
- "fixes", "addresses", "solves". Claims the change achieved its goal.
- "the team decided". Claims a group decision happened.

If you use one of these, a citation must sit immediately next to it.

### Words that hedge

Use these for INFERRED claims.

- "appears to"
- "seems to"
- "likely"
- "suggests"
- "is consistent with"
- "one reading is"
- "plausibly"
- "may have been"
- "the evidence points toward"

### Words to avoid

- "obviously". If it were obvious, the reader would not be asking.
- "clearly". Almost always precedes a claim that is not clear.
- "of course". Same.
- "just" (as in "it is just X for performance"). Dismissive and usually hides uncertainty.
- "I think" / "I believe". You are synthesizing evidence, not giving a personal opinion. Use "the evidence suggests".

### Avoid rationalization

Code that "makes sense" today may have been written for reasons that no longer apply, or that were wrong when written. Do not retrofit a clean rationale onto messy history.

Do not:

- Assume the author did the right thing and work backward to justify it.
- Assume a consistent pattern across the codebase was intentional when it might be copy-paste.
- Turn an absence of evidence into evidence of absence ("no one mentioned security concerns, so it must not have been a concern").

## The sycophancy trap

Users often phrase why questions with an embedded hypothesis: "Why do we do it this way, I assume it is for performance?" Do not simply confirm it. Treat it as one candidate and check the evidence independently. If the evidence supports it, say so with citations. If not, say so and present what the evidence does support.

The user's guess is a prompt for investigation, not a conclusion to validate.

## When evidence contradicts

If two sources disagree, surface both. Do not pick the one that fits a tidier narrative. For example, the ticket says "we need this for customer X's compliance requirement" while the pull request says "cleaning up tech debt in this area". Both may be true, or one may be wrong. Present both with citations and let the reader decide.

## When evidence is missing

An honest "we do not know" is one of the most valuable outputs this skill can produce. The reader now knows the answer is not in the obvious places, that they need to ask a human who would know, or that the question is not worth pursuing.

Filling a gap with a confident guess harms the reader, who will act on it. Name a gap concretely: the question you were trying to answer, the sources you searched, what you searched for in each, and what you found.

## Calibration check before finalizing

Review every claim in "What we found" and "What we can infer" and ask:

1. Does this claim have a citation? If not, either add one or move it to INFERRED.
2. Is the phrasing calibrated to the tier? A PROVEN claim can use "because". An INFERRED claim cannot.
3. Am I treating the code itself as evidence for its own intent? If so, that is not evidence. Remove or reclassify it.
4. Does the output include a "What we do not know" section? If no gaps are mentioned, that is suspicious. Either the evidence was unusually complete or something is being swept under the rug.
