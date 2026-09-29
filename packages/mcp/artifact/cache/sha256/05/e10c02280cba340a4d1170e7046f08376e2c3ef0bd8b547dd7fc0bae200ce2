# Decision ledger

A compact, auditable record of the consequential decisions in a long or unattended run. One row per decision. Evidence pointers, not essays. The ledger plus the diff is what lets a human come back and trust the work.

## Format

Use a tab-separated table so it diffs cleanly and parses easily. Keep one file per run.

```text
timestamp	phase	decision	why	evidence	result
```

| Column | Meaning |
|--------|---------|
| `timestamp` | ISO 8601. |
| `phase` | The phase or unit the decision belongs to. |
| `decision` | What was chosen, in one sentence. |
| `why` | The reason, in one sentence. |
| `evidence` | A pointer: a path, command, SHA, metric, or URL. Not a summary. |
| `result` | The observed outcome, or the state after the decision. |

Add `repository`, `base_sha`, and `head_sha` columns when the run spans commits, and an `environment` column when it depends on a runtime.

## Rules

- Append only. Do not rewrite history to look cleaner.
- One row per consequential decision. Skip trivia.
- An evidence pointer must let a reader re-run or re-inspect the claim.
- Record a negative result as plainly as a positive one.
- Add a row as each unit lands, not in one batch at the end.
- When a reviewer must trust the result, commit the ledger so it travels with the change. Otherwise keep it in scratch and do not commit it.

## Example

```text
timestamp	phase	decision	why	evidence	result
2026-01-04T10:02:00Z	Frame	Done predicate: import of 10k rows completes under 30s	Import is the slow path users complain about	benchmarks/import-baseline.txt	baseline 92s, threshold set
2026-01-04T11:15:00Z	Run loop	Add batch insert in chunks of 500	Chunking cut round trips without changing the API	tests/import_test.py	VERIFIED 24s, under threshold
2026-01-04T12:40:00Z	Run loop	Reject a cached prepared statement	No measurable gain, added state	benchmarks/import-cached.txt	NOT VERIFIED, reverted
```

The third row shows a reverted experiment. Negative rows stay in the ledger; that is the point.
