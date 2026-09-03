# SPEC-004 — Router and Resolution Contract

**Status:** FROZEN (V1 normative behavioral contract).
**Incorporates:** AMEND-01 (EGA-606: golden schema/contract references),
AMEND-02 (EGA-607: exact L1/L2 content + token accounting basis),
AMEND-03 (EGA-608: FTS exactness basis, current/locked version visibility),
AMEND-04 (EGA-609: request validation, match predicates, fingerprint algorithm,
public output types, explicit accounting, stopping rule, budget precedence,
confidence, reason emission, collection semantics, implementation version),
AMEND-05 (EGA-610: policy semantics basis, effective-budget precedence).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority;
Linear amendment tickets (EGA-605..EGA-611) are provenance/history only.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

No LLM routing, no embeddings, no stemming, no fuzzy matching, no semantic similarity,
no learned ranking, no hidden numeric thresholds or scores exist in V1.
Section numbering and titles are preserved from the frozen bundle.

---

## §5.1.1 Resolve pipeline order (exact)

Every resolve call executes these stages in order:

```text
1. validate request (§5.1.2)
2. resolve effective projectPath (§5.1.8; SPEC-005 discovery)
3. load + validate effective config and adjacent lock (SPEC-005)
4. resolve explicit references + explicit policy/lock/validity (§5.1.3–§5.1.5)
5. compute project fingerprint (§5.1.8–§5.1.9)
6. load eligible L0 candidate set (current-only unlocked / exact-lock locked)
7. apply automatic hard filters (§5.1.15)
8. assign tiers + evidence + deterministic tie-break (§5.1.10–§5.1.14)
9. redundancy suppression (§5.1.16)
10. automatic content-level + token-budget composition with stopping rule (§5.1.6–§5.1.7)
11. confidence + LOW normalization (§5.1.17)
12. explanation (reasons/warnings, §5.1.18) and bounded collections (§5.1.19)
```

## §5.1.2 ResolveRequest validation (AMEND-04)

```ts
interface ResolveRequest {
  task: string;
  projectPath?: string;          // defaults per §5.1.8
  explicitSkills?: string[];     // raw references, max 10
  budget?: {
    maxSkills?: number;          // integer 1–3
    maxTokens?: number;          // integer 1–1,000,000
  };
}
```

1. `task`: trim for validation; MUST be non-empty; max 16,384 Unicode code points.
2. `budget.maxSkills`: when present MUST be an integer in `1–3`.
3. `budget.maxTokens`: when present MUST be an integer in `1–1,000,000`.
4. `explicitSkills`: at most 10 raw references; each MUST be non-empty after trim.
   References resolve (SPEC-001 §5.1.12 order), THEN deduplicate to canonical IDs
   preserving first occurrence.
5. Any violation fails the call with `E_RESOLVE_REQUEST_INVALID` (internal/CLI code;
   the MCP adapter maps malformed external input to `E_MCP_INPUT_INVALID`, SPEC-006).
6. Effective budgets follow §5.1.7 precedence; request overrides never bypass project
   deny/lock policy — they only change per-call automatic composition limits within
   the frozen ranges.

## §5.1.3 Explicit resolution order

Explicit references resolve BEFORE automatic routing, in SPEC-001 §5.1.12 order
(exact canonical ID → exact global alias → unique bare portable name), then
canonical-dedupe preserving first occurrence (§5.1.2).

## §5.1.4 Explicit validity (bypass ranking, never validity)

1. Successfully resolved explicit skills BYPASS ranking but NEVER bypass
   policy/lock/version/schema validity.
2. A valid explicit canonical skill is REMOVED from the automatic candidate pool for
   that call; it cannot also appear in `selected` / `candidates` / automatic `rejected`.
3. Compatibility mismatch (platform/anti-trigger/size) on an otherwise policy-valid
   explicit skill becomes a WARNING, never a hidden hard filter (§5.1.18).
4. Explicit reference failures abort the call deterministically:
   - unknown exact ID/alias/bare name → `E_SKILL_NOT_FOUND`;
   - ambiguous bare portable name → `E_SKILL_REFERENCE_AMBIGUOUS`.
5. Once a reference resolves to a canonical skill, policy/lock/validity rejection is
   represented in `rejected` with its negative reason — it does NOT abort unrelated
   automatic routing.

## §5.1.5 Explicit budget accounting (separate budgets)

1. `maxTokens` is the AUTOMATIC budget. Valid explicit skills are NEVER dropped
   solely because the automatic budget is exceeded.
2. `explicitSelectedTokens` uses the recommended default content level for accounting
   ONLY (AMEND-02 content + AMEND-04 rule): AUTHORED L1 when present, otherwise L2.
   Explicit results are NOT auto-loaded; callers may later request either available
   level through `get_content` (SPEC-006).
3. When explicit recommended tokens exceed effective `maxTokens`, report
   `budgetStatus=EXPLICIT_OVER_BUDGET` without dropping references. Explicit
   over-budget status does NOT consume or shrink the separate automatic budget.
4. Explicit and automatic token counters (`explicitSelectedTokens` /
   `automaticSelectedTokens`) remain DISTINCT.

## §5.1.6 Automatic content-level and token-budget composition

1. Automatic composition uses authored L1 when present, otherwise L2 (exact canonical
   texts per SPEC-002 §5.1.16). All counts use `ega-o200k-v1`.
2. NORMAL or LARGE L2 may auto-select ONLY if fitting the remaining `maxTokens`;
   a relevant too-large LARGE remains a candidate with negative reason `TOKEN_BUDGET`.
3. `OVERSIZED` L2 NEVER auto-selects in V1 — even under a 20,000-token budget — and
   remains a candidate with negative reason `CONTENT_OVERSIZED`.
4. NO silent truncation exists. A missing requested level is represented with
   `CONTENT_MISSING`, never with substitute content.
5. Automatic selected token total NEVER exceeds `maxTokens`; automatic selected count
   NEVER exceeds effective `maxSkills` (max 3).
6. Frozen edges (TEST-001): 4,900-token L2 fits the default 5,000 budget when otherwise
   selected; 9,000-token LARGE stays candidate under 5K (`TOKEN_BUDGET`) but may select
   under 10K; 5,100-token LARGE edge (missing L1) may select under a custom 10K budget;
   13,000-token OVERSIZED never selects even under 20K.

## §5.1.7 Effective budget precedence (AMEND-04 + AMEND-05)

1. Project `routing.max_skills` / `routing.max_tokens` are DEFAULTS, not security
   ceilings in V1.
2. Effective per-call values:

```text
maxSkills = ResolveRequest override
            else selected ProjectConfigV1 routing.max_skills
            else built-in 3

maxTokens = ResolveRequest override
            else selected ProjectConfigV1 routing.max_tokens
            else built-in 5000
```

3. Request overrides MUST still satisfy §5.1.2 ranges.
4. `ResolutionResult.maxSkills` / `maxTokens` report the EFFECTIVE values.

## §5.1.8 Project fingerprint detectors

1. Fingerprint evidence is collected from manifests/configs only — no full
   source-code crawl, no semantic analysis, no LLM inference.
2. Supported evidence sources: `package.json`/lockfiles/`tsconfig`, Next/Vite/Angular/
   Expo markers, Maven/Gradle, Python metadata, Cargo, workspace markers.
3. Every evidence record MUST identify the exact file/property/path that caused
   detection (see `FingerprintEvidence.source`, §5.2).
4. Absence of evidence is represented WITHOUT inventing platform mismatch
   (missing evidence is neutral, §5.1.15).

## §5.1.9 Nearest-package algorithm and monorepo isolation (AMEND-04)

1. Nearest package/module = nearest ancestor of the real `projectPath` containing a
   recognized manifest:
   - Node/TS: `package.json`;
   - Java: `pom.xml` or `build.gradle` / `build.gradle.kts`;
   - Python: `pyproject.toml`, `setup.py`, or `requirements*.txt`;
   - Rust: `Cargo.toml`.
2. At the same directory, COMBINE recognized evidence rather than choosing
   nondeterministically (same-directory polyglot manifests merge).
3. Node framework/platform evidence (exact, exhaustive for V1):
   - `react`: `react` dependency;
   - `nextjs`: `next` dependency or `next.config.*`;
   - `vite`: `vite` dependency or `vite.config.*`;
   - `angular`: `@angular/core` dependency or applicable `angular.json`;
   - `expo`: `expo` dependency or `app.json` / `app.config.*`;
   - `react-native`: `react-native` dependency;
   - mobile platform: Expo/React Native evidence, or package-local `android/`/`ios/`;
   - web platform: Next/Vite/Angular web evidence when NOT contradicted by
     package-local mobile evidence.
4. Non-Node manifests contribute LANGUAGE evidence only in V1: `pom.xml`/Gradle →
   `java`; Python manifest → `python`; `Cargo.toml` → `rust`. Do NOT guess
   Spring/Django/FastAPI/etc. from arbitrary source text.
5. Workspace evidence may come from `pnpm-workspace.yaml`,
   `package.json#workspaces`, `lerna.json`, `nx.json`, or Cargo `[workspace]`.
   Workspace markers NEVER override nearest-package identity; the workspace root
   contributes workspace/tooling evidence only.
6. If routing starts at a workspace root with no deterministic nearest application
   package, set `workspaceAmbiguous=true` (do NOT merge sibling identities into one
   confident app fingerprint). Package/root resolution is deterministic under
   symlinked real project paths (realpath normalization, SPEC-005).

## §5.1.10 Routing tiers

1. Tier E is EXPLICIT ONLY (successfully resolved explicit skills, §5.1.4).
2. Automatic tiers:
   - **Tier A** — strong project compatibility AND strong task relevance;
   - **Tier B** — strong task relevance WITHOUT enough project evidence;
   - **Tier C** — lexical-only relevance. Tier C is CANDIDATE-ONLY and can NEVER
     become automatic selected content, regardless of BM25 rank.
3. Only Tier A/B candidates are eligible for provisional automatic selection.
4. Project `skills.prefer` NEVER creates relevance by itself; it is only a tie-break
   applied after a candidate is relevant and eligible (SPEC-005 precedence).

## §5.1.11 Deterministic task matching (AMEND-04)

1. Task lexical terms use the SAME Unicode letter/number extraction + lowercase
   normalization frozen for V1 search (SPEC-003 §5.1.5):
   `/[\p{L}\p{N}]+/gu` + locale-independent `toLowerCase()`.
2. Strong task evidence (no embeddings, stemming, fuzzy matching, or hidden thresholds):
   - `TASK_TRIGGER`: ALL lexical terms of a normalized trigger occur CONTIGUOUSLY in
     the normalized task term sequence.
   - `DOMAIN`: identifier-phrase normalization, NOT the generic FTS extractor:
     lowercase deterministically; map `-`, `_`, `.` to a single separator; collapse
     separator/whitespace runs; PRESERVE `+` and `#` as significant identifier
     characters; then require the normalized domain phrase contiguously in the
     equivalently normalized task. Thus `react-native` may match `react native`,
     while `c++` does NOT collapse to `c` and `c#` does NOT collapse to `c`.
   - `NAME_DESCRIPTION`: the same identifier-phrase normalization applied to the
     portable name or alias, requiring an exact contiguous phrase in the normalized
     task. Description-only FTS hits are LEXICAL, never strong.
3. Strong anti-trigger: the normalized anti-trigger lexical sequence occurs
   contiguously in task terms (§5.1.15 rejection).

## §5.1.12 Deterministic project compatibility (AMEND-04)

1. Exact canonical framework intersection → `FRAMEWORK_MATCH` evidence.
2. Exact canonical platform intersection → `PLATFORM_MATCH` evidence.
3. Strong platform mismatch exists ONLY when ALL hold: the project has explicit
   platform evidence, the skill declares at least one platform, and the intersection
   is empty. Missing project platform/framework evidence is NEUTRAL, never mismatch.
4. Strong project compatibility = at least one exact framework or platform match
   AFTER hard-mismatch filtering.

## §5.1.13 Evidence categories (frozen set)

```ts
type EvidenceCategory =
  | "FRAMEWORK" | "PLATFORM" | "TASK_TRIGGER" | "DOMAIN"
  | "NAME_DESCRIPTION" | "PROJECT_PREFERENCE" | "LEXICAL";
```

Strong evidence categories for confidence/composition are exactly
`FRAMEWORK, PLATFORM, TASK_TRIGGER, DOMAIN, NAME_DESCRIPTION`.
`PROJECT_PREFERENCE` and `LEXICAL` are NEVER strong.

## §5.1.14 Deterministic tie-break (ordered)

Within a tier, order candidates by:

```text
1. project skills.prefer (eligible + relevant only)
2. independent evidence count (distinct strong evidence values)
3. relative FTS rank (relative order only; never absolute BM25)
4. lower recommended-content token count
5. canonical skill ID (UTF-16 ascending)
6. version hash (ascending)
```

`TOKEN_EFFICIENT` is emitted ONLY when rule 4 actually resolves a same-tier tie.
Exact ties (e.g. identical lexical tie fixtures) resolve deterministically through
rules 5–6 (TEST-001 G041).

## §5.1.15 Automatic hard filters

An automatic candidate is rejected with its deterministic negative reason when:

| Condition | Negative reason |
| --------- | --------------- |
| namespace in `namespaces.deny`, or non-empty `namespaces.allow` lacking it | `NAMESPACE_DENIED` |
| canonical ID in `skills.deny` | `SKILL_DENIED` |
| active lock excludes the version | `VERSION_NOT_LOCKED` |
| locked/current version missing or invalid locally | `VERSION_MISSING` / `INVALID_SKILL` |
| strong platform mismatch (§5.1.12) | `PLATFORM_MISMATCH` |
| strong anti-trigger match (§5.1.11) | `ANTI_TRIGGER_MATCH` |
| budget/size composition deferral | `TOKEN_BUDGET` / `CONTENT_MISSING` / `CONTENT_OVERSIZED` |
| redundancy suppression (§5.1.16) | `REDUNDANT_HIGHER_RANKED` |
| workspace-ambiguity explanatory retention (§5.1.17) | `WORKSPACE_AMBIGUOUS` |

Absence of platform evidence alone is NEVER a mismatch. Hard filters emit ONLY the
frozen negative reason codes — no speculative reasons.

## §5.1.16 Redundancy suppression and complementary composition

1. Suppress candidate B behind candidate A when ALL hold: A is the same or a stronger
   tier, A has the same relevant platform/framework coverage, B adds NO unique strong
   `TASK_TRIGGER` or `DOMAIN` evidence value, and A wins the §5.1.14 tie-break.
2. Suppressed candidates record `REDUNDANT_HIGHER_RANKED` and belong to `rejected`,
   NOT `candidates`.
3. Distinct workflow/domain evidence MAY compose (e.g. `systematic-debugging` +
   `react-frontend` both remain when evidence is distinct). No skill is permanently
   labeled a duplicate; no similarity state is stored; evaluation is inside the
   current resolution candidate set only.
4. The unique-strong-evidence notion here is ALSO what may justify the exceptional
   third automatic skill (§5.1.20 rule 4).

## §5.1.17 Confidence and LOW normalization (AMEND-04, exhaustive)

1. An **equivalent competing Tier A** exists when another non-redundant Tier A
   candidate has the SAME set of matched strong task-evidence values
   (`TASK_TRIGGER`, `DOMAIN`, `NAME_DESCRIPTION`) as the top candidate.
   Complementary Tier A skills with DIFFERENT strong task-evidence values are NOT
   equivalent competitors merely because both are selected.
2. Confidence is computed AFTER provisional composition and is EXHAUSTIVE:
   - **HIGH**: top automatic candidate is Tier A, has `>= 2` distinct strong evidence
     categories, has NO equivalent competing Tier A, and workspace is NOT ambiguous.
   - **MEDIUM**: a useful Tier A that misses a HIGH condition, OR any Tier B
     candidate with at least one strong task-evidence category (`TASK_TRIGGER`,
     `DOMAIN`, or `NAME_DESCRIPTION`). Additional evidence affects ranking and
     explanation but is not required merely to avoid LOW.
   - **LOW**: no Tier A/B automatic candidate with strong task evidence, OR the
     workspace is ambiguous, OR there is no useful candidate.
3. There is NO free-form "conflicting evidence" heuristic in V1; ambiguity is
   represented ONLY by the deterministic fingerprint/workspace rules.
4. If final confidence is LOW: publish `selected=[]`, set
   `automaticSelectedTokens=0`, and keep relevant provisional items in `candidates`
   with their reasons. LOW NEVER leaks an automatic selection.
5. When LOW is caused by `workspaceAmbiguous=true`, every relevant
   provisional/candidate item retained because of that ambiguity ALSO carries the
   negative reason `WORKSPACE_AMBIGUOUS`. This reason is explanatory, not a
   hard-filter rejection.

## §5.1.18 Reason codes and warnings (exact emission)

Positive reasons (10, exhaustive — any new public code requires a spec amendment):

```text
EXPLICIT_USER, PROJECT_PREFERENCE, FRAMEWORK_MATCH, PLATFORM_MATCH,
TASK_TRIGGER_MATCH, DOMAIN_MATCH, DESCRIPTION_MATCH, LEXICAL_MATCH,
TOKEN_EFFICIENT, LOCKED_VERSION
```

Emission mapping (deterministic, one mapping):
- explicit result → `EXPLICIT_USER`;
- FRAMEWORK evidence → `FRAMEWORK_MATCH`; PLATFORM evidence → `PLATFORM_MATCH`;
- TASK_TRIGGER evidence → `TASK_TRIGGER_MATCH`; DOMAIN evidence → `DOMAIN_MATCH`;
- exact portable-name/alias phrase match → `DESCRIPTION_MATCH` (legacy public reason
  name; in V1 this strong category is produced ONLY by exact name/alias phrase
  matching — description-only relevance stays `LEXICAL_MATCH`);
- lexical FTS relevance → `LEXICAL_MATCH`;
- applicable project preference on a relevant candidate → `PROJECT_PREFERENCE`;
- active locked-version use → `LOCKED_VERSION`;
- `TOKEN_EFFICIENT` only per §5.1.14 rule 4.

Negative reasons (12, exhaustive): `NAMESPACE_DENIED`, `SKILL_DENIED`,
`VERSION_NOT_LOCKED`, `VERSION_MISSING`, `INVALID_SKILL`, `PLATFORM_MISMATCH`,
`ANTI_TRIGGER_MATCH`, `REDUNDANT_HIGHER_RANKED`, `TOKEN_BUDGET`, `CONTENT_MISSING`,
`CONTENT_OVERSIZED`, `WORKSPACE_AMBIGUOUS` (see §5.1.15 table).

Compatibility warnings (3, exhaustive):

```ts
type CompatibilityWarning =
  | "EXPLICIT_PLATFORM_MISMATCH"
  | "EXPLICIT_ANTI_TRIGGER_MATCH"
  | "EXPLICIT_CONTENT_OVERSIZED";
```

Warnings attach to otherwise policy-valid explicit skills; they never silently reject.

## §5.1.19 Resolution collection semantics and bounded diagnostics

1. The public collections are semantically distinct and non-duplicative:
   - `explicit`: ONLY successfully resolved + policy/lock-valid explicit skills, in
     first-occurrence user order after canonical dedupe;
   - `selected`: automatic recommendations ONLY, router-rank order, max 3;
   - `candidates`: relevant automatic skills NOT selected (Tier C, budget/LARGE/
     OVERSIZED-deferred, or relevant items beyond the composition limit),
     router-rank order, hard max 3 in V1;
   - `rejected`: diagnostic, NOT an exhaustive catalog dump — every resolved explicit
     skill blocked by policy/lock/validity FIRST, followed by AT MOST 3 relevant
     automatic rejects. Redundancy-suppressed automatic skills belong here.
2. Automatic rejected diagnostics MUST NEVER include unrelated zero-relevance catalog
   entries. The diagnostic shortlist is chosen/ordered deterministically by:
   1. strong task evidence present before rejection;
   2. number of distinct strong task-evidence categories;
   3. relative FTS rank when available;
   4. canonical skill ID;
   5. version hash.
3. The `< 500` EGA-token value for normal resolve metadata is a normal/reference
   TARGET (100-skill routing case), not a hard guarantee for a caller that explicitly
   supplies many skills. No L1/L2 bodies ever appear in resolve metadata.
4. No-match routing is a NORMAL `LOW` result, never a runtime error.

## §5.1.20 Automatic stopping rule (1–2 normal, hard max 3)

After hard filters, tier/tie-break, and redundancy suppression:

1. Only Tier A/B candidates are eligible for provisional automatic selection; Tier C
   remains candidate-only.
2. Select the highest-ranked fitting Tier A/B candidate if `maxSkills >= 1`.
3. Select a second fitting non-redundant Tier A/B candidate when available and
   `maxSkills >= 2`.
4. Select a third ONLY when `maxSkills = 3`, the candidate is Tier A or B, fits the
   remaining token budget, AND contributes at least one unique strong
   `TASK_TRIGGER` or `DOMAIN` evidence value not already covered by the first two.
5. Determine confidence after provisional composition (§5.1.17). If final confidence
   is LOW, normalize per §5.1.17 rule 4.
6. NEVER select more than three. This makes 1–2 normal and 3 exceptional, with no
   numeric utility score and no hidden heuristic.

## §5.2 Public output types (AMEND-04, exact V1)

```ts
type RoutingTier = "E" | "A" | "B" | "C";
type Confidence = "HIGH" | "MEDIUM" | "LOW";
type LockStatus = "LOCKED" | "UNLOCKED";
type BudgetStatus = "WITHIN_BUDGET" | "EXPLICIT_OVER_BUDGET";
type ContentLevel = "L1" | "L2";

interface FingerprintEvidence {
  kind: "LANGUAGE" | "FRAMEWORK" | "PLATFORM" | "WORKSPACE";
  value: string;
  source: string;   // project-relative/config-relative path or property
}

interface ProjectFingerprint {
  projectPath: string;
  packageRoot: string | null;
  workspaceRoot: string | null;
  workspaceAmbiguous: boolean;
  languages: string[];
  platforms: string[];
  frameworks: string[];
  evidence: FingerprintEvidence[];
}

interface RoutingEvidence {
  category: "FRAMEWORK" | "PLATFORM" | "TASK_TRIGGER" | "DOMAIN"
          | "NAME_DESCRIPTION" | "PROJECT_PREFERENCE" | "LEXICAL";
  value: string;
}

interface ResolvedSkill {
  id: string;
  name: string;
  versionHash: string;
  tier: RoutingTier;
  recommendedContentLevel: ContentLevel;
  recommendedContentTokens: number;
  evidence: RoutingEvidence[];
  reasons: string[];
  warnings: CompatibilityWarning[];
}

interface RejectedSkill {
  id: string;
  name: string;
  versionHash?: string;
  tier?: RoutingTier;
  evidence: RoutingEvidence[];
  reasons: string[];   // negative reason codes
}

interface ResolutionResult {
  resolutionId: string;              // ONLY intentionally volatile field
  routerContractVersion: 1;
  routerImplementationVersion: string; // installed router/package semver; no timestamps/hostnames/randomness
  mode: "suggest";
  confidence: Confidence;
  projectFingerprint: ProjectFingerprint;
  explicit: ResolvedSkill[];
  selected: ResolvedSkill[];
  candidates: ResolvedSkill[];
  rejected: RejectedSkill[];
  automaticSelectedTokens: number;
  explicitSelectedTokens: number;
  maxTokens: number;                  // effective (§5.1.7)
  maxSkills: number;                  // effective (§5.1.7)
  lockStatus: LockStatus;
  budgetStatus: BudgetStatus;
}
```

Deterministic ordering (part of the contract):
- `ProjectFingerprint.languages`, `platforms`, `frameworks`: deduplicated canonical
  identifier sets, sorted ascending by UTF-16 code units;
- `FingerprintEvidence[]`: sorted by `kind`, then `value`, then `source`;
- `RoutingEvidence[]`: sorted by the enum order in §5.1.13, then `value`;
- reason codes and compatibility warnings: frozen enum order (§5.1.18).
- There is NO `timings` field on `ResolutionResult`. TEST-001 MUST NOT list `timings`
  as volatile; `resolutionId` is the only volatile field.

## §5.3 CLI resolve command

`ega-skills resolve --project <path> --task "<task>"` (plus optional explicit/budget
flags) executes §5.1.1 offline, prints deterministic serialization of
`ResolutionResult`, and returns LOW no-match normally. The CLI stays thin over the
router API. (At Wave 4, config/lock interfaces may use fixtures until SPEC-005
integration lands per EGA-587; the CONTRACT above does not change.)

## §5.4 Performance and determinism gates

1. Same task/project/catalog produces the same fingerprint/evidence/tier/order on all
   supported machines.
2. Benchmark: 100-skill warm resolve p95 `<= 300 ms` on the documented reference
   machine (tracked as a benchmark job, not a flaky per-developer correctness assert).
3. Resolve metadata target `< 500` `ega-o200k-v1` tokens for the normal 100-skill
   routing case (§5.1.19 rule 3).
