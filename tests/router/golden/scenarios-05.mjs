/**
 * G035–G042 frozen golden scenarios — TEST-001 §5.1.4 (exact precision: large-default 1 +
 * large-10k 1 + oversized-never-auto 1 + explicit-large-over-budget 1 + empty-lock 1 +
 * duplicate-alias-import 1 + exact-fts-lexical-tie 1 + symlinked-cwd 1).
 * Contract: RouterGoldenScenario (TEST-001 §5.1.0); G040 uses ImportContractScenario
 * (TEST-001 §5.1.0) and is NOT run through router determinism x10.
 * Fields absent from the spec are omitted.
 *
 * @typedef {Object} RouterGoldenScenario
 * @property {"ROUTER"} kind
 * @property {string} id
 * @property {string} task
 * @property {string} projectFixture
 * @property {string} [skillCatalogFixture]
 * @property {string} [equivalentProjectFixture]
 * @property {string[]} [explicitSkills]
 * @property {number} [maxSkills]
 * @property {number} [maxTokens]
 * @property {Object} expected
 * @property {string[]} [expected.mustExplicit]
 * @property {string[]} [expected.mustSelect]
 * @property {string[]} [expected.maySelect]
 * @property {string[]} [expected.mustNotSelect]
 * @property {string[]} [expected.mustCandidate]
 * @property {string[]} [expected.mustReject]
 * @property {string[]} [expected.explicitOrder]
 * @property {string[]} [expected.selectedOrder]
 * @property {string[]} [expected.candidateOrder]
 * @property {string[]} [expected.rejectedPrefixOrder]
 * @property {Array<"HIGH"|"MEDIUM"|"LOW">} [expected.confidence]
 * @property {"LOCKED"|"UNLOCKED"} [expected.lockStatus]
 * @property {"WITHIN_BUDGET"|"EXPLICIT_OVER_BUDGET"} [expected.budgetStatus]
 * @property {Array<{skillId: string, reasons: string[]}>} [expected.requiredReasonsBySkill]
 * @property {Array<{skillId: string, warnings: string[]}>} [expected.requiredWarningsBySkill]
 * @property {Array<{skillId: string, level: "L1"|"L2", tokens: number}>} [expected.requiredRecommendedContentBySkill]
 *
 * @typedef {Object} ImportContractScenario
 * @property {"IMPORT_INTEGRATION"} kind
 * @property {string} id
 * @property {string} fixture
 * @property {"E_ALIAS_CONFLICT"} expectedError
 */

/** @type {RouterGoldenScenario[]} */
export const SCENARIOS_05 = [
  {
    kind: "ROUTER",
    id: "G035",
    task: "Use the large reference for this task.",
    projectFixture: "generic-project",
    skillCatalogFixture: "large-only",
    maxTokens: 5000,
    expected: {
      // Spec: mustNotSelect ega/large-reference; mustCandidate ega/large-reference
      // with candidateOrder exactly ega/large-reference. No selection, LOW confidence.
      mustNotSelect: ["ega/large-reference"],
      mustCandidate: ["ega/large-reference"],
      candidateOrder: ["ega/large-reference"],
      confidence: ["LOW"],
      requiredReasonsBySkill: [
        {
          skillId: "ega/large-reference",
          reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH", "TOKEN_BUDGET"],
        },
      ],
      requiredRecommendedContentBySkill: [
        { skillId: "ega/large-reference", level: "L2", tokens: 9000 },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G036",
    task: "Use the large reference for this task.",
    projectFixture: "generic-project",
    skillCatalogFixture: "large-only",
    maxTokens: 10000,
    expected: {
      mustSelect: ["ega/large-reference"],
      selectedOrder: ["ega/large-reference"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        {
          skillId: "ega/large-reference",
          reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"],
        },
      ],
      requiredRecommendedContentBySkill: [
        { skillId: "ega/large-reference", level: "L2", tokens: 9000 },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G037",
    task: "Use the oversized reference for this task.",
    projectFixture: "generic-project",
    skillCatalogFixture: "oversized-only",
    maxTokens: 20000,
    expected: {
      // Spec: oversized L2 (13,000) is NEVER auto-selected even at a 20K budget;
      // it may only be a candidate.
      mustNotSelect: ["ega/oversized-reference"],
      mustCandidate: ["ega/oversized-reference"],
      candidateOrder: ["ega/oversized-reference"],
      confidence: ["LOW"],
      requiredReasonsBySkill: [
        {
          skillId: "ega/oversized-reference",
          reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH", "CONTENT_OVERSIZED"],
        },
      ],
      requiredRecommendedContentBySkill: [
        { skillId: "ega/oversized-reference", level: "L2", tokens: 13000 },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G038",
    task: "Use the large reference for this task.",
    projectFixture: "generic-project",
    skillCatalogFixture: "large-only",
    explicitSkills: ["ega/large-reference"],
    maxTokens: 5000,
    expected: {
      mustExplicit: ["ega/large-reference"],
      explicitOrder: ["ega/large-reference"],
      confidence: ["LOW"],
      budgetStatus: "EXPLICIT_OVER_BUDGET",
      requiredReasonsBySkill: [
        { skillId: "ega/large-reference", reasons: ["EXPLICIT_USER"] },
      ],
      requiredRecommendedContentBySkill: [
        { skillId: "ega/large-reference", level: "L2", tokens: 9000 },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G039",
    task: "Write a regression test for this behavior.",
    projectFixture: "generic-empty-lock",
    explicitSkills: ["ega/testing"],
    expected: {
      // Spec: mustSelect none; mustCandidate none; mustReject ega/testing.
      mustReject: ["ega/testing"],
      confidence: ["LOW"],
      lockStatus: "LOCKED",
      requiredReasonsBySkill: [
        { skillId: "ega/testing", reasons: ["VERSION_NOT_LOCKED"] },
      ],
    },
  },
  {
    kind: "IMPORT_INTEGRATION",
    id: "G040",
    // Spec: fixture imports ega/frontend-mobile followed by
    // experimental/mobile-alias-conflict; both declare canonical alias
    // `mobile-ui`. NOT run through router determinism x10.
    fixture: "duplicate-alias-import",
    expectedError: "E_ALIAS_CONFLICT",
  },
  {
    kind: "ROUTER",
    id: "G041",
    task: "Orbital checksum",
    projectFixture: "generic-project",
    skillCatalogFixture: "lexical-tie-only",
    expected: {
      // Spec: mustSelect none. Both catalog skills have identical indexed
      // query-bearing description text and equal indexed-field lengths for the
      // query-bearing fields; neither has strong task evidence. NEVER assert
      // absolute BM25 values.
      candidateOrder: ["ega/alpha-lexical", "ega/omega-lexical"],
      confidence: ["LOW"],
      requiredReasonsBySkill: [
        { skillId: "ega/alpha-lexical", reasons: ["LEXICAL_MATCH"] },
        { skillId: "ega/omega-lexical", reasons: ["LEXICAL_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G042",
    task: "Fix a hydration mismatch in this Next.js dashboard.",
    projectFixture: "nextjs-web-via-symlink",
    equivalentProjectFixture: "nextjs-web",
    expected: {
      mustSelect: ["ega/react-frontend", "ega/systematic-debugging"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
    },
  },
];