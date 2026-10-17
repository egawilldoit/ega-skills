---
name: recover-design-rationale
description: "Recover why code, a design, or a threshold has its current shape, using version-control history, pull requests, issues, project docs, comments, the current code, and incident records. Classify every claim PROVEN, SUPPORTED, INFERRED, or UNKNOWN and never manufacture rationale. Use understand-codebase for how it works; this skill is for why."
---

# Recover design rationale

Recover the forces behind a design. Code shows what it does; it does not carry its motivation. That lives in commits, pull requests, issues, docs, comments, and incident records, all incomplete. This skill reconstructs the why from evidence and is explicit about how strong that evidence is.

`understand-codebase` answers how it works. This skill answers why it is shaped that way. For what a change could break, use `blast-radius`.

## When to use

- "Why does X work this way", "why did we pick Y", "where did this threshold come from".
- Before changing a design whose constraints are not obvious.
- Explaining a past decision, regression, or incident.
- "Are we sure this is still needed".

## Workflow

1. Parse the target and the question. The target is the code, pattern, or decision. The question is the rationale, tradeoff, constraint, or history. If the target is vague, state your best interpretation and proceed.
2. Anchor in code. Capture the file and line range, the key symbols, the recent commits that touched them, and any pull request or ticket numbers present in those commit messages. This anchor seeds every search.
3. Search the available sources honestly, in priority order where available:
   - Version-control history, including blame and log with renames.
   - Pull or merge requests, including descriptions and review comments.
   - Issue tracker items and linked tickets.
   - Project docs and design notes.
   - Code comments near the target.
   - Incident and postmortem records, especially when the code is defensive (retries, timeouts, rate limits, guards, flags).
   - Chat or discussion records, when a connected tool can read them.
   Use connected tools and MCP servers where present. Record which sources were available and which were not.
4. Separate mechanics from motivation. A diff shows the change, not why. Claim intent only when a source states it. Never treat the current code as evidence for its own intent.
5. Classify every claim into exactly one tier and phrase it to match:
   - PROVEN: a source states it explicitly. Cite it.
   - SUPPORTED: several independent items converge and none states it outright. Cite them and name the convergence.
   - INFERRED: a reasonable reading with nothing explicit behind it. Hedge it and show the inference chain.
   - UNKNOWN: you looked and did not find it. Name what you searched.
6. Spot-check citations before reporting. If unsure an item exists or says what is claimed, verify it or drop it.
7. Report gaps concretely: the question, the sources searched, the queries used, and what was found or not found.

See references/epistemics.md for the tier definitions, phrasing, and the calibration check.

## Hard rules

- Do not manufacture rationale. A confident guess the evidence does not support is the failure this skill exists to prevent.
- Do not optimize for looking decisive. An honest UNKNOWN is a useful result.
- When sources contradict, report both with citations. Do not pick the tidier story.
- If the question contains a hypothesis ("I assume this is for performance"), treat it as one candidate and check it independently. Do not confirm it by default.
- If the answer has no evidence, send the reader to a human who would know rather than filling the gap.
- Code shape is mechanics, not motivation. Do not cite it as evidence of intent.

## Output contract

- The question, restated in one or two sentences.
- The code in question: paths, line ranges, symbols.
- What we found: one bullet per claim tagged PROVEN or SUPPORTED, each with a citation.
- What we can infer: INFERRED claims, hedged, with the reasoning shown.
- Competing hypotheses: each with evidence for and evidence against or missing. Include only when the record supports more than one reading.
- What we do not know: the specific unanswered questions and the sources or searches that came up empty.
- Sources consulted: one line per source, including those that returned nothing and those unavailable, with the reason.
- Confidence summary: one or two sentences on overall strength.
- When the question precedes a change, a short constraint set: Preserve, Change, Avoid, Risk.

Reporting uses the labels in references/operating-contract.md. Map the tiers to its knowledge states: PROVEN is PROVEN, SUPPORTED is SUPPORTED, INFERRED is ASSUMED, UNKNOWN is UNRESOLVED. State the evidence level reached (E0 to E6) for any check you executed.

**Reply:** the output above. Do not soften a UNKNOWN.
