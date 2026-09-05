// Golden fixture data for TEST-001 router scenarios (SPEC derived).
// Values copied verbatim from docs/specs/TEST-001-Router-Golden-Scenarios.md
// §5.1.1.1 (§5.1.1.2 / §5.1.1.3). No logic, no imports — pure data.

/**
 * One golden skill fixture, mirroring the skill catalog table (§5.1.1.1).
 * @typedef {object} SkillFixture
 * @property {string} fixtureId                     Logical fixture ID (e.g. `skill-react-frontend-v1`).
 * @property {string} canonicalId                   Canonical `namespace/name` identity (e.g. `ega/react-frontend`).
 * @property {string[]} domains                     Domains column ("—" becomes an empty array).
 * @property {string[]} platforms                   Platforms column ("—" becomes an empty array).
 * @property {string[]} frameworks                  Frameworks column ("—" becomes an empty array).
 * @property {string[]} triggers                    Strong triggers column ("—" becomes an empty array).
 * @property {string[]} antiTriggers                Anti-triggers column ("—" becomes an empty array).
 * @property {{status: 'AUTHORED'|'MISSING', tokenTarget: number|null}} l1
 *   L1 status plus fixture token target (`~N` targets are recorded as N; MISSING has no L1 target).
 * @property {{tokenTarget: number|null}} l2       L2 token target (exact for boundary fixtures, else null).
 * @property {string[]} aliases                     Aliases column (alias `mobile-ui` rows listed; else empty array).
 */

/**
 * Golden catalog of the 20 skill fixtures from §5.1.1.1.
 * @type {SkillFixture[]}
 */
export const SKILL_FIXTURES = [
  {
    fixtureId: 'skill-react-frontend-v1',
    canonicalId: 'ega/react-frontend',
    domains: ['frontend'],
    platforms: ['web'],
    frameworks: ['react', 'nextjs', 'vite'],
    triggers: ['hydration mismatch', 'server action', 'react component'],
    antiTriggers: ['react native', 'expo'],
    l1: { status: 'AUTHORED', tokenTarget: 900 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-angular-frontend-v1',
    canonicalId: 'ega/angular-frontend',
    domains: ['frontend'],
    platforms: ['web'],
    frameworks: ['angular'],
    triggers: ['angular template', 'angular signals'],
    antiTriggers: ['react native', 'expo'],
    l1: { status: 'AUTHORED', tokenTarget: 900 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-frontend-web-v1',
    canonicalId: 'ega/frontend-web',
    domains: ['frontend'],
    platforms: ['web'],
    frameworks: [],
    triggers: ['web accessibility', 'bundle size', 'web layout'],
    antiTriggers: ['react native', 'expo'],
    l1: { status: 'AUTHORED', tokenTarget: 800 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-frontend-mobile-v1',
    canonicalId: 'ega/frontend-mobile',
    domains: ['frontend', 'mobile'],
    platforms: ['mobile'],
    frameworks: ['expo', 'react-native'],
    triggers: ['navigation', 'deep linking', 'android build', 'ios layout'],
    antiTriggers: ['nextjs', 'web only'],
    l1: { status: 'AUTHORED', tokenTarget: 900 },
    l2: { tokenTarget: null },
    aliases: ['mobile-ui'],
  },
  {
    fixtureId: 'skill-systematic-debugging-v1',
    canonicalId: 'ega/systematic-debugging',
    domains: ['debugging'],
    platforms: [],
    frameworks: [],
    triggers: ['fix', 'debug', 'failure', 'crash', 'flaky', 'error', '500'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 700 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-backend-api-v1',
    canonicalId: 'ega/backend-api',
    domains: ['backend', 'api'],
    platforms: [],
    frameworks: [],
    triggers: ['rest api', 'api endpoint', 'api auth'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 850 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-java-backend-v1',
    canonicalId: 'ega/java-backend',
    domains: ['backend', 'java'],
    platforms: [],
    frameworks: [],
    triggers: ['java exception', 'java service', 'java controller'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 850 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-database-security-v1',
    canonicalId: 'ega/database-security',
    domains: ['database', 'security'],
    platforms: [],
    frameworks: [],
    triggers: ['sql migration', 'row level security', 'database security'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 850 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-database-performance-v1',
    canonicalId: 'ega/database-performance',
    domains: ['database', 'performance'],
    platforms: [],
    frameworks: [],
    triggers: ['slow query', 'query plan', 'database index'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 850 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-testing-v1',
    canonicalId: 'ega/testing',
    domains: ['testing'],
    platforms: [],
    frameworks: [],
    triggers: ['regression test', 'e2e test', 'end to end test', 'flaky test'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 800 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-writing-plans-v1',
    canonicalId: 'ega/writing-plans',
    domains: ['planning'],
    platforms: [],
    frameworks: [],
    triggers: ['implementation plan', 'rollout plan', 'migration plan'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 800 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-teach-v1',
    canonicalId: 'ega/teach',
    domains: ['teaching'],
    platforms: [],
    frameworks: [],
    triggers: ['explain', 'teach'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 700 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-security-review-v1',
    canonicalId: 'ega/security-review',
    domains: ['security'],
    platforms: [],
    frameworks: [],
    triggers: ['authorization', 'security review', 'api auth'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 800 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-compact-reference-v1',
    canonicalId: 'ega/compact-reference',
    domains: ['compact-reference'],
    platforms: [],
    frameworks: [],
    triggers: ['compact reference'],
    antiTriggers: [],
    l1: { status: 'MISSING', tokenTarget: null },
    l2: { tokenTarget: 4900 },
    aliases: [],
  },
  {
    fixtureId: 'skill-large-reference-v1',
    canonicalId: 'ega/large-reference',
    domains: ['large-reference'],
    platforms: [],
    frameworks: [],
    triggers: ['large reference'],
    antiTriggers: [],
    l1: { status: 'MISSING', tokenTarget: null },
    l2: { tokenTarget: 9000 },
    aliases: [],
  },
  {
    fixtureId: 'skill-oversized-reference-v1',
    canonicalId: 'ega/oversized-reference',
    domains: ['oversized-reference'],
    platforms: [],
    frameworks: [],
    triggers: ['oversized reference'],
    antiTriggers: [],
    l1: { status: 'MISSING', tokenTarget: null },
    l2: { tokenTarget: 13000 },
    aliases: [],
  },
  {
    fixtureId: 'skill-experimental-react-helper-v1',
    canonicalId: 'experimental/react-helper',
    domains: ['frontend'],
    platforms: ['web'],
    frameworks: ['react', 'nextjs'],
    triggers: ['hydration mismatch'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 750 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-alias-conflict-v1',
    canonicalId: 'experimental/mobile-alias-conflict',
    domains: ['mobile'],
    platforms: ['mobile'],
    frameworks: [],
    triggers: ['alias collision'],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 600 },
    l2: { tokenTarget: null },
    aliases: ['mobile-ui'],
  },
  {
    fixtureId: 'skill-alpha-lexical-v1',
    canonicalId: 'ega/alpha-lexical',
    // Frozen exact description (TEST-001 §5.1.1.1): the lexical-tie query
    // text. The materializer uses entry.description when present.
    description: 'Orbital checksum helper.',
    domains: [],
    platforms: [],
    frameworks: [],
    triggers: [],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 600 },
    l2: { tokenTarget: null },
    aliases: [],
  },
  {
    fixtureId: 'skill-omega-lexical-v1',
    canonicalId: 'ega/omega-lexical',
    // Frozen exact description (TEST-001 §5.1.1.1): identical to alpha so the
    // FTS lexical tie is exact.
    description: 'Orbital checksum helper.',
    domains: [],
    platforms: [],
    frameworks: [],
    triggers: [],
    antiTriggers: [],
    l1: { status: 'AUTHORED', tokenTarget: 600 },
    l2: { tokenTarget: null },
    aliases: [],
  },
];

/**
 * Named skill-catalog fixtures (§5.1.1.2), each an ordered array of fixture IDs.
 * The trailing `ROUTER_EXCLUDED` key lists fixtures that are NEVER part of a
 * router catalog (the alias-conflict fixture exists ONLY for G040 import
 * integration).
 * @type {Object<string, string[]> & {ROUTER_EXCLUDED: string[]}}
 */
export const SKILL_CATALOGS = {
  'router-default': [
    'skill-react-frontend-v1',
    'skill-angular-frontend-v1',
    'skill-frontend-web-v1',
    'skill-frontend-mobile-v1',
    'skill-systematic-debugging-v1',
    'skill-backend-api-v1',
    'skill-java-backend-v1',
    'skill-database-security-v1',
    'skill-database-performance-v1',
    'skill-testing-v1',
    'skill-writing-plans-v1',
    'skill-teach-v1',
    'skill-security-review-v1',
    'skill-compact-reference-v1',
    'skill-large-reference-v1',
    'skill-oversized-reference-v1',
  ],
  'router-default-plus-experimental': [
    'skill-react-frontend-v1',
    'skill-angular-frontend-v1',
    'skill-frontend-web-v1',
    'skill-frontend-mobile-v1',
    'skill-systematic-debugging-v1',
    'skill-backend-api-v1',
    'skill-java-backend-v1',
    'skill-database-security-v1',
    'skill-database-performance-v1',
    'skill-testing-v1',
    'skill-writing-plans-v1',
    'skill-teach-v1',
    'skill-security-review-v1',
    'skill-compact-reference-v1',
    'skill-large-reference-v1',
    'skill-oversized-reference-v1',
    'skill-experimental-react-helper-v1',
  ],
  'large-only': ['skill-large-reference-v1'],
  'oversized-only': ['skill-oversized-reference-v1'],
  'lexical-tie-only': ['skill-alpha-lexical-v1', 'skill-omega-lexical-v1'],
  // The alias-conflict fixture is intentionally NOT a router catalog; it is
  // listed here (marked ROUTER_EXCLUDED) for G040 import integration data only.
  'alias-conflict-excluded': ['skill-alias-conflict-v1'],
  ROUTER_EXCLUDED: ['skill-alias-conflict-v1'],
};

/**
 * One golden project fixture, mirroring the project fixtures table (§5.1.1.3).
 * @typedef {object} ProjectFixture
 * @property {string} fixtureId   Logical project fixture ID (e.g. `nextjs-web`).
 * @property {string} evidence    Deterministic evidence/config descriptor, verbatim from the spec.
 */

/**
 * Golden catalog of the 17 project fixtures from §5.1.1.3.
 * @type {ProjectFixture[]}
 */
export const PROJECT_FIXTURES = [
  {
    fixtureId: 'nextjs-web',
    evidence:
      'package-local `package.json` contains `react` + `next`; web; frameworks `react`,`nextjs`',
  },
  {
    fixtureId: 'vite-react-web',
    evidence:
      'package-local `package.json` contains `react` + `vite`; web; frameworks `react`,`vite`',
  },
  {
    fixtureId: 'angular-web',
    evidence:
      'package-local `package.json` contains `@angular/core`; `angular.json`; web; framework `angular`',
  },
  {
    fixtureId: 'expo-mobile',
    evidence:
      'package-local `package.json` contains `react`,`react-native`,`expo`; mobile; frameworks `react`,`react-native`,`expo`',
  },
  {
    fixtureId: 'react-native-mobile',
    evidence:
      'package-local `package.json` contains `react`,`react-native`; package-local `android/` + `ios/`; mobile',
  },
  {
    fixtureId: 'node-api',
    evidence:
      'package-local Node/TS manifest with no frozen web/mobile framework evidence',
  },
  {
    fixtureId: 'java-service',
    evidence: 'nearest `pom.xml`; language `java`; no inferred Spring framework',
  },
  {
    fixtureId: 'python-api',
    evidence: 'nearest `pyproject.toml`; language `python`; no inferred framework',
  },
  {
    fixtureId: 'generic-project',
    evidence: 'valid project directory with no recognized framework/platform evidence',
  },
  {
    fixtureId: 'nextjs-deny-experimental',
    evidence: '`nextjs-web` plus config `namespaces.deny: [experimental]`',
  },
  {
    fixtureId: 'nextjs-lock-debug-only',
    evidence:
      '`nextjs-web` plus active lock containing only exact current `ega/systematic-debugging`',
  },
  {
    fixtureId: 'mono-web',
    evidence:
      'workspace with `apps/web` Next.js and sibling `apps/mobile` Expo; projectPath=`apps/web`',
  },
  {
    fixtureId: 'mono-mobile',
    evidence: 'same workspace; projectPath=`apps/mobile`',
  },
  {
    fixtureId: 'mono-api',
    evidence:
      'workspace with `apps/web` Next.js, `apps/mobile` Expo, `services/api` Node/TS; projectPath=`services/api`',
  },
  {
    fixtureId: 'mono-root-ambiguous',
    evidence:
      'same workspace; projectPath=workspace root; no deterministic application package; `workspaceAmbiguous=true`',
  },
  {
    fixtureId: 'generic-empty-lock',
    evidence: '`generic-project` plus a valid active lock with `skills: {}`',
  },
  {
    fixtureId: 'nextjs-web-via-symlink',
    evidence:
      'filesystem symlink/junction path resolving to the exact real `nextjs-web` project directory',
  },
];