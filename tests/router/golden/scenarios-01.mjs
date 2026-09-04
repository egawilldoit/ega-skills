/**
 * G001–G009 frozen golden scenarios — TEST-001 §5.1.2 (exact base 34, web 5 + mobile 4).
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
export const SCENARIOS_01 = [
  {
    kind: "ROUTER",
    id: "G001",
    task: "Fix a hydration mismatch in this Next.js dashboard.",
    projectFixture: "nextjs-web",
    expected: {
      mustSelect: ["ega/react-frontend", "ega/systematic-debugging"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/react-frontend", reasons: ["FRAMEWORK_MATCH", "PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G002",
    task: "Debug a server action error in this Next.js React app.",
    projectFixture: "nextjs-web",
    expected: {
      mustSelect: ["ega/react-frontend", "ega/systematic-debugging"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/react-frontend", reasons: ["FRAMEWORK_MATCH", "TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G003",
    task: "Debug an Angular template error in this web app.",
    projectFixture: "angular-web",
    expected: {
      mustSelect: ["ega/angular-frontend", "ega/systematic-debugging"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/angular-frontend", reasons: ["FRAMEWORK_MATCH", "PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G004",
    task: "Reduce the bundle size of this web application.",
    projectFixture: "vite-react-web",
    expected: {
      mustSelect: ["ega/frontend-web"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/frontend-web", reasons: ["PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G005",
    task: "Improve web accessibility in this dashboard.",
    projectFixture: "nextjs-web",
    expected: {
      mustSelect: ["ega/frontend-web"],
      mustNotSelect: ["ega/frontend-mobile"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/frontend-web", reasons: ["PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G006",
    task: "Debug an Expo navigation error in this mobile app.",
    projectFixture: "expo-mobile",
    expected: {
      mustSelect: ["ega/frontend-mobile", "ega/systematic-debugging"],
      mustNotSelect: ["ega/react-frontend", "ega/frontend-web"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/frontend-mobile", reasons: ["FRAMEWORK_MATCH", "PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G007",
    task: "Debug an Android build failure in this React Native app.",
    projectFixture: "react-native-mobile",
    expected: {
      mustSelect: ["ega/frontend-mobile", "ega/systematic-debugging"],
      mustNotSelect: ["ega/react-frontend"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/frontend-mobile", reasons: ["FRAMEWORK_MATCH", "PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G008",
    task: "Implement deep linking in this Expo mobile app.",
    projectFixture: "expo-mobile",
    expected: {
      mustSelect: ["ega/frontend-mobile"],
      mustNotSelect: ["ega/frontend-web"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/frontend-mobile", reasons: ["FRAMEWORK_MATCH", "PLATFORM_MATCH", "TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G009",
    task: "Debug an iOS layout error in this React Native mobile screen.",
    projectFixture: "react-native-mobile",
    expected: {
      mustSelect: ["ega/frontend-mobile", "ega/systematic-debugging"],
      mustNotSelect: ["ega/react-frontend"],
      confidence: ["HIGH"],
    },
  },
];