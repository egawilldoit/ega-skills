---
name: recover-work-context
description: "Reconstruct the current state of ongoing work so it can be resumed without re-reading everything. Use for 'catch me up', 'where did I leave off', 'what is the state of X', 'resume this', or before starting or taking over work. Pulls from conversation history, the repository, pull requests and issues, project trackers, docs, CI, and deployment state, then prioritizes current verified truth over historical narrative. Returns objective, current verified state, important decisions, what is done, what remains, what is blocked, and the next exact action. Use what-did-i-get-done to summarize authored commits; use work-retrospective to learn from one finished session."
---

# Recover work context

Before starting or resuming work, rebuild the current state and hand back a tight brief of where things stand and what to do next. Current truth beats historical narrative: a merged pull request outranks a chat that said the work was done.

Do not limit this to conversation history. Chat holds what was said and decided. The repository, pull requests, issues, trackers, docs, CI, and deployment state hold what actually happened. Use both, and verify the live sources.

## When to use

- "Catch me up", "where did I leave off", "what is the state of X", "resume this".
- Before starting or taking over work you or another agent began earlier.
- After a gap in time, or when picking up someone else's branch.
- Before a status update that must be accurate.

Not for: summarizing authored commits (`what-did-i-get-done`), a weekly recap (`weekly-review`), lessons from one finished session (`work-retrospective`), or mining recurring behavior across history (`mine-work-patterns`).

## Workflow

1. Lock the scope before searching. Pin the topic if named, the time window ("recent" is a real range, default to the last seven days), and the repository or workspace (default the active one). Never read another project's private history without being asked. State the scope back, and never quietly turn "all" into "recent N".
2. Inventory the sources and their availability. See `references/evidence-sources.md` for the per-source playbook: conversation history, repository, pull requests and issues, project tracker, docs, CI, and deployment state. Note which are available and which are not. An unavailable source is a finding, not a silence.
3. Search in parallel where volume is large. Split the corpus into slices and run subagents, each returning the same schema: topic, goal, decisions, open threads, friction and corrections, and artifacts such as branches, pull requests, and tickets, each with a source pointer. Keep raw transcripts and payloads in the subagents. For one or two sources, search directly.
4. Verify against live state. Take every branch, pull request, ticket, and deployment the search surfaced and check it with the version-control tool and the tracker or host CLI. Do not report a state you only saw described.
5. Reconcile contradictions. When sources disagree, use the authoritative source for that claim (see `references/evidence-sources.md`). If they still disagree, report both and mark the claim CONTRADICTED rather than picking the tidier story.
6. Write the brief to the output contract. Group by thread. Stay on the named topic.

## Knowledge state

Tag each material claim with the knowledge state from `references/operating-contract.md`:

```text
PROVEN        demonstrated by live evidence you checked
SUPPORTED     consistent evidence, not exhaustive
ASSUMED       taken as true without checking
UNRESOLVED    not enough information yet
CONTRADICTED  sources disagree
```

Name the evidence level (E0 to E6) reached for any check you executed. A claim backed only by a chat message is E0. A claim you confirmed against the live branch is E2 or higher.

## Hard rules

- Prioritize current truth over historical narrative. Verify, do not narrate.
- Do not infer present state from a chat when a live source can be checked.
- Cite every finding with a source pointer: commit, branch, pull request number, ticket id, or file path.
- Report unavailable sources and empty searches as findings.
- Read-only by default, mutation level L0. Do not mutate trackers, branches, or deployments while reconstructing state.
- Sanitize private context before any output that leaves the workspace.
- Keep the brief tight. Cut detail before you cut threads.

## Output contract

```text
Objective            what this work is trying to achieve, one or two sentences
Current verified state  the live state, per source, with pointers and knowledge states
Important decisions  the decisions that shaped the work, with status and rationale
Done                 what is finished and verified, with the evidence
Remaining            what is left, in the order it should happen
Blocked              what cannot proceed, and the blocker type
Next exact action    the single most useful next step, concrete
```

`Blocked` uses the blocker types from `references/operating-contract.md`: FIX_FORWARD, INVESTIGATE, HARD_STOP, or AUTHORITY_REQUIRED. When nothing is blocked, write `none`.

**Reply:** the brief above, ending with the next exact action.
