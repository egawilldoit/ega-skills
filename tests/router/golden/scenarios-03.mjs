/**
 * G019–G027 frozen golden scenarios — TEST-001 §5.1.2 (testing 2 + planning 2 + teaching 2 + policy/lock 2 + ambiguous 1).
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
export const SCENARIOS_03 = [
  {
    kind: "ROUTER",
    id: "G019",
    task: "Write a regression test for this behavior.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/testing"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/testing", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G020",
    task: "Add an end to end test for checkout.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/testing"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/testing", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G021",
    task: "Create an implementation plan for this feature.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/writing-plans"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/writing-plans", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G022",
    task: "Create a migration rollout plan for this release.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/writing-plans"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/writing-plans", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G023",
    task: "Explain TypeScript generics to me.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/teach"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/teach", reasons: ["TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G024",
    task: "Teach me Angular signals in this Angular application.",
    projectFixture: "angular-web",
    expected: {
      mustSelect: ["ega/teach", "ega/angular-frontend"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "ega/teach", reasons: ["TASK_TRIGGER_MATCH"] },
        { skillId: "ega/angular-frontend", reasons: ["FRAMEWORK_MATCH", "TASK_TRIGGER_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G025",
    task: "Fix a hydration mismatch in this Next.js dashboard.",
    projectFixture: "nextjs-deny-experimental",
    skillCatalogFixture: "router-default-plus-experimental",
    explicitSkills: ["experimental/react-helper"],
    expected: {
      mustSelect: ["ega/react-frontend", "ega/systematic-debugging"],
      mustReject: ["experimental/react-helper"],
      confidence: ["HIGH"],
      requiredReasonsBySkill: [
        { skillId: "experimental/react-helper", reasons: ["NAMESPACE_DENIED"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G026",
    task: "Debugging a React hydration failure.",
    projectFixture: "nextjs-lock-debug-only",
    explicitSkills: ["ega/react-frontend"],
    expected: {
      mustSelect: ["ega/systematic-debugging"],
      mustReject: ["ega/react-frontend"],
      confidence: ["MEDIUM"],
      lockStatus: "LOCKED",
      requiredReasonsBySkill: [
        { skillId: "ega/react-frontend", reasons: ["VERSION_NOT_LOCKED"] },
        { skillId: "ega/systematic-debugging", reasons: ["LOCKED_VERSION", "TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G027",
    task: "Reconcile the lunar inventory checksum.",
    projectFixture: "generic-project",
    expected: {
      // Spec: mustSelect none (empty selection).
      confidence: ["LOW"],
    },
  },
];