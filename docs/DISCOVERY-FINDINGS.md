# Discovery findings and corpus-repo handoff

Evidence for the discovery work in this branch, and the exact changes that
belong in the **separate** skill corpus repository rather than here.

Measured against release `sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77`
(114 skills: `anthropic` 14, `egawilldoit` 66, `mattpocock` 25, `vercel` 9).

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

## 2. Baseline discovery metrics

| Metric | Value | Target | Status |
| --- | --- | --- | --- |
| Intents evaluated | 81 | >= 50 | met |
| Wrong automatic selections | 2 | 0 | **not met** (§3) |
| Catastrophic must-not-select in top 3 | 24 | 0 | **not met** (§4) |
| Expected skill ranked #1 | 59/81 = 72.8% | >= 90% | **not met** (§5) |
| Expected skill in top 3 | 68/81 = 84.0% | >= 98% | **not met** (§5) |
| LOW-confidence results | 70/81 | — | informational |

Per expected namespace:

| Namespace | top-1 | top-3 |
| --- | --- | --- |
| `egawilldoit` | 51/71 | 58/71 |
| `anthropic` | 2/3 | 3/3 |
| `mattpocock` | 5/5 | 5/5 |
| `vercel` | 1/2 | 2/2 |

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

## 4. Catastrophic top-3 results — 24 intents

These surface a skill the intent explicitly excludes. The dominant cause is the
one in §5; the noisiest occupants across all 81 intents are:

| Skill | Times in a top-3 window | Why it is wrong there |
| --- | --- | --- |
| `egawilldoit/recover-work-context` | 18 | Matches almost any "what is the state of X" phrasing |
| `anthropic/academy-guide` | 17 | Very broad description ("how do I", "teach me", "what can X do") |
| `egawilldoit/what-did-i-get-done` | 13 | Competes directly with `recover-work-context` |
| `egawilldoit/work-retrospective` | 6 | Overlaps `mine-work-patterns` and `what-did-i-get-done` |

`anthropic/academy-guide` is the clearest offender: it appears in the top-3 of
17 intents across unrelated domains. It needs narrower trigger text in the
`anthropics/skills` source, and that is outside this repository.

## 5. Root cause of the top-1 / top-3 gap — missing triggers

13 intents rank the expected skill outside the top 3. **7 of the 13 expect a
`principle-*` skill.**

The reason is systematic: **20 of the 66 `egawilldoit` skills declare a single
trigger that is just their own name rephrased.** These skills are effectively
undiscoverable by natural language, because no user says "test behavior not
implementation" when they mean "is this test actually testing anything?".

| Skill | Only trigger |
| --- | --- |
| `principle-test-behavior-not-implementation` | `test behavior not implementation` |
| `principle-type-system-discipline` | `type system discipline` |
| `principle-boundary-discipline` | `boundary discipline` |
| `principle-minimize-reader-load` | `minimize reader load` |
| `principle-make-operations-idempotent` | `make operations idempotent` |
| `principle-separate-before-serializing-shared-state` | `separate before serializing shared state` |
| `principle-outcome-oriented-execution` | `outcome oriented execution` |
| `principle-experience-first` | `experience first` |
| `principle-guard-the-context-window` | `guard the context window` |
| `principle-foundational-thinking` | `foundational thinking` |
| `principle-subtract-before-you-add` | `subtract before you add` |
| `principle-sequence-verifiable-units` | `sequence verifiable units`, `verifiable units` |
| `principle-redesign-from-first-principles` | `first principles`, `redesign from first principles` |
| `principle-attack-the-premise` | `attack the premise` |
| `principle-exhaust-the-design-space` | `exhaust the design space` |
| `principle-build-the-lever` | `build the lever` |
| `principle-laziness-protocol` | `laziness protocol` |
| `principle-model-the-domain` | `model the domain` |
| `principle-migrate-callers-then-delete-legacy-apis` | `migrate callers then delete legacy apis`, `delete legacy apis` |
| `principle-encode-lessons-in-structure` | `encode lessons in structure` |

Worst individual outcomes, all from this cause:

| Intent | Expected | Rank |
| --- | --- | --- |
| `technical-writing` | `technical-writing` | 59 |
| `idempotent-operations` | `principle-make-operations-idempotent` | 37 |
| `prove-really-deployed` | `certify-production-target` | 31 |
| `deep-review-before-merge` | `adversarial-review` | 20 |

Suggested fix: add user-voice triggers to each `principle-*/ega.yaml` in
`egawilldoit/skills`. These are illustrative starting points, to be validated by
re-running `pnpm eval:discovery` after re-vendoring — not a mechanical
substitution:

- `principle-test-behavior-not-implementation`: `testing behavior not implementation`,
  `is this test meaningful`, `do not test implementation details`
- `principle-type-system-discipline`: `type design`, `design the types`,
  `model the types`, `type level design`
- `principle-boundary-discipline`: `where to validate`, `validation boundaries`,
  `error handling boundaries`
- `principle-make-operations-idempotent`: `idempotent`, `safe to retry`,
  `crash safe`, `run twice safely`
- `principle-separate-before-serializing-shared-state`: `two agents writing the same file`,
  `concurrent writers`, `concurrent mutation`
- `principle-experience-first`: `user delight over simplicity`, `product tradeoff`,
  `what is best for the user`
- `principle-subtract-before-you-add`: `remove before adding`, `delete dead code first`,
  `reduce before increasing`

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