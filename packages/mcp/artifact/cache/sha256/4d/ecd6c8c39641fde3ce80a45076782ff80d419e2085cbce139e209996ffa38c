---
name: reconcile-project-truth
description: "Reconcile contradictions about the same project across Git, GitHub, CI, deployment, runtime, trackers, documentation, and agent reports by resolving each claim against its authoritative source. Use when sources disagree about what shipped, what passed, what is deployed, or what status work is in. Read-only by default; do not mutate trackers or external systems unless the current task authorizes external writes."
---

# Reconcile project truth

Different systems describe the same project, and they disagree. This skill
resolves each disagreement against the source that is authoritative for that
claim type, then reports what is actually true.

Technical truth outranks reported status. A tracker that says "done" does not
make code shipped, and a document that says "deployed" does not make a
deployment exist.

## Authority by claim type

| Claim type | Authoritative source |
| --- | --- |
| Implementation truth | repository at the exact SHA |
| PR status | the hosting platform for that repository |
| CI truth | the exact checks associated with the exact SHA |
| Deployment truth | the deployment platform |
| Runtime truth | the running environment |
| Project-management status | the tracker, after reconciling against technical truth |
| Narrative or intent | documentation, issues, or the author |

An agent report is a claim, not evidence. Treat it as `E0` until it points to
something checkable.

## Workflow

1. Enumerate the claims in conflict. Write each as one sentence with its source.
2. Classify each claim by type using the table above.
3. Gather authoritative evidence for each claim. Use the exact SHA, the exact
   checks, the exact environment, the exact record.
4. Assign a knowledge state to each claim: `PROVEN`, `SUPPORTED`, `ASSUMED`,
   `UNRESOLVED`, or `CONTRADICTED`.
5. For every contradiction, state the authoritative value and the losing value.
6. List the updates required to make each non-authoritative source match the
   authoritative one.
7. List unresolved evidence: claims that cannot be checked with available
   access, and what access would settle them.

## Hard rules

- Do not mutate trackers, documentation, or external systems unless the current
  task authorizes external writes (`L4`). Otherwise propose the update and mark
  it `AUTHORITY_REQUIRED`.
- Do not let a tracker status override repository, CI, deployment, or runtime
  truth.
- Do not resolve a contradiction by trusting the most recent edit. Resolve it by
  evidence class.
- A claim you cannot check is `UNRESOLVED`, not false and not true.
- Report the evidence level reached for the reconciliation itself.

## Output contract

```text
RECONCILIATION: CONSISTENT | CONTRADICTIONS_FOUND | INSUFFICIENT_EVIDENCE

Contradictions:
- claim: <one sentence>
  sources: <source A says X> | <source B says Y>
  authoritative: <source> -> <value>
  losing: <source> -> <value>
  state: CONTRADICTED | UNRESOLVED

Authoritative state:
- <claim type>: <value> (source, evidence level)

Updates required:
- <system>: <exact change> (authorized: yes | no, mutation level)

Unresolved evidence:
- <claim>: <what is missing> -> <what access would settle it>
```

Shared vocabulary is in `references/operating-contract.md`.
