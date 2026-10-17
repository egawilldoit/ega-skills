# Review rubric

Review through whichever lenses apply. Not every lens fits every change. Use judgment.

## Correctness

Does the change do what the intent says it should?

- Edge cases: empty input, null or undefined, boundary values, concurrent access.
- Error handling: are errors caught, propagated, or silently swallowed?
- Off-by-one, type coercion, integer overflow, string encoding.
- State management: race conditions, stale closures, dangling references.
- Does the happy path work? Does the failure path work?
- Idempotency: what happens if the operation runs twice, or a previous run crashed halfway? If the answer depends on leftover state, there is a missing reconciliation step.
- Concurrency: if multiple actors touch the same mutable state, is access serialized structurally (locks, sequential phases, exclusive ownership), or only by convention?

When you find a potential bug, trace the execution path. Do not just flag "this could be null". Show the call chain that makes it null.

## Root cause versus symptom

Is the change fixing the real problem or papering over a symptom?

- Guard clauses that mask a deeper invariant violation.
- Retry logic that hides a broken contract.
- Type casts that silence a modeling error.
- A fix in module A that should be a fix in module B's contract.
- Instructions where structure would be better: a comment saying "do not do X", or a convention someone must remember, versus a type constraint, a lint rule, or a runtime check.

## Structural integrity

Does the change fit the system it joins?

- Boundary discipline: is validation at the boundaries, or scattered through business logic?
- Abstraction level: is orchestration mixed with low-level detail?
- Coupling: does the change add dependencies that make future changes harder?
- Data model fit: do the data structures match the access patterns?
- Bolted on versus integrated: does the change read as if the design always accounted for it?
- Legacy dual paths: does it add a new API while keeping the old one alive with no external consumers? Migrate callers and delete the old path in the same wave.

Do not penalize simple code for lacking abstraction. Premature abstraction is worse than duplication.

## Verification

Can you tell the change works from reading it?

- Are there tests? Do they test behavior or implementation details?
- Are there assertions or invariants that would catch a regression?
- If this fixes a bug, is there a test for that bug?
- Does the change check the real value, or a proxy such as a timestamp, a cache, or a self-report?
- For delegated or async work: does it verify the actual artifact, or trust a summary?

## Complexity budget

Is the complexity justified?

- Code that could be simpler without losing correctness or clarity.
- Abstractions with a single call site.
- Configuration for cases that do not exist yet.
- Dead code, unused imports, vestigial parameters.
- Transitional compatibility paths whose migration is already done.

Simpler is better unless simpler is wrong. Three lines of duplication beat a premature abstraction.

## Security

For each security finding, trace the input path through the code and show it.

- User input reaching a dangerous sink (SQL, shell, eval, raw HTML) without sanitization.
- Authentication or authorization gaps on new endpoints.
- Secrets in code, logs, or error messages.
- Time-of-check versus time-of-use in security-critical paths.

## Code quality

Be ambitious about structure. Look for restructurings that preserve behavior and make the implementation smaller and more direct.

- Do not let a change push a file from under a size threshold to well over it without a strong reason.
- Treat ad-hoc conditionals inserted into unrelated flows as a design problem, not a style nit.
- Prefer direct, boring, maintainable code over brittle or magical code.
- Question unnecessary optionality and cast-heavy contracts when a clearer type boundary exists.
- Keep logic in the canonical layer and reuse existing helpers.
- Flag avoidable sequential orchestration or non-atomic updates when a cleaner structure is obvious.

Prioritize structural regressions and missed simplifications first, then branching complexity, then boundary and type concerns, then smaller legibility issues.
