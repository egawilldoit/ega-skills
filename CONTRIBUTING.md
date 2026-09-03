# Contributing to EGA Skills Hub V1

## The specs are authoritative

`docs/specs/` is the normative V1 behavioral contract. Implementation must trace
visibly to it:

- Every behavior-changing PR MUST reference the exact frozen rule:
  `SPEC-00X §...` and, where applicable, `TEST-00X` (scenario IDs for TEST-001,
  vector IDs for TEST-002).
- PR authors MUST explain:
  1. which frozen rule is implemented;
  2. which acceptance criteria (ACs) are covered;
  3. whether any contract change is required.
- If no contract change is required, the PR implements existing frozen behavior
  ONLY and introduces no undeclared API/behavior.
- If a contract change IS required: stop the affected behavior, amend the spec
  and its tests first (reviewed spec amendment), and only then change behavior.
  Silently redefining behavior in code is prohibited.

Use the pull request template (`.github/pull_request_template.md`) — its
Spec contract / Contract impact / Verification sections are mandatory.

## Determinism and cross-platform rules

- Same inputs produce byte-identical meaningful outputs on Linux and Windows.
- Never assert absolute BM25 values; relative order + stable tie-breakers only.
- Never persist `0` as a binary token sentinel; never fall forward across versions.
- Token counts use `ega-o200k-v1` exclusively; TEST-002 must pass before
  budget-aware router behavior is accepted.
- stdout is MCP protocol only; logs/diagnostics go to stderr.

## Verification before review

- `pnpm specs:check` (spec-drift guardrail) must pass.
- `git diff --check` must pass.
- Every wave ends green on Linux + Windows where applicable.
