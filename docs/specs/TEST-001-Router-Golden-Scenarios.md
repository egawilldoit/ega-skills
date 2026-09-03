# TEST-001 — Router Golden Scenarios (Frozen 42-Case Contract)

**Status:** FROZEN (V1 normative test contract).
**Incorporates:** AMEND-01 (EGA-606: exact replacement base-34 inventory G001–G034,
`RouterGoldenScenario` / `ImportContractScenario` schema, fixture-catalog isolation,
explicit/order/warning/content assertions, G035–G042 precision fixtures) and all
AMEND-04 (EGA-609) router semantics it asserts.
**Source:** Linear document `TEST-001 V1 Golden Corpus — Exact Base 34 + Fixture
Contract` (normative amendment payload for AMEND-01), incorporated here in full.
After this materialization, implementers read ONLY this file (plus SPEC-004/005) —
never the Linear document — for golden behavior.
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

---

## §5.1.0 Golden schema (AMEND-01, exact)

Router cases use EXACTLY this contract (input `maxSkills`/`maxTokens` are request
overrides, NEVER expected-output fields):

```ts
interface RouterGoldenScenario {
  kind: "ROUTER";
  id: string;                       // G001..G039, G041, G042
  task: string;
  projectFixture: string;
  skillCatalogFixture?: string;     // omitted = normative "router-default" catalog
  equivalentProjectFixture?: string;
  explicitSkills?: string[];
  maxSkills?: number;
  maxTokens?: number;

  expected: {
    mustExplicit?: string[];
    mustSelect?: string[];
    maySelect?: string[];
    mustNotSelect?: string[];
    mustCandidate?: string[];
    mustReject?: string[];
    explicitOrder?: string[];       // collection IDs must EQUAL this exact order
    selectedOrder?: string[];
    candidateOrder?: string[];
    rejectedPrefixOrder?: string[];
    confidence?: Array<"HIGH" | "MEDIUM" | "LOW">;
    lockStatus?: "LOCKED" | "UNLOCKED";
    budgetStatus?: "WITHIN_BUDGET" | "EXPLICIT_OVER_BUDGET";
    requiredReasonsBySkill?: Array<{ skillId: string; reasons: string[] }>;
    requiredWarningsBySkill?: Array<{ skillId: string; warnings: string[] }>;
    requiredRecommendedContentBySkill?: Array<{
      skillId: string; level: "L1" | "L2"; tokens: number;
    }>;
  };
}
```

Semantics (normative):
- `mustSelect`: every listed ID MUST be in `selected`.
- `mustExplicit`: every listed ID MUST be in the successful `explicit` collection.
- `maySelect`: each listed ID may or may not be in `selected`; NEVER a substitute
  for `mustSelect`. `maySelect` may only be used where the scenario explicitly
  permits optional composition; never weaken a `mustSelect` to make implementation pass.
- `mustNotSelect`: listed ID MUST NOT be in `selected`.
- `mustCandidate`: listed ID MUST appear in `candidates`.
- `mustReject`: listed ID MUST appear in `rejected`.
- `explicitOrder` / `selectedOrder` / `candidateOrder`: when present, the collection
  IDs MUST equal that exact order.
- `rejectedPrefixOrder`: when present, `rejected` MUST begin with exactly those IDs
  in that order; additional bounded diagnostics may follow only when the scenario
  allows them.
- `requiredReasonsBySkill`: every listed reason MUST occur on that skill's result
  entry in the relevant output collection.
- `requiredWarningsBySkill`: every listed warning MUST occur on that successful
  explicit skill result.
- `requiredRecommendedContentBySkill`: the listed result (explicit/selected/candidate
  as applicable) MUST expose the exact recommended content level and token count.
- `equivalentProjectFixture`: execute the same request against that fixture too and
  require the deterministic result fields (ALL fields except `resolutionId`) to be
  equal after realpath normalization (symlinked-cwd contract).
- `skillCatalogFixture`: selects the exact imported skill catalog for the scenario.
  Scenario-only conflict/experimental/FTS fixtures MUST NEVER leak into unrelated cases.

Importer-integration case uses EXACTLY this contract:

```ts
interface ImportContractScenario {
  kind: "IMPORT_INTEGRATION";
  id: string;                       // G040
  fixture: string;
  expectedError: "E_ALIAS_CONFLICT";
}
```

G040 counts in the 42-case inventory but is NOT run through router determinism x10.
The phrase "every routing scenario x10" applies ONLY to `kind: ROUTER`.

## §5.1.1 Fixture rules

1. All fixture source trees are ordinary Agent Skills/EGA V1 packages hashed by the
   real SPEC-002 implementation. Scenario definitions use logical fixture IDs; tests
   MUST resolve those IDs to the exact generated `sha256:...` version hashes and
   assert that fixture hashes remain frozen once first committed. Fake hard-coded
   hashes before the canonical hashing implementation exists are FORBIDDEN.
2. Unless a scenario states otherwise:
   - namespace = `ega`; L1 status = `AUTHORED`; L2 class = `NORMAL`; trust = `UNKNOWN`;
   - no aliases unless listed; no project preference; no lock;
   - request defaults `maxSkills=3`, `maxTokens=5000`;
   - normal skill L1 token counts are deliberately below 1,200 and fit together
     within the default budget;
   - fixture content is deterministic and padded only when a case requires an exact
     token-count boundary;
   - every project fixture is a REAL minimal directory tree consumed by the production
     fingerprint/config/lock code — never a mocked fingerprint object.
3. `~N` normal token values are fixture TARGETS, not public product constants;
   fixture construction MUST freeze the exact counts after the canonical content is
   committed. Boundary fixtures (4,900 / 9,000 / 13,000) are EXACT TEST-002 counts.
4. The fixture builder MUST fail if the token estimator ID is not `ega-o200k-v1`.
   The golden harness MUST refuse to run under any other estimator ID (TEST-002 gate).
5. No snapshot auto-regeneration. No LLM judge.

### §5.1.1.1 Skill fixture catalog (exact)

| Fixture ID | Canonical ID | Domains | Platforms | Frameworks | Strong triggers | Anti-triggers | L1/L2 contract |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `skill-react-frontend-v1` | `ega/react-frontend` | `frontend` | `web` | `react`, `nextjs`, `vite` | `hydration mismatch`, `server action`, `react component` | `react native`, `expo` | L1 AUTHORED, ~900 |
| `skill-angular-frontend-v1` | `ega/angular-frontend` | `frontend` | `web` | `angular` | `angular template`, `angular signals` | `react native`, `expo` | L1 AUTHORED, ~900 |
| `skill-frontend-web-v1` | `ega/frontend-web` | `frontend` | `web` | — | `web accessibility`, `bundle size`, `web layout` | `react native`, `expo` | L1 AUTHORED, ~800 |
| `skill-frontend-mobile-v1` | `ega/frontend-mobile` | `frontend`, `mobile` | `mobile` | `expo`, `react-native` | `navigation`, `deep linking`, `android build`, `ios layout` | `nextjs`, `web only` | L1 AUTHORED, ~900; alias `mobile-ui` |
| `skill-systematic-debugging-v1` | `ega/systematic-debugging` | `debugging` | — | — | `fix`, `debug`, `failure`, `crash`, `flaky`, `error`, `500` | — | L1 AUTHORED, ~700 |
| `skill-backend-api-v1` | `ega/backend-api` | `backend`, `api` | — | — | `rest api`, `api endpoint`, `api auth` | — | L1 AUTHORED, ~850 |
| `skill-java-backend-v1` | `ega/java-backend` | `backend`, `java` | — | — | `java exception`, `java service`, `java controller` | — | L1 AUTHORED, ~850 |
| `skill-database-security-v1` | `ega/database-security` | `database`, `security` | — | — | `sql migration`, `row level security`, `database security` | — | L1 AUTHORED, ~850 |
| `skill-database-performance-v1` | `ega/database-performance` | `database`, `performance` | — | — | `slow query`, `query plan`, `database index` | — | L1 AUTHORED, ~850 |
| `skill-testing-v1` | `ega/testing` | `testing` | — | — | `regression test`, `e2e test`, `end to end test`, `flaky test` | — | L1 AUTHORED, ~800 |
| `skill-writing-plans-v1` | `ega/writing-plans` | `planning` | — | — | `implementation plan`, `rollout plan`, `migration plan` | — | L1 AUTHORED, ~800 |
| `skill-teach-v1` | `ega/teach` | `teaching` | — | — | `explain`, `teach` | — | L1 AUTHORED, ~700 |
| `skill-security-review-v1` | `ega/security-review` | `security` | — | — | `authorization`, `security review`, `api auth` | — | L1 AUTHORED, ~800 |
| `skill-compact-reference-v1` | `ega/compact-reference` | `compact-reference` | — | — | `compact reference` | — | L1 MISSING; exact L2 = 4,900 |
| `skill-large-reference-v1` | `ega/large-reference` | `large-reference` | — | — | `large reference` | — | L1 MISSING; exact L2 = 9,000 |
| `skill-oversized-reference-v1` | `ega/oversized-reference` | `oversized-reference` | — | — | `oversized reference` | — | L1 MISSING; exact L2 = 13,000 |
| `skill-experimental-react-helper-v1` | `experimental/react-helper` | `frontend` | `web` | `react`, `nextjs` | `hydration mismatch` | — | L1 AUTHORED, ~750 |
| `skill-alias-conflict-v1` | `experimental/mobile-alias-conflict` | `mobile` | `mobile` | — | `alias collision` | — | L1 AUTHORED, ~600; alias `mobile-ui` (intentionally conflicts with `ega/frontend-mobile`) |
| `skill-alpha-lexical-v1` | `ega/alpha-lexical` | — | — | — | — | — | L1 AUTHORED, ~600; description exactly `Orbital checksum helper.` |
| `skill-omega-lexical-v1` | `ega/omega-lexical` | — | — | — | — | — | L1 AUTHORED, ~600; description exactly `Orbital checksum helper.` |

### §5.1.1.2 Named skill-catalog fixtures (exact isolation)

- `router-default`: all normal router fixtures from `ega/react-frontend` through
  `ega/oversized-reference`, EXCLUDING `experimental/react-helper`,
  `experimental/mobile-alias-conflict`, `ega/alpha-lexical`, `ega/omega-lexical`.
- `router-default-plus-experimental`: `router-default` + `experimental/react-helper`.
- `large-only`: only `ega/large-reference`.
- `oversized-only`: only `ega/oversized-reference`.
- `lexical-tie-only`: only `ega/alpha-lexical` + `ega/omega-lexical`.

Every router scenario uses `router-default` when `skillCatalogFixture` is omitted.
The alias-conflict fixture is NEVER part of a router catalog; it exists ONLY for
G040 import integration.

### §5.1.1.3 Project fixtures (exact)

| Project fixture | Deterministic evidence/config |
| --- | --- |
| `nextjs-web` | package-local `package.json` contains `react` + `next`; web; frameworks `react`,`nextjs` |
| `vite-react-web` | package-local `package.json` contains `react` + `vite`; web; frameworks `react`,`vite` |
| `angular-web` | package-local `package.json` contains `@angular/core`; `angular.json`; web; framework `angular` |
| `expo-mobile` | package-local `package.json` contains `react`,`react-native`,`expo`; mobile; frameworks `react`,`react-native`,`expo` |
| `react-native-mobile` | package-local `package.json` contains `react`,`react-native`; package-local `android/` + `ios/`; mobile |
| `node-api` | package-local Node/TS manifest with no frozen web/mobile framework evidence |
| `java-service` | nearest `pom.xml`; language `java`; no inferred Spring framework |
| `python-api` | nearest `pyproject.toml`; language `python`; no inferred framework |
| `generic-project` | valid project directory with no recognized framework/platform evidence |
| `nextjs-deny-experimental` | `nextjs-web` plus config `namespaces.deny: [experimental]` |
| `nextjs-lock-debug-only` | `nextjs-web` plus active lock containing only exact current `ega/systematic-debugging` |
| `mono-web` | workspace with `apps/web` Next.js and sibling `apps/mobile` Expo; projectPath=`apps/web` |
| `mono-mobile` | same workspace; projectPath=`apps/mobile` |
| `mono-api` | workspace with `apps/web` Next.js, `apps/mobile` Expo, `services/api` Node/TS; projectPath=`services/api` |
| `mono-root-ambiguous` | same workspace; projectPath=workspace root; no deterministic application package; `workspaceAmbiguous=true` |
| `generic-empty-lock` | `generic-project` plus a valid active lock with `skills: {}` |
| `nextjs-web-via-symlink` | filesystem symlink/junction path resolving to the exact real `nextjs-web` project directory |

Lock fixtures MUST contain real hashes produced by the fixture hashing stage. The
logical name `nextjs-lock-debug-only` means EXACTLY one lock entry:
`ega/systematic-debugging` at its fixture current hash.

## §5.1.2 Exact base 34 scenarios

### Web — 5

#### G001 `react-next-hydration`
- task: `Fix a hydration mismatch in this Next.js dashboard.`
- project: `nextjs-web`
- mustSelect: `ega/react-frontend`, `ega/systematic-debugging`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`
- required reasons: `ega/react-frontend`: `FRAMEWORK_MATCH`, `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`

#### G002 `react-next-server-action-error`
- task: `Debug a server action error in this Next.js React app.`
- project: `nextjs-web`
- mustSelect: `ega/react-frontend`, `ega/systematic-debugging`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`
- required reasons: `ega/react-frontend`: `FRAMEWORK_MATCH`, `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`

#### G003 `angular-template-error`
- task: `Debug an Angular template error in this web app.`
- project: `angular-web`
- mustSelect: `ega/angular-frontend`, `ega/systematic-debugging`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`
- required reasons: `ega/angular-frontend`: `FRAMEWORK_MATCH`, `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`

#### G004 `vite-bundle-size`
- task: `Reduce the bundle size of this web application.`
- project: `vite-react-web`
- mustSelect: `ega/frontend-web`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`
- required reasons: `ega/frontend-web`: `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`

#### G005 `web-accessibility`
- task: `Improve web accessibility in this dashboard.`
- project: `nextjs-web`
- mustSelect: `ega/frontend-web`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`
- required reasons: `ega/frontend-web`: `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`

### Mobile — 4

#### G006 `expo-navigation-bug`
- task: `Debug an Expo navigation error in this mobile app.`
- project: `expo-mobile`
- mustSelect: `ega/frontend-mobile`, `ega/systematic-debugging`
- mustNotSelect: `ega/react-frontend`, `ega/frontend-web`
- confidence: `HIGH`
- required reasons: `ega/frontend-mobile`: `FRAMEWORK_MATCH`, `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`

#### G007 `rn-android-build-failure`
- task: `Debug an Android build failure in this React Native app.`
- project: `react-native-mobile`
- mustSelect: `ega/frontend-mobile`, `ega/systematic-debugging`
- mustNotSelect: `ega/react-frontend`
- confidence: `HIGH`
- required reasons: `ega/frontend-mobile`: `FRAMEWORK_MATCH`, `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`

#### G008 `expo-deep-linking`
- task: `Implement deep linking in this Expo mobile app.`
- project: `expo-mobile`
- mustSelect: `ega/frontend-mobile`
- mustNotSelect: `ega/frontend-web`
- confidence: `HIGH`
- required reasons: `ega/frontend-mobile`: `FRAMEWORK_MATCH`, `PLATFORM_MATCH`, `TASK_TRIGGER_MATCH`

#### G009 `rn-ios-layout-error`
- task: `Debug an iOS layout error in this React Native mobile screen.`
- project: `react-native-mobile`
- mustSelect: `ega/frontend-mobile`, `ega/systematic-debugging`
- mustNotSelect: `ega/react-frontend`
- confidence: `HIGH`

### Debugging — 4

#### G010 `flaky-node-testing-debug`
- task: `Debugging a flaky test in this Node project.`
- project: `node-api`
- mustSelect: `ega/testing`, `ega/systematic-debugging`
- confidence: `MEDIUM`
- required reasons: `ega/testing`: `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

#### G011 `java-nullpointer-debug`
- task: `Debugging a Java exception caused by a NullPointer failure.`
- project: `java-service`
- mustSelect: `ega/java-backend`, `ega/systematic-debugging`
- confidence: `MEDIUM`
- required reasons: `ega/java-backend`: `TASK_TRIGGER_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

#### G012 `python-api-500-debug`
- task: `Debugging an API 500 failure in this Python service.`
- project: `python-api`
- mustSelect: `ega/backend-api`, `ega/systematic-debugging`
- confidence: `MEDIUM`
- required reasons: `ega/backend-api`: `DOMAIN_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

#### G013 `database-migration-failure-debug`
- task: `Debugging a database SQL migration failure.`
- project: `generic-project`
- mustSelect: `ega/database-security`, `ega/systematic-debugging`
- confidence: `MEDIUM`
- required reasons: `ega/database-security`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`; `ega/systematic-debugging`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

### Backend / API — 3

#### G014 `rest-api-endpoint`
- task: `Implement a REST API endpoint for this service.`
- project: `node-api`
- mustSelect: `ega/backend-api`
- confidence: `MEDIUM`
- required reasons: `ega/backend-api`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

#### G015 `api-auth-review`
- task: `Review API auth authorization and security for this endpoint.`
- project: `node-api`
- mustSelect: `ega/backend-api`, `ega/security-review`
- confidence: `MEDIUM`
- required reasons: `ega/backend-api`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`; `ega/security-review`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

#### G016 `java-service-controller`
- task: `Implement a Java service API controller.`
- project: `java-service`
- mustSelect: `ega/java-backend`, `ega/backend-api`
- confidence: `MEDIUM`
- required reasons: `ega/java-backend`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`; `ega/backend-api`: `DOMAIN_MATCH`

### Database — 2

#### G017 `sql-migration-security`
- task: `Review database SQL migration security before deployment.`
- project: `generic-project`
- mustSelect: `ega/database-security`
- confidence: `MEDIUM`
- required reasons: `ega/database-security`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

#### G018 `slow-query-index`
- task: `Optimize a database slow query and index strategy.`
- project: `generic-project`
- mustSelect: `ega/database-performance`
- confidence: `MEDIUM`
- required reasons: `ega/database-performance`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

### Testing — 2

#### G019 `regression-test`
- task: `Write a regression test for this behavior.`
- project: `generic-project`
- mustSelect: `ega/testing`
- confidence: `MEDIUM`
- required reasons: `ega/testing`: `TASK_TRIGGER_MATCH`

#### G020 `end-to-end-test`
- task: `Add an end to end test for checkout.`
- project: `generic-project`
- mustSelect: `ega/testing`
- confidence: `MEDIUM`
- required reasons: `ega/testing`: `TASK_TRIGGER_MATCH`

### Planning — 2

#### G021 `implementation-plan`
- task: `Create an implementation plan for this feature.`
- project: `generic-project`
- mustSelect: `ega/writing-plans`
- confidence: `MEDIUM`
- required reasons: `ega/writing-plans`: `TASK_TRIGGER_MATCH`

#### G022 `migration-rollout-plan`
- task: `Create a migration rollout plan for this release.`
- project: `generic-project`
- mustSelect: `ega/writing-plans`
- confidence: `MEDIUM`
- required reasons: `ega/writing-plans`: `TASK_TRIGGER_MATCH`

### Teaching — 2

#### G023 `explain-typescript-generics`
- task: `Explain TypeScript generics to me.`
- project: `generic-project`
- mustSelect: `ega/teach`
- confidence: `MEDIUM`
- required reasons: `ega/teach`: `TASK_TRIGGER_MATCH`

#### G024 `teach-angular-signals`
- task: `Teach me Angular signals in this Angular application.`
- project: `angular-web`
- mustSelect: `ega/teach`, `ega/angular-frontend`
- confidence: `HIGH`
- required reasons: `ega/teach`: `TASK_TRIGGER_MATCH`; `ega/angular-frontend`: `FRAMEWORK_MATCH`, `TASK_TRIGGER_MATCH`

### Policy / lock — 2

#### G025 `explicit-denied-namespace`
- skillCatalogFixture: `router-default-plus-experimental`
- task: `Fix a hydration mismatch in this Next.js dashboard.`
- project: `nextjs-deny-experimental`
- explicitSkills: `experimental/react-helper`
- mustReject: `experimental/react-helper`
- mustSelect: `ega/react-frontend`, `ega/systematic-debugging`
- confidence: `HIGH`
- required reasons: `experimental/react-helper`: `NAMESPACE_DENIED`

#### G026 `explicit-version-not-locked`
- task: `Debugging a React hydration failure.`
- project: `nextjs-lock-debug-only`
- explicitSkills: `ega/react-frontend`
- mustReject: `ega/react-frontend`
- mustSelect: `ega/systematic-debugging`
- confidence: `MEDIUM`
- lockStatus: `LOCKED`
- required reasons: `ega/react-frontend`: `VERSION_NOT_LOCKED`; `ega/systematic-debugging`: `LOCKED_VERSION`, `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`

### Ambiguous / low-confidence — 2

#### G027 `no-useful-match`
- task: `Reconcile the lunar inventory checksum.`
- project: `generic-project`
- mustSelect: none (empty selection)
- confidence: `LOW`

#### G028 `workspace-root-ambiguous`
- task: `Fix a hydration mismatch in the React application.`
- project: `mono-root-ambiguous`
- mustSelect: none (empty selection)
- mustCandidate: `ega/react-frontend`
- confidence: `LOW`
- required reasons: `ega/react-frontend`: `WORKSPACE_AMBIGUOUS`

### Explicit / budget — 2

#### G029 `explicit-mobile-on-web`
- task: `Fix a hydration mismatch in this Next.js dashboard.`
- project: `nextjs-web`
- explicitSkills: `ega/frontend-mobile`
- mustExplicit: `ega/frontend-mobile`
- mustSelect: `ega/react-frontend`, `ega/systematic-debugging`
- confidence: `HIGH`
- budgetStatus: `WITHIN_BUDGET`
- required reasons: `ega/frontend-mobile`: `EXPLICIT_USER`
- required warnings: `ega/frontend-mobile`: `EXPLICIT_PLATFORM_MISMATCH`

#### G030 `explicit-oversized-over-budget`
- task: `Use the oversized reference for this decision.`
- project: `generic-project`
- explicitSkills: `ega/oversized-reference`
- maxTokens: 5000
- mustExplicit: `ega/oversized-reference`
- confidence: `LOW`
- budgetStatus: `EXPLICIT_OVER_BUDGET`
- required reasons: `ega/oversized-reference`: `EXPLICIT_USER`
- required warnings: `ega/oversized-reference`: `EXPLICIT_CONTENT_OVERSIZED`

### Monorepo — 3

#### G031 `monorepo-web-sibling-isolation`
- task: `Fix a hydration mismatch in this Next.js dashboard.`
- project: `mono-web`
- mustSelect: `ega/react-frontend`, `ega/systematic-debugging`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`

#### G032 `monorepo-mobile-sibling-isolation`
- task: `Debug an Expo navigation error in this mobile app.`
- project: `mono-mobile`
- mustSelect: `ega/frontend-mobile`, `ega/systematic-debugging`
- mustNotSelect: `ega/react-frontend`
- confidence: `HIGH`

#### G033 `monorepo-api-sibling-isolation`
- task: `Implement a REST API endpoint in this service.`
- project: `mono-api`
- mustSelect: `ega/backend-api`
- mustNotSelect: `ega/frontend-mobile`, `ega/react-frontend`
- confidence: `MEDIUM`

### Missing L1 — 1

#### G034 `missing-l1-normal-l2`
- task: `Use the compact reference for this task.`
- project: `generic-project`
- mustSelect: `ega/compact-reference`
- confidence: `MEDIUM`
- required reasons: `ega/compact-reference`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`
- requiredRecommendedContentBySkill: `ega/compact-reference` -> `L2`, `4900`

## §5.1.3 Base-34 count proof (normative)

```text
web             5  (G001-G005)
mobile          4  (G006-G009)
debugging       4  (G010-G013)
backend/API     3  (G014-G016)
database        2  (G017-G018)
testing         2  (G019-G020)
planning        2  (G021-G022)
teaching        2  (G023-G024)
policy/lock     2  (G025-G026)
ambiguous       2  (G027-G028)
explicit/budget 2  (G029-G030)
monorepo        3  (G031-G033)
missing-L1      1  (G034)
-----------------
total          34
```

## §5.1.4 Exact precision scenarios G035–G042

These eight cases plus G001–G034 form the EXACT V1 inventory of 42. No other golden
scenario exists in V1.

#### G035 `large-l2-default-budget`
- skillCatalogFixture: `large-only`; kind: `ROUTER`
- task: `Use the large reference for this task.`
- project: `generic-project`; maxTokens: `5000`
- mustNotSelect: `ega/large-reference`; mustCandidate: `ega/large-reference`
- candidateOrder: exactly `ega/large-reference`
- confidence: `LOW`
- required reasons: `ega/large-reference`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`, `TOKEN_BUDGET`
- requiredRecommendedContentBySkill: `ega/large-reference` -> `L2`, `9000`

#### G036 `large-l2-custom-10k`
- skillCatalogFixture: `large-only`; kind: `ROUTER`
- task: `Use the large reference for this task.`
- project: `generic-project`; maxTokens: `10000`
- mustSelect: `ega/large-reference`; selectedOrder: `ega/large-reference`
- confidence: `MEDIUM`
- required reasons: `ega/large-reference`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`
- requiredRecommendedContentBySkill: `ega/large-reference` -> `L2`, `9000`

#### G037 `oversized-l2-never-auto`
- skillCatalogFixture: `oversized-only`; kind: `ROUTER`
- task: `Use the oversized reference for this task.`
- project: `generic-project`; maxTokens: `20000`
- mustNotSelect: `ega/oversized-reference`; mustCandidate: `ega/oversized-reference`
- candidateOrder: exactly `ega/oversized-reference`
- confidence: `LOW`
- required reasons: `ega/oversized-reference`: `TASK_TRIGGER_MATCH`, `DOMAIN_MATCH`, `CONTENT_OVERSIZED`
- requiredRecommendedContentBySkill: `ega/oversized-reference` -> `L2`, `13000`

#### G038 `explicit-large-over-auto-budget`
- skillCatalogFixture: `large-only`; kind: `ROUTER`
- task: `Use the large reference for this task.`
- project: `generic-project`; explicitSkills: `ega/large-reference`; maxTokens: `5000`
- mustExplicit: `ega/large-reference`; explicitOrder: `ega/large-reference`
- confidence: `LOW`; budgetStatus: `EXPLICIT_OVER_BUDGET`
- required reasons: `ega/large-reference`: `EXPLICIT_USER`
- requiredRecommendedContentBySkill: `ega/large-reference` -> `L2`, `9000`

#### G039 `empty-lock`
- kind: `ROUTER`
- task: `Write a regression test for this behavior.`
- project: `generic-empty-lock`; explicitSkills: `ega/testing`
- mustSelect: none; mustCandidate: none; mustReject: `ega/testing`
- confidence: `LOW`; lockStatus: `LOCKED`
- required reasons: `ega/testing`: `VERSION_NOT_LOCKED`

#### G040 `duplicate-alias-import`
- kind: `IMPORT_INTEGRATION`
- fixture imports `ega/frontend-mobile` followed by `experimental/mobile-alias-conflict`; both declare canonical alias `mobile-ui`
- expectedError: `E_ALIAS_CONFLICT`
- assertion: the conflicting second skill commits NO partial version/source/FTS/alias state; the first skill retains alias ownership
- this case is NOT run through router x10 determinism

#### G041 `exact-fts-lexical-tie`
- kind: `ROUTER`
- task: `Orbital checksum`
- project: `generic-project`; skillCatalogFixture: `lexical-tie-only`
- both catalog skills have identical indexed query-bearing description text and equal indexed-field lengths for the query-bearing fields; neither has strong task evidence
- mustSelect: none
- candidateOrder: `ega/alpha-lexical`, then `ega/omega-lexical`
- confidence: `LOW`
- required reasons: both include `LEXICAL_MATCH`
- NEVER assert absolute BM25 values

#### G042 `symlinked-cwd-realpath-equivalence`
- kind: `ROUTER`
- task: `Fix a hydration mismatch in this Next.js dashboard.`
- project: `nextjs-web-via-symlink`; equivalentProjectFixture: `nextjs-web`
- mustSelect: `ega/react-frontend`, `ega/systematic-debugging`
- mustNotSelect: `ega/frontend-mobile`
- confidence: `HIGH`
- assertion: after project-path realpath normalization, EVERY deterministic
  `ResolutionResult` field is identical to the same request against `nextjs-web`;
  ONLY `resolutionId` may differ

## §5.1.5 Inventory proof: 34 + 8 = 42 (normative)

G001–G034 (base) + G035–G042 (precision: G035 large-default, G036 large-10k,
G037 oversized-never-auto, G038 explicit-large-over-budget, G039 empty-lock,
G040 duplicate-alias-import, G041 exact-fts-lexical-tie, G042 symlinked-cwd) =
EXACTLY 42 scenarios. The checker enforces G001–G042 presence exactly once.

## §5.1.6 Determinism x10 harness

1. Every `kind: ROUTER` scenario runs 10 times; the ONLY ignored volatile field is
   `resolutionId`. (`timings` is NOT a V1 `ResolutionResult` field and MUST NOT
   appear in any volatile-field list.)
2. TEST-002 MUST pass before golden budget assertions run (estimator identity gate).
3. Exact selected/candidate/rejected/explicit IDs, confidence, lock/budget status,
   reasons, warnings, content levels/tokens, and orderings listed above are NORMATIVE.
4. Golden failure output identifies: case ID, collection mismatch,
   evidence/reason/warning mismatch, content-level/token mismatch, and
   deterministic-order mismatch.

## §5.1.7 Golden diagnostic codes (harness only, never runtime)

`GOLDEN_FIXTURE_INVALID`, `GOLDEN_EXPECTED_SELECTION_MISSING`,
`GOLDEN_UNEXPECTED_SELECTION`, `GOLDEN_CONFIDENCE_MISMATCH`,
`GOLDEN_TOKEN_BUDGET_EXCEEDED`, `GOLDEN_NON_DETERMINISTIC`.
These are test-harness codes, intentionally NOT `E_*` prefixed, and MUST NEVER be
emitted as product runtime errors (SPEC-006 §5.1.3 rule 3).

## §5.1.8 Router performance gate

A separate release benchmark supports warm resolve p95 `<= 300 ms` on 100 skills
(SPEC-004 §5.4). It is a benchmark job, not a flaky per-developer correctness assert.
