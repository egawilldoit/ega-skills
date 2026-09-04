/**
 * G010–G018 frozen golden scenarios — TEST-001 §5.1.2 (debugging 4 + backend/API 3 + database 2).
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
export const SCENARIOS_02 = [
  {
    kind: "ROUTER",
    id: "G010",
    task: "Debugging a flaky test in this Node project.",
    projectFixture: "node-api",
    expected: {
      mustSelect: ["ega/testing", "ega/systematic-debugging"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/testing", reasons: ["TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G011",
    task: "Debugging a Java exception caused by a NullPointer failure.",
    projectFixture: "java-service",
    expected: {
      mustSelect: ["ega/java-backend", "ega/systematic-debugging"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/java-backend", reasons: ["TASK_TRIGGER_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G012",
    task: "Debugging an API 500 failure in this Python service.",
    projectFixture: "python-api",
    expected: {
      mustSelect: ["ega/backend-api", "ega/systematic-debugging"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/backend-api", reasons: ["DOMAIN_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G013",
    task: "Debugging a database SQL migration failure.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/database-security", "ega/systematic-debugging"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/database-security", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
        { skillId: "ega/systematic-debugging", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G014",
    task: "Implement a REST API endpoint for this service.",
    projectFixture: "node-api",
    expected: {
      mustSelect: ["ega/backend-api"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/backend-api", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G015",
    task: "Review API auth authorization and security for this endpoint.",
    projectFixture: "node-api",
    expected: {
      mustSelect: ["ega/backend-api", "ega/security-review"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/backend-api", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
        { skillId: "ega/security-review", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G016",
    task: "Implement a Java service API controller.",
    projectFixture: "java-service",
    expected: {
      mustSelect: ["ega/java-backend", "ega/backend-api"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/java-backend", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
        { skillId: "ega/backend-api", reasons: ["DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G017",
    task: "Review database SQL migration security before deployment.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/database-security"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/database-security", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
  {
    kind: "ROUTER",
    id: "G018",
    task: "Optimize a database slow query and index strategy.",
    projectFixture: "generic-project",
    expected: {
      mustSelect: ["ega/database-performance"],
      confidence: ["MEDIUM"],
      requiredReasonsBySkill: [
        { skillId: "ega/database-performance", reasons: ["TASK_TRIGGER_MATCH", "DOMAIN_MATCH"] },
      ],
    },
  },
];