# Discovery findings and corpus-repo handoff

Evidence for the discovery work in this branch, and the exact changes that
belong in the **separate** skill corpus repository rather than here.

Measured against release `sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3`
(116 skills: `anthropic` 14, `egawilldoit` 66, `mattpocock` 27, `vercel` 9).

Reproduce with:

```bash
pnpm eval:discovery
```

## 1. Why routing metadata could not be fixed in this repository

The skill corpus is **not vendored in this repo**. There are zero `ega.yaml`
files in-tree. The 66 `egawilldoit` skills live in
`github.com/egawilldoit/skills`, pinned at commit `f48e0ed` and adopted as an
immutable, digest-verified external source
(`packages/mcp/artifact/hub-release.json` →
`payload.adopted_sources[0]`).

Editing metadata here is not possible without breaking the release contract:
`registry.sqlite`, `search-index-input.json`, `token-artifact.json`, and
`hub-release.json` are cross-checked by digest, and CI runs
`scripts/hosted/validate-artifact.mjs`. Hand-editing the projection would
desynchronise the artifact and fail verification.

**A metadata fix therefore requires: change in `egawilldoit/skills` → re-vendor →
rebuild the release → re-verify.** That work is out of scope here.

## 1a. Corpus invariants enforced by tests

`tests/discovery/discovery-evaluation.test.mjs` rejects a corpus that:

- names a skill the release does not contain (a typo must not weaken an
  expectation);
- contains an intent whose prompt trips an **anti-trigger of the skill it
  expects**. Five such collisions existed on the first pass and were all corpus
  bugs, not routing defects — for example the `idempotent-operations` prompt used
  the words "interrupted" and "retried", and `crash`/`retry` are declared
  anti-triggers of `principle-make-operations-idempotent`;
- is smaller than 50 measurable intents, where "measurable" excludes
  `pending_skill` intents, so marking intents pending cannot shrink the suite
  into a vacuous pass;
- targets a release digest other than the artifact's.

`tests/discovery/findings-accuracy.test.mjs` additionally verifies that this
document quotes each skill's declared triggers **exactly as the registry records
them**, so the handoff cannot silently drift.

## 2. Baseline discovery metrics

### What the window actually is

The discovery ranking is **the resolver's own window only**: `selected`, then
`candidates`, capped at 3. Raw `search` hits are deliberately NOT appended to it.
An earlier revision of this harness appended them, and that inflated top-3 from
80.2% to 84.0% while adding zero top-1 hits — FTS returns a median of 105 of 114
skills per task, so concatenating it pads the window with rows that carry no
ranking signal. Search reachability is therefore reported on its own.

| Metric | Value | Target | Status |
| --- | --- | --- | --- |
| Intents evaluated | 79 | >= 50 | met |
| Wrong automatic selections | 25 (of 33 that selected anything = 75.8%) | 0 | **not met** (§3) |
| Excluded skill **auto-selected** | 1 | 0 | **not met** (§4) |
| Excluded skill in a suggestion slot only | 16 | — | presentation issue, not safety |
| Expected skill ranked #1 | 36/79 = 45.6% | >= 90% | **not met** (§5) |
| Expected skill in top 3 (resolver window) | 65/79 = 82.3% | >= 98% | **not met** (§5) |
| Expected skill in top 3 of raw `search` | 68/79 = 86.1% | — | fallback path only |
| LOW-confidence results | 46/79 | — | informational |

Two numbers deserve emphasis because the raw counts alone are misleading:

- Only **9 of 79** intents auto-selected anything at all; the rest are LOW and
  correctly selected nothing. So "2 wrong selections" is a **22.2% error rate
  over attempts**, not 2/79.
- Of the excluded-skill hits, **1 would have executed** and 18 were merely
  suggestion slots a user must actively choose. Only the first is a safety
  failure, and only the first is gated on.

Per expected namespace:

Per expected namespace (top-1 / top-3 within the resolver window):

| Namespace | top-1 | top-3 |
| --- | --- | --- |
| `egawilldoit` | 49/69 | 56/69 |
| `anthropic` | 2/3 | 3/3 |
| `mattpocock` | 5/5 | 5/5 |
| `vercel` | 1/2 | 1/2 |

`ROUTER_SEMANTICS_UNCHANGED`. The resolver is untouched: every number above comes
from calling `resolveSkills` exactly as SPEC-004 freezes it. No router algorithm
change is justified, because every observed failure is explained by missing or
over-broad *metadata*, not by the ranking algorithm.

Scope of the measurement: intents are evaluated against a **bare temporary
project**, so these figures reflect default routing policy only. They do not
cover project-configured namespace allow/deny or lock-scoped routing.

## 3. Wrong automatic selections (execution safety) — 2 cases

Both are the **same defect class**: an over-broad `domains` entry producing strong
`DOMAIN_MATCH` evidence under SPEC-004 §5.1.17.

### 3.1 `reconcile-conflicting-truth`

> "The agent report, GitHub, CI, and deployment disagree about what shipped."

Result: `MEDIUM`, automatically selected `egawilldoit/get-pr-comments`.

Cause: `get-pr-comments/ega.yaml` declares `domains: [github]`. The literal word
"GitHub" in the task is therefore strong evidence, while
`reconcile-project-truth` has `domains: []` and only five narrow intent triggers.

Suggested fix in `egawilldoit/skills`:

```yaml
# skills/get-pr-comments/ega.yaml — remove the over-broad domain
- domains: [github]
+ domains: []
```

Its existing triggers already carry the intent (`pr comments`,
`pull request comments`, `review comments`, `reviewer feedback`,
`what did reviewers say`), so no new trigger is needed to keep it discoverable.

### 3.2 `react-performance`

> "Our React app feels sluggish. Apply the performance and architecture guidance
> from the Vercel team."

Result: `MEDIUM`, automatically selected `egawilldoit/design-architecture`.

Cause: `design-architecture/ega.yaml` declares `domains: [architecture]`, so
"architecture guidance" is strong evidence. Meanwhile
`vercel/react-best-practices` declares **no** domains, platforms, or frameworks
and carries only symptom-shaped triggers (`slow page`, `render waterfall`,
`unnecessary rerenders`), so it cannot match "React app feels sluggish".

Suggested fix in `egawilldoit/skills`:

```yaml
# skills/design-architecture/ega.yaml — narrow or drop the generic domain
- domains: [architecture]
+ domains: []
```

Both cases confirm the mission's predicted failure mode is real and reproducible
on the current release, and that it is broader than the single skill first
observed: **two skills in two namespaces show the same pattern.**

## 4. Excluded skills surfacing in the window — 19 intents

These surface a skill the intent explicitly excludes. Only **1 of the 19** would
have executed; the other 18 sat in a suggestion slot. The dominant cause is the
one in §5; the noisiest occupants across all 79 intents are:

| Skill | Times in the window | Why it is wrong there |
| --- | --- | --- |
| `anthropic/academy-guide` | 18 | Very broad description ("how do I", "teach me", "what can X do") |
| `egawilldoit/recover-work-context` | 15 | Matches almost any "what is the state of X" phrasing |
| `egawilldoit/what-did-i-get-done` | 10 | Competes directly with `recover-work-context` |
| `egawilldoit/blast-radius` | 7 | Broad "could this break" surface |

The single auto-selected exclusion is `reconcile-conflicting-truth` selecting
`get-pr-comments`, which is the §3 bug.

`anthropic/academy-guide` is the clearest offender: it appears in the top-3 of
18 of 79 windows across unrelated domains. It needs narrower trigger text in the
`anthropic/skills` source, and that is outside this repository.

## 5. Root cause of the top-1 / top-3 gap — missing triggers

14 intents rank the expected skill outside the 3-slot window. **5 of the 14
expect a `principle-*` skill**, and 4 more expect a skill with a closely-named
sibling (`fix-ci`/`loop-on-ci`, `verify-*`, `unslop`/`deslop`).

The reason is systematic: **20 of the 66 `egawilldoit` skills have a trigger set
that is entirely a rephrasing of their own name** — every declared trigger is a
contiguous slice of the skill's own name. Such a skill is effectively
undiscoverable by natural language, because no user says "test behavior not
implementation" when they mean "is this test actually testing anything?".

Verified against the registry (`manifest_json.routing.triggers`); the list and
the count are both checked mechanically:

| Skill | Declared triggers |
| --- | --- |
| `principle-test-behavior-not-implementation` | `test behavior not implementation` |
| `principle-type-system-discipline` | `type system discipline` |
| `principle-prove-it-works` | `prove it works` |
| `principle-boundary-discipline` | `boundary discipline` |
| `principle-minimize-reader-load` | `minimize reader load` |
| `principle-separate-before-serializing-shared-state` | `separate before serializing shared state` |
| `principle-outcome-oriented-execution` | `outcome oriented execution` |
| `principle-experience-first` | `experience first` |
| `principle-guard-the-context-window` | `guard the context window` |
| `principle-foundational-thinking` | `foundational thinking` |
| `principle-subtract-before-you-add` | `subtract before you add` |
| `principle-sequence-verifiable-units` | `sequence verifiable units`, `verifiable units` (2) |
| `principle-redesign-from-first-principles` | `first principles`, `redesign from first principles` (2) |
| `principle-attack-the-premise` | `attack the premise` |
| `principle-exhaust-the-design-space` | `exhaust the design space` |
| `principle-build-the-lever` | `build the lever` |
| `principle-laziness-protocol` | `laziness protocol` |
| `principle-model-the-domain` | `model the domain` |
| `principle-migrate-callers-then-delete-legacy-apis` | `migrate callers then delete legacy apis`, `delete legacy apis` (2) |
| `principle-encode-lessons-in-structure` | `encode lessons in structure` |

Intents whose expected skill does not appear in the 3-slot window at all:

| Intent | Expected |
| --- | --- |
| `technical-writing` | `egawilldoit/technical-writing` |
| `prove-really-deployed` | `egawilldoit/certify-production-target` |
| `idempotent-operations` | `egawilldoit/principle-make-operations-idempotent` |

An earlier draft of this document reported BM25 positions (ranks 59, 37, 31, 20)
for these. Those are offsets in a 114-row FTS result list, not ranks a human
ever sees, and quoting them as discovery quality was misleading.

Suggested fix: add user-voice triggers to each `principle-*/ega.yaml` in
`egawilldoit/skills`. These are illustrative starting points, to be validated by
re-running `pnpm eval:discovery` after re-vendoring — not a mechanical
substitution.

**Every candidate phrase below was checked against that skill's declared
`anti_triggers`, and none of them trips one.** This matters: `crash` and `retry`
are already anti-triggers of `principle-make-operations-idempotent`, and
`typescript` is already an anti-trigger of `principle-type-system-discipline`, so
an earlier draft's advice to add "crash safe" and "safe to retry" would have made
those two skills *less* routable.

| Skill | Candidate additional triggers (anti-trigger-safe) |
| --- | --- |
| `principle-test-behavior-not-implementation` | `is this test meaningful`, `do not test implementation details`, `testing through the public interface` |
| `principle-type-system-discipline` | `type design`, `design the types first`, `model the types`, `type-level design` |
| `principle-boundary-discipline` | `where should validation live`, `guard the edge`, `validate at the boundary` |
| `principle-separate-before-serializing-shared-state` | `two agents writing the same file`, `concurrent writers`, `conflicting writes` |
| `principle-minimize-reader-load` | `too many layers to trace`, `hard to follow this code`, `count the indirection` |
| `principle-outcome-oriented-execution` | `where does this effort stop`, `set a convergence point`, `how do I know this stage is done` |
| `principle-experience-first` | `what is best for the user`, `delight over convenience`, `product tradeoff` |
| `principle-subtract-before-you-add` | `remove before adding`, `delete the dead code first`, `take something out first` |
| `principle-foundational-thinking` | `what are the core types`, `scaffold before feature`, `what is the primitive here` |
| `principle-guard-the-context-window` | `running out of context`, `too much output to hold`, `chunk this up` |

`principle-make-operations-idempotent` is **not** in this table: it already
declares `idempotency`, `idempotent`, and `make operations idempotent`, so its low
score is not caused by missing triggers and should not be "fixed" by adding more.
Investigate it separately.

The mission's suggested phrase list for `adversarial-review`, `review-and-ship`,
`fix-ci`, `verify-this`, `recover-work-context`, `reconcile-project-truth`,
`mine-work-patterns`, and `compare-designs` is **not** applied blindly: several of
those skills already match correctly in this corpus (for example
`verify-this` is top-1 for `verify-one-claim`, `loop-on-ci` is top-1 for
`ci-until-green`, and `compare-designs` is top-1 for `compare-designs-plain`).
Adding triggers there is not evidence-justified by this corpus.

## 6. Anti-trigger gaps that pollute the candidate window

In every case below the **expected skill already ranks #1**, so execution routing
is not wrong and no automatic selection is at risk. The defect is that an
explicitly excluded neighbour still occupies a slot in the 3-candidate discovery
window, which is what a human is shown. The fix is anti-trigger text, so the
window shows only plausible alternatives.

| Intent (expected skill is #1) | Excluded neighbour also in window | Missing anti-trigger |
| --- | --- | --- |
| `single-ci-failure` (`fix-ci`) | `loop-on-ci` | "one known failing check" |
| `ci-until-green` (`loop-on-ci`) | `fix-ci` | "until all checks are green" |
| `verify-cli` (`verify-cli`) | `verify-ui` | "terminal/CLI behavior" |
| `smoke-tests` (`run-smoke-tests`) | `verify-ui` | "the existing e2e suite" |
| `commit-summary` (`what-did-i-get-done`) | `recover-work-context` | "summarize authored commits only" |
| `preflight-repository` | `recover-work-context` | "exact repository state" |
| `handoff-context` (`handoff`) | `recover-work-context` | "write a handoff document" |

The `fix-ci` / `loop-on-ci` pair is genuinely bidirectional and is the clearest
case: each is #1 for its own intent and each is #2 for the other's. Both need
anti-triggers to separate them.

## 7. `egawilldoit/find-skill` (Phase C) — not implementable here

The mission asks for an owned skill `egawilldoit/find-skill`. It does not exist in
this release, and the deployed `hub.yaml` declares `owned: []` — every namespace
is an adopted external source. Authoring a new owned skill means:

1. author `skills/find-skill/` in `egawilldoit/skills`;
2. add it to the source's declared roots;
3. re-vendor, rebuild the release, and refresh all digests;
4. update the expected-catalog assertions and catalog evidence docs.

`tests/discovery/personal-intents.json` contains one intent
(`ambiguous-skill-memory`) whose `expected_primary` is `egawilldoit/find-skill`,
flagged `pending_skill: true`. The harness excludes it from routing rates and
reports it separately, so the gap stays visible instead of being scored as a
routing failure or silently dropped.

Note that the catalog already surfaces the nearest existing analogue:
`mattpocock/ask-matt` ("Ask which skill or flow fits your situation"), grouped
under **Not sure which skill?** alongside `egawilldoit/deliver-software`.

## 8. Expected effect

Sections 3–6 are metadata-only changes in one external repository. Per mission
§11, they are the correct first-line fix: repair metadata rather than weaken
deterministic routing. After re-vendoring, re-run `pnpm eval:discovery` and
update `tests/discovery/baseline.json`. The two known-external misroutes in
`tests/discovery/discovery-evaluation.test.mjs`
(`KNOWN_EXTERNAL_AUTO_ROUTES`) must be updated in the same change, or the
regression guard will fail — which is intentional.