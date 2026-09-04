// SPEC-005 §5.1.2/§5.1.12 effective-policy derivation from the real project
// tree (EGA-587): when `resolveSkills` is called WITHOUT `input.policy`, the
// effective policy must come from the actual `.egaskills.yaml` /
// `.egaskills.lock` files next to the project (discoverConfig +
// readConfigAndLock + PROJECT_CONFIG_V1_DEFAULTS + resolveLockMode); when
// `input.policy` IS provided it must win outright (the tree is never
// consulted).
//
// Covers: deny config blocks automatic selection, adjacent valid lock pins
// exact immutable versions, no-config runs UNLOCKED on currents (V1
// defaults), stray lock without a config is ignored, locking.required=true
// without a lock throws E_LOCK_REQUIRED, and an explicit policy override
// still wins.
//
// Tests import the built packages (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getCurrentVersion,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";
import {
  E_LOCK_REQUIRED,
  ProjectLockError,
  hashNormalizedConfig,
  parseProjectConfig,
} from "../../packages/project/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

async function isolatedWorld(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-587-"));
  const env = { ...process.env, EGA_SKILLS_HOME: join(base, "home") };
  const src = join(base, "src");
  const proj = join(base, "proj");
  await mkdir(src, { recursive: true });
  await mkdir(proj, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, env, src, proj };
}

async function writeSkill(dir, name, options = {}) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name} uniquely marker.\n`;
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options.description ?? `${name} skill`}\n---\n${body}`,
  );
  if (options.egaYaml !== undefined) {
    await writeFile(join(root, "ega.yaml"), options.egaYaml);
  }
  return root;
}

function yaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\n${extra}`;
}

async function importAll(env, src, namespace) {
  const registry = openRegistry({ env });
  try {
    return await importSkills(registry, { path: src, namespace });
  } finally {
    registry.close();
  }
}

function currentHash(env, skillId) {
  const registry = openRegistry({ env });
  try {
    return getCurrentVersion(registry.db, skillId).versionHash;
  } finally {
    registry.close();
  }
}

/** Full resolved entry for a skill across selected+candidates (or undefined). */
function resolvedEntry(result, skillId) {
  return [...result.selected, ...result.candidates].find((skill) => skill.id === skillId);
}

// 1. A real `.egaskills.yaml` deny list must block automatic selection of
//    the denied namespace even though the caller passed NO policy.

test("EGA-587: tree deny config blocks automatic resolution without explicit policy", async (t) => {
  const world = await isolatedWorld(t);
  const blockedSrc = join(world.base, "src-blocked");
  await mkdir(blockedSrc, { recursive: true });
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  await writeSkill(blockedSrc, "node-tool", { egaYaml: yaml("triggers: [run chore]\n") });
  await importAll(world.env, world.src, "ega");
  await importAll(world.env, blockedSrc, "blocked");
  await writeFile(
    join(world.proj, ".egaskills.yaml"),
    "schema_version: 1\nnamespaces:\n  deny: [blocked]\n",
  );

  const result = await resolveSkills({
    task: "run chore",
    projectPath: world.proj,
    env: world.env,
  });

  assert.equal(result.lockStatus, "UNLOCKED");
  assert.ok(
    result.rejected.some(
      (skill) => skill.id === "blocked/node-tool" && skill.reasons.includes("NAMESPACE_DENIED"),
    ),
    `blocked/node-tool must be rejected with NAMESPACE_DENIED; rejected = ${JSON.stringify(result.rejected)}`,
  );
  const hits = [...result.selected, ...result.candidates].filter((skill) =>
    skill.id.startsWith("blocked/"),
  );
  assert.deepEqual(hits, [], "no blocked-namespace skill may be selected or candidate");
});

// 2. An adjacent VALID lock (matching the tree config's hash) must pin
//    resolution to the exact locked version_hash, not the current one.

test("EGA-587: adjacent valid lock restricts automatic resolution to exact locked versions", async (t) => {
  const world = await isolatedWorld(t);
  const configText = "schema_version: 1\n";
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  const root = join(world.src, "react-helper");
  await importAll(world.env, world.src, "ega");
  const pinned = currentHash(world.env, "ega/react-helper");
  // Move current forward to a second immutable version.
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: react-helper\ndescription: react-helper skill\n---\n# react-helper\n\nGuidance text for react-helper uniquely marker. v2 body.\n`,
  );
  await importAll(world.env, world.src, "ega");
  const current = currentHash(world.env, "ega/react-helper");
  assert.notEqual(pinned, current, "re-import must move current to a new version hash");

  const configHash = hashNormalizedConfig(parseProjectConfig(configText));
  await writeFile(join(world.proj, ".egaskills.yaml"), configText);
  await writeFile(
    join(world.proj, ".egaskills.lock"),
    `lockfile_version: 1
token_estimator: ega-o200k-v1
generated_from:
  config_hash: ${configHash}
skills:
  ega/react-helper:
    name: react-helper
    version_hash: ${pinned}
`,
  );

  const result = await resolveSkills({
    task: "build widget",
    projectPath: world.proj,
    env: world.env,
  });

  assert.equal(result.lockStatus, "LOCKED");
  const entry = resolvedEntry(result, "ega/react-helper");
  assert.ok(entry !== undefined, `ega/react-helper must resolve; ids = ${JSON.stringify([...result.selected, ...result.candidates].map((s) => s.id))}`);
  assert.equal(entry.versionHash, pinned, "locked resolution must use the exact pinned version");
  assert.notEqual(entry.versionHash, current, "locked resolution must never fall forward to current");
});

// 3. No `.egaskills.yaml` at all → PROJECT_CONFIG_V1_DEFAULTS: UNLOCKED,
//    current local versions, built-in budget defaults.

test("EGA-587: no config derives UNLOCKED with current versions and V1 defaults", async (t) => {
  const world = await isolatedWorld(t);
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  await importAll(world.env, world.src, "ega");
  const current = currentHash(world.env, "ega/react-helper");

  const result = await resolveSkills({
    task: "build widget",
    projectPath: world.proj,
    env: world.env,
  });

  assert.equal(result.lockStatus, "UNLOCKED");
  assert.equal(result.maxSkills, 3, "V1 defaults: max_skills 3");
  assert.equal(result.maxTokens, 5000, "V1 defaults: max_tokens 5000");
  const entry = resolvedEntry(result, "ega/react-helper");
  assert.ok(entry !== undefined, "ega/react-helper must resolve without any config");
  assert.equal(entry.versionHash, current, "UNLOCKED resolution uses the current local version");
});

// 4. A stray `.egaskills.lock` with NO selected config is ignored entirely
//    (SPEC-005 §5.1.2 rule 5): even garbage lock content must not throw.

test("EGA-587: stray lock without a config is ignored (UNLOCKED currents)", async (t) => {
  const world = await isolatedWorld(t);
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  await importAll(world.env, world.src, "ega");
  const current = currentHash(world.env, "ega/react-helper");
  await writeFile(join(world.proj, ".egaskills.lock"), "this is not a valid lock: [1, 2!!!\n");

  const result = await resolveSkills({
    task: "build widget",
    projectPath: world.proj,
    env: world.env,
  });

  assert.equal(result.lockStatus, "UNLOCKED", "stray lock must be ignored, not parsed");
  const entry = resolvedEntry(result, "ega/react-helper");
  assert.ok(entry !== undefined, "ega/react-helper must resolve despite the stray lock");
  assert.equal(entry.versionHash, current);
});

// 5. `locking.required: true` with no adjacent lock → E_LOCK_REQUIRED.

test("EGA-587: required-true without a lock throws E_LOCK_REQUIRED", async (t) => {
  const world = await isolatedWorld(t);
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  await importAll(world.env, world.src, "ega");
  await writeFile(
    join(world.proj, ".egaskills.yaml"),
    "schema_version: 1\nlocking:\n  required: true\n",
  );

  await assert.rejects(
    resolveSkills({ task: "build widget", projectPath: world.proj, env: world.env }),
    (err) => {
      assert.ok(err instanceof ProjectLockError, `expected ProjectLockError, got ${err?.constructor?.name}: ${err?.message}`);
      assert.equal(err.code, E_LOCK_REQUIRED);
      return true;
    },
  );
});

// 6. An explicit `input.policy` must win outright: the tree config's deny
//    list AND its locking.required=true are both ignored when a policy is
//    supplied (no derivation, no E_LOCK_REQUIRED).

test("EGA-587: explicit policy override still wins over tree config", async (t) => {
  const world = await isolatedWorld(t);
  const blockedSrc = join(world.base, "src-blocked");
  await mkdir(blockedSrc, { recursive: true });
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  await writeSkill(blockedSrc, "node-tool", { egaYaml: yaml("triggers: [run chore]\n") });
  await importAll(world.env, world.src, "ega");
  await importAll(world.env, blockedSrc, "blocked");
  // If derivation ran at all, locking.required=true with no lock would throw
  // E_LOCK_REQUIRED — and the deny list would block blocked/node-tool.
  await writeFile(
    join(world.proj, ".egaskills.yaml"),
    "schema_version: 1\nnamespaces:\n  deny: [blocked]\nlocking:\n  required: true\n",
  );

  const result = await resolveSkills({
    task: "run chore",
    projectPath: world.proj,
    env: world.env,
    policy: { deniedNamespaces: [] },
  });

  assert.equal(result.lockStatus, "UNLOCKED");
  const entry = resolvedEntry(result, "blocked/node-tool");
  assert.ok(entry !== undefined, "explicit policy must override the tree deny list");
  assert.ok(
    !result.rejected.some((skill) => skill.id === "blocked/node-tool"),
    "explicit policy must prevent the NAMESPACE_DENIED rejection",
  );
});