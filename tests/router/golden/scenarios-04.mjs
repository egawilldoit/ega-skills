/**
 * G028–G034 frozen golden scenarios — TEST-001 §5.1.2 (ambiguous 1 + explicit/budget 2 + monorepo 3 + missing-L1 1).
 * Contract: RouterGoldenScenario (TEST-001 §5.1.0). Fields absent from the spec are omitted.
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
 */

/** @type {RouterGoldenScenario[]} */
export const SCENARIOS_04 = [
  {
    kind: "ROUTER",
    id: "G028",
    task: "Fix a hydration mismatch in the React application.",
    projectFixture: "mono-root-ambiguous",
    expected: {
      // Spec: mustSelect none (empty selection).
      mustCandidate: ["ega/react-frontend"],
      confidence: ["LOW"],
      requiredReasonsBySkill: [
        { skillId: "ega/react-frontend", reasons: ["WORKSPACE_AMBIGUOUS"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G029",
    task: "Fix a hydration mismatch in this Next.js dashboard.",
    projectFixture: "nextjs-web",
    explicitSkills: ["ega/frontend-mobile"],
    expected: {
      mustExplicit: ["ega/frontend-mobile"],
      mustSelect: ["ega/react-frontend", "ega/systematic-debugging"],
      confidence: ["HIGH"],
      budgetStatus: "WITHIN_BUDGET",
      requiredReasonsBySkill: [
        { skillId: "ega/frontend-mobile", reasons: ["EXPLICIT_USER"] },
      ],
      requiredWarningsBySkill: [
        { skillId: "ega/frontend-mobile", warnings: ["EXPLICIT_PLATFORM_MISMATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G030",
    task: "Use the oversized reference for this decision.",
    projectFixture: "generic-project",
    explicitSkills: ["ega/oversized-reference"],
    maxTokens: 5000,
    expected: {
      mustExplicit: ["ega/oversized-reference"],
      confidence: ["LOW"],
      budgetStatus: "EXPLICIT_OVER_BUDGET",
      requiredReasonsBySkill: [
        { skillId: "ega/oversized-reference", reasons: ["EXPLICIT_USER"] },
      ],
      requiredWarningsBySkill: [
        { skillId: "ega/oversized-reference", warnings: ["EXPLICIT_CONTENT_OVERSIZED"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G031",
    task: "Fix a hydration mismatch in this Next.js dashboard.",
    projectFixture: "mono-web",
    expected: {
      mustSelect: ["ega/react-frontend", "ega/systematic-debugging"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
    },
  },
  {
    kind: "ROUTER",
    id: "G032",
    task: "Debug an Expo navigation error in this mobile app.",
    projectFixture: "mono-mobile",
    expected: {
      mustSelect: ["ega/frontend-mobile", "ega/systematic-debugging"],
      mustNotSelect: ["ega/react-frontend"],
      confidence: ["HIGH"],
    },
  },
  {
    kind: "ROUTER",
    id: "G033",
    task: "Implement a REST API endpoint in this service.",
    projectFixture: "mono-api",
    expected: {
      mustSelect: ["ega/backend-api"],
      mustNotSelect: ["ega/frontend-mobile", "ega/react-frontend"],
      confidence: ["MEDIUM"],
    },
  },
  {
    kind: "ROUTER",
    id: "G034",
    task: "Use the compact reference for this task.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/compact-reference"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/compact-reference", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
      requiredRecommendedContentBySkill: [
        { skillId: "ega/compact-reference", level: "L2", tokens: 4900 },
      ],
    },
  },
];