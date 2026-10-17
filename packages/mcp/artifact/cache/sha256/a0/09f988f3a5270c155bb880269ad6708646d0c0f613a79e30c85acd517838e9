---
name: record-evidence
description: "Maintain a compact auditable decision and evidence ledger for long-running, autonomous, or multi-phase work, so a human who steps away can later trust the result. Use at the start of an unattended run, when several efforts run at once, or whenever a reviewer will need the trail to trust the outcome. Records one row per consequential decision with timestamp, phase, decision, why, evidence pointer, result, repository, base SHA, head SHA, and environment when relevant. Append-only and deterministic, with a helper script and a fixed TSV format. Use design-investigation to design the run; this skill keeps its ledger."
---

# Record evidence

Keep one canonical decision ledger for a long or unattended run. The ledger plus the diff is what lets a human come back and trust the work. Evidence is a pointer, not prose.

This skill owns the format. Other skills route their audit trail here instead of inventing one: reference it by name and let it own the columns.

## When to use

- A long, autonomous, or multi-phase run that a human will review after stepping away.
- Several efforts running at once, each needing its own trail.
- Any run where a reviewer must trust the result without having watched it happen.
- A run that hands off to another agent or session.

Not for: designing the run itself (`design-investigation`), reconstructing current state (`recover-work-context`), or a short task with no consequential forks.

## Format

One TSV file, one row per decision. See `references/decision-log.md` for the full column definitions and rules.

```text
ts	phase	decision	why	evidence	result	repository	base_sha	head_sha	environment
```

The first six columns are always present. `repository`, `base_sha`, and `head_sha` are required when the run spans commits. `environment` is required when a decision depends on a runtime. Empty cells are allowed.

## Workflow

1. Choose the location. Default to `decisions.tsv` in the work directory, or `.audit/<task-slug>.tsv` when several efforts run at once. Keep it out of version control by default. Commit it only when the work is ambitious enough that a reviewer needs the trail to trust the result.
2. Initialize the log. Start from `references/decision-log-template.tsv`, or let `scripts/log.sh` write the header on first use.
3. Log as you go. Append a row at each decision point and checkpoint: a fork chosen, a unit completed with its verification result, a pivot or revert with its trigger, a blocker surfaced, a gate fixed. For a loop, one row per iteration. Do not batch rows at the end.
4. Use the helper to append rows safely:

   ```bash
   scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result> \
                  [repository] [base_sha] [head_sha] [environment]
   ```

   It stamps the timestamp, writes the header on first use, strips stray tabs and newlines, and neutralizes spreadsheet formula prefixes.
5. Append only. A wrong call gets a new row that supersedes it. Never edit or delete history.
6. Audit the log against what actually happened before handing back. Every row must map to a real decision, every evidence pointer must resolve and show what the row claims, and any fork or pivot that shaped the work but is not logged is a gap to add. Correct the log, not the story: supersede a wrong row, never remove it.
7. Get an independent read. Have a reviewer that did not do the work scan the ledger and the run for decisions logged with weak evidence, verification claimed without proof, risky choices in hindsight, and gaps a casual skim would miss.
8. Report to the output contract, ending with an Attention section.

## Runs

A run is one agent conversation, including its later turns. A handoff or a new conversation starts a new run. When a run adds to a log that already has rows, its first row has phase `start`, and so does its first row after another run's `start` row. Use phase `start` for nothing else. See `references/decision-log.md`.

## Hard rules

- Append only. Never edit or delete a row, even an invented one. Supersede it.
- One row per consequential decision. Skip the trivial and the self-evident.
- Evidence is a pointer that resolves, not a paragraph. A reader must be able to re-run or re-inspect the claim.
- Record a negative or reverted result as plainly as a positive one.
- Add rows as work proceeds, not in one batch at the end.
- Do not log secrets, credentials, or private data.
- The ledger is not a substitute for the work. Do not claim a result the evidence pointer does not show.
- Do not name a specific model or subagent runtime.

## Output contract

```text
Log location      the path, and whether it is committed
Rows added        the rows this run wrote, one line each
Audit             gaps found and superseded rows, or "clean"
Attention         reviewed by <reviewer identity>; then each flag with its row, or "no flags"
Evidence level    the evidence level (E0 to E6) the run reached, from references/operating-contract.md
Completion state  the completion state (IMPLEMENTED to CLOSED) the work reached
```

The independent reviewer's identity is required in the Attention section. "No flags" is a valid value; a missing reviewer is not.

**Reply:** the output contract above, ending with the Attention section.
