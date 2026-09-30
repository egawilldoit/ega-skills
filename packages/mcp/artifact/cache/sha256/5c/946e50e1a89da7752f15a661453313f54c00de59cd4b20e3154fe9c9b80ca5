# Decision log

A compact, auditable record of the consequential decisions in a long or unattended run. One row per decision. Evidence pointers, not essays. The log plus the diff is what lets a human come back and trust the work.

## Format

A single tab-separated file, one row per decision. Cells stay on one line. Tab-separated so it diffs cleanly, parses easily, and renders as a table in most hosts and terminals.

```text
ts	phase	decision	why	evidence	result	repository	base_sha	head_sha	environment
```

| Column | Meaning |
|--------|---------|
| `ts` | ISO 8601 UTC timestamp. |
| `phase` | The phase or unit the decision belongs to. Use `start` for the first row of a new run. |
| `decision` | What was chosen or done, one sentence. |
| `why` | The reason in plain words. If a principle drove it, say it plainly. |
| `evidence` | A pointer that proves it: a path, command, commit SHA, pull request number, `file:line`, artifact, trace, or screenshot. Never a paragraph. |
| `result` | The observed outcome or the state after the decision: `tests green`, `reverted`, `pixel diff 0`, `INCONCLUSIVE`, `open`. |
| `repository` | The repository the decision belongs to, when the run spans one. |
| `base_sha` | The commit the work started from, when the run spans commits. |
| `head_sha` | The commit the work reached, when the run spans commits. |
| `environment` | The runtime or environment, when the decision depends on one. |

Columns after `result` are optional in a local log and required when a reviewer needs the trail to trust the result. Empty is allowed; write the header row once.

Start from `references/decision-log-template.tsv` (the header row), or let `scripts/log.sh` write the header on first use.

## Logging a row

Write each entry the way you would tell a teammate what you did. Plain words, concrete actions, no jargon. Use the helper:

```bash
scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result> \
               [repository] [base_sha] [head_sha] [environment]
```

The helper stamps `ts`, writes the header on first use, strips stray tabs and newlines, and prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote so spreadsheet software cannot execute it. A bare `printf` appending a row works too, but apply the same care to generated or user-supplied text.

Log decision points and checkpoints, not every action:

- a fork chosen,
- a unit completed with its verification result,
- a pivot or revert with its trigger,
- a blocker surfaced,
- a gate fixed.

For a loop, one row per iteration. Skip the trivial and the self-evident.

## Runs

A run is one agent conversation, including its later turns. A handoff, a replacement agent, or a new conversation starts a new run. When a run adds to a log that already has rows, its first row has phase `start`, and so does its first row after another run's `start` row. A `start` row names the timestamp range of the rows before it that this run did not write, and its evidence names this run. Use phase `start` for nothing else.

## Where it lives

By default the log is a working artifact, not committed. Keep it at `decisions.tsv` in the work directory, or `.audit/<task-slug>.tsv` when several efforts run at once, and leave it out of version control.

Commit it only when the work is ambitious enough that a reviewer needs the trail to trust the result.

## Rules

- Append only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- One row per consequential decision. Skip trivia.
- An evidence pointer must let a reader re-run or re-inspect the claim.
- Record a negative or reverted result as plainly as a positive one.
- Add a row as each unit lands, not in one batch at the end.
- Do not log secrets, credentials, or private data.

## Example

```text
ts	phase	decision	why	evidence	result	repository	base_sha	head_sha	environment
2026-05-24T09:02:00Z	start	Resumed the import work from the prior run	Picking up an in-flight task	conversation 4f2a	started	acme/api	8c1d9e2	8c1d9e2	local
2026-05-24T09:40:00Z	frame	Done predicate: import of 10k rows completes under 30s	Import is the slow path users complain about	benchmarks/import-baseline.txt	baseline 92s, threshold set	acme/api	8c1d9e2	8c1d9e2	local
2026-05-24T11:15:00Z	widget	Add batch insert in chunks of 500	Chunking cut round trips without changing the API	tests/import_test.py	VERIFIED 24s, under threshold	acme/api	8c1d9e2	7c21e0a	local
2026-05-24T12:40:00Z	widget	Reject a cached prepared statement	No measurable gain, added state	benchmarks/import-cached.txt	NOT VERIFIED, reverted	acme/api	7c21e0a	7c21e0a	local
```

The reverted row stays. Negative rows are the point.

## Reviewing the log

Read top to bottom, follow the evidence pointers, spot-check. In a terminal, `column -s$'\t' -t decisions.tsv` aligns the columns. Most code hosts render a committed TSV as a table.
