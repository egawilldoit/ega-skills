# Routing / discovery — catalog-2026-10-06.1

All figures below were measured against the real `search` and `resolve` APIs over
the freshly built 116-skill Hub, and re-measured old-vs-new where a comparison is
meaningful. Nothing here is asserted from release notes.

## 1. Regression comparison, old Hub vs new Hub

19 shared tasks that exist in both catalogs were run through `resolve` and
`search` on the 114-skill parent Hub and the 116-skill Hub.

| measure | result |
|---|---|
| shared tasks compared | 19 |
| `resolve` selection changes | 0 |
| `search` top-5 changes attributable to this release | 3 |
| wrong-skill selections introduced | 1 (see §4) |
| correct selections lost | 0 |

The three search-order changes are all **additions** of the new skills into the
result list, never displacements: `implement-spec` enters the `implement-one` and
`to-tickets` result sets. No pre-existing skill lost rank.

## 2. New-skill discoverability

| intent | `search` rank | `resolve` selection | verdict |
|---|---|---|---|
| `implement spec` | 2 | not auto-selected | correct — `disable-model-invocation: true` (SPEC-001 §5.1.6.4) forbids automatic selection; discoverable via search/inspect/get_content |
| `pr body` | **1** | not selected (EGA `technical-writing` wins) | reachable; see §4 and §5 |
| `retro` | 1 (behind `egawilldoit/work-retrospective`) | not auto-selected | correct — user-invoked only; see §3 |
| `retrospective on working practices` | 3 | `egawilldoit/work-retrospective` | documented legitimate overlap |
| `parallelize independent tickets` | 3 | `egawilldoit/parallelize-work` | documented legitimate overlap |
| `make this PR easy to review` | not in top 10 | none | documented legitimate overlap |

### Why `implement-spec` and `retro` never auto-select

Both ship `disable-model-invocation: true` upstream. SPEC-001 §5.1.6 rule 4 is
frozen: *"When `true`, the skill is user-invoked only: automatic routing MUST
never select it (SPEC-004), while explicit user references, search/inspect
discovery, and exact content fetch remain available."* They were **not** given
`ega.yaml` triggers to defeat this, because doing so would contradict a frozen
rule. The brief's expectation that these intents "should not incorrectly reduce
to only per-ticket `implement`" is satisfied: `implement-spec` is present and
discoverable, and `implement` remains the correct owner of the per-ticket intent.

## 3. Collision adjudication

### `retro` vs `egawilldoit/work-retrospective` — legitimate, both retained

They are genuinely different owners:

- `mattpocock/retro` — retrospective on a **coding session**, proposing changes to
  the **agent's environment** (navigation pointers, automated checks, coding
  standards, steering files, tool economy, information access). User-invoked.
- `egawilldoit/work-retrospective` — model-invocable, auto-selects on retrospective
  phrasing.

Because `retro` is user-invoked, the two do not fight over automatic selection at
all. No metadata change warranted.

### `pr` vs `egawilldoit/make-pr-easy-to-review` — legitimate, both retained

`pr` shapes **the PR body** (summary visual, before/after evidence, merge-danger
call, blast radius). `make-pr-easy-to-review` is about **preparing a branch** to
be reviewed. Distinct owners; no metadata change warranted.

### `implement-spec` vs `egawilldoit/parallelize-work` — legitimate, both retained

`implement-spec` owns whole-spec orchestration (task graph, worktrees, integration
branch) and is user-invoked. `parallelize-work` owns the general
parallelize-the-work intent and is model-invocable. No conflict.

## 4. PROVEN PLATFORM DEFECT — `pr` substring false-positive (**RELEASE BLOCKER**)

### The defect

`packages/router/src/tiers.ts` evaluates the `NAME_DESCRIPTION` evidence category
with a raw **substring** test on the normalized task string:

```ts
const names = [candidate.portableName, ...candidate.aliases];
for (const name of names) {
  const phrase = normalizeIdentifierPhrase(name);
  if (phrase.length > 0 && normalizedTask.includes(phrase)) {
    evidenceValue(evidence, "NAME_DESCRIPTION", name);
    break;
  }
}
```

`mattpocock/pr` is the first skill in catalog history with a **2-character**
portable name (the previous minimum was 3: `tdd`). `normalizedTask.includes("pr")`
matches `pr` *inside* unrelated English words.

Measured on a 20-task unrelated-intent probe, old Hub vs new Hub:

| measure | result |
|---|---|
| tasks where `mattpocock/pr` is spuriously auto-selected | **12 / 20** |
| correct selections it displaced | **0** |
| correct abstentions it converted into wrong confident answers | **12** |
| `pr` auto-selecting on its own intended intent | **0 / 2** |

Representative false positives, each with the offending substring:

| task | offending substring |
|---|---|
| Walk the codebase and **propose** where to deepen modules. | `pr` in *propose* |
| This **project** needs a **proper** design review. | `pr` in *project*/*proper* |
| Set up a **preview** deployment for the app. | `pr` in *preview* |
| The **approval** flow drops records under load. | `pr` in *approval* |
| **Provide** context on why the **priority** order changed. | `pr` in *provide*/*priority* |
| **Prepare** the **project** plan for the next sprint. | `pr` in *prepare* |
| **Print** the release report. | `pr` in *print* |
| **Process** the incoming webhook payload. | `pr` in *process* |
| **Profile** the hot loop and cut allocations. | `pr` in *profile* |
| **Prove** the fix works with a regression test. | `pr` in *prove* |
| Design a **prompt** caching strategy. | `pr` in *prompt* |

The damage pattern matters: 21 of 49 common English words contain `pr`, so the
false-positive surface is unbounded. Because `NAME_DESCRIPTION` is a *strong*
category (SPEC-004 §5.1.10), a bare substring hit is enough to promote the
candidate to **tier B** and win a MEDIUM-confidence automatic selection over
everything else.

### Why this cannot be fixed inside a catalog release

A term-boundary fix was prototyped and **is correct on every test case**:

```
pr        vs "propose"  -> false     (want false)  PASS
pr        vs "pr body"  -> true      (want true)   PASS
react native vs "react native" -> true             PASS
c++       vs "c++ here" -> true                    PASS
c#        vs "this is c#"-> true                    PASS
```

But it cannot be shipped here, for two independent reasons:

1. **It violates a frozen contract.** SPEC-004 §5.1.11 rule 2 requires the
   `DOMAIN`/`NAME_DESCRIPTION` phrase to be matched with *identifier-phrase*
   normalization, which "**PRESERVE[s] `+` and `#` as significant identifier
   characters**", and explicitly states that `c++` does NOT collapse to `c` and
   `c#` does NOT collapse to `c`. Term-level matching extracts letters/digits
   only, so `c++` → `["c"]` and `c#` → `["c"]`, silently violating that clause.
   The prototype's boundary check avoids that, but the change still requires an
   amendment to a FROZEN contract plus its tests, i.e. a software release.

2. **No catalog-side metadata can express it.** The only per-skill lever is
   `anti_triggers`, which are themselves contiguous **term** sequences. Any
   anti-trigger that suppresses `propose` also suppresses the legitimate
   `pr` skill on genuine PR tasks (verified: anti-trigger `approve` blocks both
   *"Approve the PR and merge it"* and *"the approval flow drops records"*). The
   false-positive word class is unbounded, so no finite anti-trigger list is
   sound.

The experimental router edit was **reverted**. `git status` in the release
worktree shows no `packages/router` diff. Per the brief, router semantics were
not changed to make the catalog fit.

### Recommended follow-up (separate software release)

Introduce a term-boundary requirement for single-token `NAME_DESCRIPTION`
matching that still preserves `+`/`#` as significant, i.e. require the match to be
delimited by non-alphanumeric boundaries **unless** the identifier itself contains
`+` or `#`. Amend SPEC-004 §5.1.11 rule 2 and its tests accordingly, and ship as
its own version. Until then, no catalog should adopt a 2-character portable
skill name.

## 5. Recorded limitation — `search "pull request"` does not reach `mattpocock/pr`

`mattpocock/pr`'s description is the terse upstream text *"Use when writing a PR
body."* Search is deterministic lexical FTS (SPEC-003 §5.1.5). The query
`pull request` shares **no** token with that description, so `pr` is not returned
for it; the query `pr body` returns it at rank 1.

This is **not** a regression introduced by this release — `pr` is new, and its
description is upstream's own text. It is recorded rather than "fixed" because
widening `pr`'s description to win a lexical match would be exactly the
"modifying Matt's source to hit a target" behaviour the brief forbids.

## 6. Verdict

- Catalog **content** correctness: PASS.
- Unrelated-namespace routing: PASS (0 selection changes, 0 losses).
- New-skill discoverability: PASS.
- `pr` automatic selection: **FAIL — proven platform defect, release blocker.**