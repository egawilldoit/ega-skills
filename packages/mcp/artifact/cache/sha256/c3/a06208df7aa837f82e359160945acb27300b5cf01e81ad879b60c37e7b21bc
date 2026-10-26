# Task record and final receipt

Keep one concise record in the existing issue or approved task store. Link
evidence rather than copying full logs. Tracker writes require task authority.

## Record when starting or resuming

```text
Outcome / acceptance / exclusions:
Program: single outcome | finite program (list eligible outcomes)
Repository / integration branch / base and current revision:
Environment / finish boundary:
Authorized actions / reserved actions:
Prior work inspected: dirty trees, stashes, worktrees, cancelled workers
Stage reached / evidence links:
Blockers by stage: operation, target, observed result, dependent stage, owner
Next action / owner:
```

## Per-outcome receipt

Use one receipt per outcome, including every outcome in an authorized finite
program. Omit irrelevant fields or mark them `not run` / `outside boundary`.

```text
Outcome / boundary / stage:
Artifact: source SHA, PR/MR, actual target branch, merge SHA if performed
Worker integration: claimed commit/artifact, preserved dirty work, proof it is
                    present in the integration revision, or not applicable
Checks: local or CI, named checks, executed inputs, results, evidence links
Review: reviewer, examined revision, findings; or pending/blocked
Runtime: environment, deploy/release ID, revision/configuration, observation
         time, actual journey and failure/refusal; or not run/outside boundary
Acceptance: criteria met, limitations, reserved owner acceptance if applicable
Next action / owner; or none within boundary
```

## Program summary

For an authorized finite program, list each outcome and its state. Do not
replace the per-outcome receipts with a count of commits or tests.

```text
Program boundary:
Outcome 1: state / receipt reference
Outcome 2: state / receipt reference
Stopped because: program complete | named blocker | owner decision required
```

## Keep claims at the observed stage

Map to existing tracker states. Keep blocked as a reason alongside the stage
reached. Correct earlier inaccurate claims without rewriting historical
observations as fresh tests. In a snapshot-only exercise, distinguish supplied
historical results from proposed next actions; no new live merge, deployment, or
status write was performed by the exercise.

Implementation, integration, merge, deployment, hosted acceptance, and owner
acceptance are separate claims. A local script result proves local behavior. A
pushed branch proves neither a PR nor a merge. A merge proves neither deployment
nor acceptance.

## Select helpers narrowly

Discover helpers in the execution runtime. Use preflight/context recovery for
missing starting facts, implementation/debugging for code, UI/smoke verification
for observations, CI repair for a failing check, and independent code review
before merge. Stack integration applies to actual dependency stacks; release
certification applies to a release. Load the relevant procedure rather than
auditing the whole project.
