# Discovery findings and corpus-repo handoff

Evidence for the discovery work in this branch, and the exact changes that
belong in the **separate** skill corpus repository rather than here.

Current evaluation targets the approved 126-skill I1 release
`sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`.
The original 117-skill summary is preserved verbatim in
`tests/discovery/baseline-117.json`; its reproduced full 82-prompt report is in
`tests/discovery/baseline-117-evaluation.json`. Tests compare every automatic
selection and all 117 original version identities. The 22 existing incorrect
automatic selections remain baseline failures. Top-1 remains 41/81 and top-3
improves from 70/81 to 71/81. The ten changed suggestion rankings and nine new
candidate lists are reviewed individually in
[the issue 168 routing review](evidence/ISSUE-168-ROUTING-REVIEW.md).

Reproduce with:

```bash
pnpm eval:discovery
```

## 1. Why routing metadata could not be fixed in this repository

The skill corpus is **not vendored in this repo**. There are zero `ega.yaml`
files in-tree. The 67 `egawilldoit` skills live in
`github.com/egawilldoit/skills`, pinned at commit `8f264fc` and adopted as an
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
them**, and that the generated summary matches the entire recorded baseline,
so the handoff cannot silently drift.

## 2. Baseline discovery metrics

The summary below is generated from the full committed baseline. Regenerate it
with `pnpm eval:discovery --findings`; the evaluator exits 1 while the recorded
execution-safety failures remain. This is truthful baseline evidence, not a
passing routing-quality certificate.

### What the window actually is

The discovery ranking is **the resolver's own window only**: `selected`, then
`candidates`, capped at 3. Raw `search` hits are deliberately NOT appended to it.
An earlier revision of this harness appended them, and that inflated top-3 from
80.2% to 84.0% while adding zero top-1 hits — FTS returns a median of 105 of 114
skills per task, so concatenating it pads the window with rows that carry no
ranking signal. Search reachability is therefore reported on its own.

<!-- discovery-summary:start -->
Release: `sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266`; catalog: 126 skills; corpus: `personal-intents-v1`.

| Metric | Value | Target | Status |
| --- | --- | --- | --- |
| Intents evaluated | 81 | >= 50 | met |
| Automatic selection attempts | 33/81 | — | informational |
| Wrong automatic selections | 22 across 33 attempts (66.7% of attempts) | 0 | **not met** |
| Excluded skill **auto-selected** | 0 | 0 | met |
| Excluded skill in a suggestion slot only | 15 | — | presentation issue, not safety |
| Expected skill ranked #1 | 41/81 = 50.6% | >= 90% | **not met** |
| Expected skill in top 3 (resolver window) | 71/81 = 87.7% | >= 98% | **not met** |
| Expected skill in top 3 of raw `search` | 72/81 = 88.9% | — | fallback path only |
| LOW-confidence results | 48/81 | — | informational |

Wrong-selection rate uses the 33 attempted automatic selections as its denominator, not all 81 intents.
Excluded skills appear in 15 windows: 0 auto-selected and 15 suggestion-only.
Pending skills: 1 intent(s), excluded from the measured rates above.
<!-- discovery-summary:end -->

The frozen V1 semantics and all 82 automatic selections are unchanged. The I1
policy governs only the nine additions; every number above comes
from calling `resolveSkills` exactly as SPEC-004 freezes it. This reporting repair
does not change routing. The current baseline also includes the accepted
`mattpocock/pr` substring-matching defect documented in
[`catalog-2026-10-06.1/routing.md`](evidence/catalog/catalog-2026-10-06.1/routing.md)
§4 and §8; metadata examples below do not explain away that platform defect.

Scope of the measurement: intents are evaluated against a **bare temporary
project**, so these figures reflect default routing policy only. They do not
cover project-configured namespace allow/deny or lock-scoped routing.

## 3. Wrong automatic selections (execution safety) — selected examples

The two examples below are historical: the approved upstream metadata updates
resolve these two wrong automatic selections in this candidate. The new full
baseline still records 22 other wrong automatic selections, including the
accepted `mattpocock/pr` substring family. These examples do not explain all
remaining defects.

### 3.1 `reconcile-conflicting-truth`

> "The agent report, GitHub, CI, and deployment disagree about what shipped."

Historical result: `MEDIUM`, automatically selected `egawilldoit/get-pr-comments`.

Cause: `get-pr-comments/ega.yaml` declares `domains: [github]`. The literal word
"GitHub" in the task is therefore strong evidence, while
`reconcile-project-truth` has `domains: []` and only five narrow intent triggers.

The current source removes the over-broad `github` domain. The exact prompt
now selects no skill automatically, avoiding the incorrect PR-comment action.

Its existing triggers already carry the intent (`pr comments`,
`pull request comments`, `review comments`, `reviewer feedback`,
`what did reviewers say`), so no new trigger is needed to keep it discoverable.

### 3.2 `react-performance`

> "Our React app feels sluggish. Apply the performance and architecture guidance
> from the Vercel team."

Historical result: `MEDIUM`, automatically selected `egawilldoit/design-architecture`.

Cause: `design-architecture/ega.yaml` declares `domains: [architecture]`, so
"architecture guidance" is strong evidence. Meanwhile
`vercel/react-best-practices` declares **no** domains, platforms, or frameworks
and carries only symptom-shaped triggers (`slow page`, `render waterfall`,
`unnecessary rerenders`), so it cannot match "React app feels sluggish".

The current source retains `domains: [architecture]` for genuine architecture
requests and adds a narrow Vercel anti-trigger. This avoids this wrong selection
without breaking the architecture-proposal prompt; both have release regression checks.

These examples explain one metadata defect class. They do not establish a
complete root-cause analysis for the current baseline.

## 4. Excluded skills surfacing in the window

The generated summary above separates automatic exclusions (execution safety)
from suggestion-only exclusions (presentation). This candidate has zero automatic
exclusions. Both previous cases are resolved: `reconcile-conflicting-truth` no
longer selects `get-pr-comments`, and `release-certification-console` selects
`certify-release` through the approved narrow metadata triggers.

The original investigation also identified these candidate-window neighbours:

| Skill | Investigation finding |
| --- | --- |
| `anthropic/academy-guide` | Very broad description ("how do I", "teach me", "what can X do") |
| `egawilldoit/recover-work-context` | Matches broad "what is the state of X" phrasing |
| `egawilldoit/what-did-i-get-done` | Competes with `recover-work-context` |
| `egawilldoit/blast-radius` | Broad "could this break" surface |

These are qualitative handoff examples, not an exhaustive current frequency
ranking. Re-evaluate individual rows before applying upstream metadata changes;
this issue changes reporting only.

## 5. Root cause of the top-1 / top-3 gap — missing triggers

The original investigation found missing-trigger and closely-named-sibling
patterns (`fix-ci`/`loop-on-ci`, `verify-*`, `unslop`/`deslop`). The examples
below are retained as metadata investigation leads; the generated summary in
§2 is authoritative for current full-corpus rates.

The reason is systematic: **20 of the 67 `egawilldoit` skills have a trigger set
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

Selected investigation examples of intents whose expected skill did not appear
in the 3-slot window (not an exhaustive current list):

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

The original investigation proposed the following anti-trigger changes for
excluded neighbours in the discovery window. These are historical candidate
metadata fixes, not claims that every row currently ranks the expected skill
first or has safe automatic selection. The current automatic exclusions are
listed in §4. Re-evaluate each row on the intended candidate
catalog before accepting a metadata fix.

| Intent (original investigation) | Excluded neighbour also in window | Candidate anti-trigger |
| --- | --- | --- |
| `single-ci-failure` (`fix-ci`) | `loop-on-ci` | "one known failing check" |
| `ci-until-green` (`loop-on-ci`) | `fix-ci` | "until all checks are green" |
| `verify-cli` (`verify-cli`) | `verify-ui` | "terminal/CLI behavior" |
| `smoke-tests` (`run-smoke-tests`) | `verify-ui` | "the existing e2e suite" |
| `commit-summary` (`what-did-i-get-done`) | `recover-work-context` | "summarize authored commits only" |
| `preflight-repository` | `recover-work-context` | "exact repository state" |
| `handoff-context` (`handoff`) | `recover-work-context` | "write a handoff document" |

The original `fix-ci` / `loop-on-ci` investigation motivated bidirectional
anti-trigger candidates. Their current positions must be checked against a
fresh report before changing either source.

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

Sections 3–6 contain metadata investigation leads, not implemented repairs.
Owned metadata changes, the accepted platform substring defect, catalog
adoption, and catalog publication are separate work. No routing quality fix or
new catalog release is claimed here.

After an authorized catalog adoption, re-run `pnpm eval:discovery`, update
`tests/discovery/baseline.json`, and regenerate the findings summary with
`pnpm eval:discovery --findings`. Reconcile the complete
`KNOWN_EXTERNAL_AUTO_ROUTES` set in
`tests/discovery/discovery-evaluation.test.mjs` with observed results; do not
remove failures or weaken thresholds to make the report pass.
