# Finding schema

The exact shape of one finding. Every real finding carries all fields. Keep each field to one or two lines. A reader should grasp the finding in a few seconds.

## Fields

| Field | Meaning |
|-------|---------|
| `claim` | One sentence: what is wrong. |
| `evidence` | The specific code, line, test, or reasoning that shows it. Cite `file:line` where possible. |
| `affected surface` | The file, function, endpoint, or user path the defect touches. |
| `impact` | What breaks, for whom, and how bad. |
| `reproduction or reasoning` | The exact path that reaches the defect, or the argument that it does. |
| `originating change` | The commit or change that introduced it, when knowable. Write `unknown` otherwise; do not guess. |
| `minimal repair` | The smallest fix that resolves the finding. Not a redesign. |
| `verification required` | The check that would prove the repair works. |
| `confidence` | `high`, `medium`, or `low`, with a short reason. |

UNPROVEN findings carry the same fields, except that `verification required` is the open question and `minimal repair` may be absent.

FALSE_POSITIVE entries carry only a one-line principle and the reason for rejection: `wrong`, `nitpick`, `missing context`, `preference`, or `already covered`.

## Severity

```text
CRITICAL       bugs, data loss, security holes, or fundamentally broken behavior; would block a real change
IMPORTANT      correctness or design defect that will cause pain; maintainability risk; broken contract
MINOR          small, low-impact improvement; style, naming, legibility
UNPROVEN       a plausible problem that could not be verified
FALSE_POSITIVE raised but dismissed, with the reason
```

## Confidence calibration

- `high`: the defect is visible in the code or was reproduced.
- `medium`: the reasoning is strong but the path was not run.
- `low`: plausible, with a real chance the context clears it.

Do not report high confidence on a claim you did not check. State the evidence level (E0 to E6) the verification reached. See `operating-contract.md`.

## Example

```text
### 1. [CRITICAL] Retry re-sends an already-committed charge
Claim: the retry path calls the payment client again after a timeout even when the first call committed.
Evidence: src/payments/charge.ts:88 retries on any error, including a timeout after commit.
Affected surface: checkout charge flow, all retry attempts.
Impact: duplicate charges to real customers; hard to reverse.
Reproduction or reasoning: timeout at line 84 is caught at line 88, which loops without an idempotency key.
Originating change: commit 4f9c2ab, "add retry on charge".
Minimal repair: pass the same idempotency key on every attempt.
Verification required: unit test asserting one client call under a post-commit timeout.
Confidence: high, the retry loop is unconditional.
```
