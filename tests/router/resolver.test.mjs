import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  getCurrentVersion,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";
import { RouterError } from "../../packages/router/dist/errors.js";

const FROZEN_TOP_FIELDS = [
  "resolutionId",
  "routerContractVersion",
  "routerImplementationVersion",
  "mode",
  "confidence",
  "projectFingerprint",
  "explicit",
  "selected",
  "candidates",
  "rejected",
  "automaticSelectedTokens",
  "explicitSelectedTokens",
  "maxTokens",
  "maxSkills",
  "lockStatus",
  "budgetStatus",
];

async function isolatedWorld(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-579-"));
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
  if (options.core !== undefined) {
    await writeFile(join(root, "SKILL.core.md"), options.core);
  }
  if (options.egaYaml !== undefined) {
    await writeFile(join(root, "ega.yaml"), options.egaYaml);
  }
  return root;
}

function yaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\n${extra}`;
}

async function importAll(env, src, namespace = "ega") {
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

function isRequestInvalid(error) {
  return error instanceof RouterError && error.code === "E_RESOLVE_REQUEST_INVALID";
}

async function twoSkillWorld(t) {
  const world = await isolatedWorld(t);
  await writeSkill(world.src, "react-helper", {
    egaYaml: yaml("frameworks: [react]\nplatforms: [web]\ntriggers: [build widget]\n"),
  });
  await writeSkill(world.src, "node-tool", { egaYaml: yaml("triggers: [run chore]\n") });
  await writeFile(
    join(world.proj, "package.json"),
    JSON.stringify({ name: "proj", dependencies: { react: "^19.0.0", next: "^15.0.0" } }),
  );
  const summary = await importAll(world.env, world.src);
  assert.equal(summary.imported, 2);
  return world;
}

// SPEC-004 §5.1.2 request validation.

test("SPEC-004 §5.1.2: malformed requests fail with E_RESOLVE_REQUEST_INVALID", async (t) => {
  const world = await isolatedWorld(t);
  const baseInput = { task: "build widget", projectPath: world.proj, env: world.env };
  await assert.rejects(resolveSkills({ ...baseInput, task: "   " }), isRequestInvalid);
  await assert.rejects(resolveSkills({ ...baseInput, budget: { maxSkills: 5 } }), isRequestInvalid);
  await assert.rejects(resolveSkills({ ...baseInput, budget: { maxSkills: 0 } }), isRequestInvalid);
  await assert.rejects(resolveSkills({ ...baseInput, budget: { maxTokens: 0 } }), isRequestInvalid);
  await assert.rejects(resolveSkills({ ...baseInput, budget: { maxTokens: 1000001 } }), isRequestInvalid);
  await assert.rejects(
    resolveSkills({ ...baseInput, explicitSkills: Array(11).fill("ega/x") }),
    isRequestInvalid,
  );
  await assert.rejects(resolveSkills({ ...baseInput, explicitSkills: ["  "] }), isRequestInvalid);
});

// SPEC-004 §5.1.1 pipeline + §5.2 result.

test("SPEC-004 §5.1.1: full pipeline selects the relevant skill with frozen fields", async (t) => {
  const world = await twoSkillWorld(t);
  const result = await resolveSkills({
    task: "please build widget with react",
    projectPath: world.proj,
    env: world.env,
  });
  assert.deepEqual(Object.keys(result).sort(), [...FROZEN_TOP_FIELDS].sort());
  assert.equal(result.routerContractVersion, 1);
  assert.equal(result.mode, "suggest");
  assert.match(result.resolutionId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof result.routerImplementationVersion, "string");
  assert.equal(result.lockStatus, "UNLOCKED");
  assert.equal(result.budgetStatus, "WITHIN_BUDGET");
  assert.equal(result.maxSkills, 3);
  assert.equal(result.maxTokens, 5000);
  assert.deepEqual(result.explicit, []);
  assert.ok(result.selected.length >= 1);
  assert.equal(result.selected[0].id, "ega/react-helper");
  assert.equal(result.selected[0].tier, "A");
  assert.ok(result.selected[0].reasons.includes("FRAMEWORK_MATCH"));
  assert.equal(result.confidence, "HIGH");
  assert.deepEqual(result.projectFingerprint.frameworks, ["nextjs", "react"]);
});

test("SPEC-004 §5.1.3: explicit skills resolve first and leave the pool", async (t) => {
  const world = await twoSkillWorld(t);
  const result = await resolveSkills({
    task: "please build widget with react",
    projectPath: world.proj,
    explicitSkills: ["ega/node-tool"],
    env: world.env,
  });
  assert.deepEqual(result.explicit.map((skill) => skill.id), ["ega/node-tool"]);
  assert.equal(result.explicit[0].tier, "E");
  assert.ok(!result.selected.some((skill) => skill.id === "ega/node-tool"));
  assert.ok(!result.candidates.some((skill) => skill.id === "ega/node-tool"));
  assert.ok(result.selected.some((skill) => skill.id === "ega/react-helper"));
});

test("SPEC-004 §5.1.17: no-match is a normal LOW result", async (t) => {
  const world = await twoSkillWorld(t);
  const result = await resolveSkills({
    task: "xylophone quantum zebras",
    projectPath: world.proj,
    env: world.env,
  });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.selected, []);
  assert.equal(result.automaticSelectedTokens, 0);
});

test("SPEC-004 §5.1.1: locked fixtures scope versions and status", async (t) => {
  const world = await twoSkillWorld(t);
  const locked = new Map([["ega/react-helper", currentHash(world.env, "ega/react-helper")]]);
  const result = await resolveSkills({
    task: "please build widget with react",
    projectPath: world.proj,
    policy: { lockedVersions: locked },
    env: world.env,
  });
  assert.equal(result.lockStatus, "LOCKED");
  assert.ok(result.selected.some((skill) => skill.id === "ega/react-helper"));
  assert.ok(result.selected[0].reasons.includes("LOCKED_VERSION"));
  const blocked = await resolveSkills({
    task: "run chore",
    projectPath: world.proj,
    explicitSkills: ["ega/node-tool"],
    policy: { lockedVersions: locked },
    env: world.env,
  });
  assert.deepEqual(blocked.explicit, []);
  assert.deepEqual(blocked.rejected.map((skill) => skill.reasons), [["VERSION_NOT_LOCKED"]]);
});

test("SPEC-004 §5.1.7: request budget overrides are effective and reported", async (t) => {
  const world = await twoSkillWorld(t);
  const one = await resolveSkills({
    task: "build widget and run chore",
    projectPath: world.proj,
    budget: { maxSkills: 1 },
    env: world.env,
  });
  assert.equal(one.maxSkills, 1);
  assert.ok(one.selected.length <= 1);
  const tokens = await resolveSkills({
    task: "build widget and run chore",
    projectPath: world.proj,
    budget: { maxTokens: 10 },
    env: world.env,
  });
  assert.equal(tokens.maxTokens, 10);
  assert.ok(tokens.automaticSelectedTokens <= 10);
});

test("SPEC-004 §5.1.19: no instruction bodies enter resolve metadata", async (t) => {
  const world = await twoSkillWorld(t);
  const result = await resolveSkills({
    task: "please build widget with react",
    projectPath: world.proj,
    env: world.env,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("Guidance text"));
  assert.ok(!serialized.includes("uniquely marker"));
});

test("SPEC-004 §5.1.19: automatic rejected diagnostics cap at three", async (t) => {
  const world = await isolatedWorld(t);
  for (const ns of ["nsa", "nsb", "nsc", "nsd"]) {
    await writeSkill(world.src, "denied", { egaYaml: yaml() });
    const registry = openRegistry({ env: world.env });
    try {
      await importSkills(registry, { path: join(world.src, "denied"), namespace: ns });
    } finally {
      registry.close();
    }
    await rm(join(world.src, "denied"), { recursive: true, force: true });
  }
  const result = await resolveSkills({
    task: "build anything",
    projectPath: world.proj,
    policy: { deniedNamespaces: ["nsa", "nsb", "nsc", "nsd"] },
    env: world.env,
  });
  assert.ok(result.rejected.length <= 3);
  assert.ok(result.rejected.every((skill) => skill.reasons.includes("NAMESPACE_DENIED")));
});

test("SPEC-004 §5.1.19: candidates cap at three in rank order", async (t) => {
  const world = await isolatedWorld(t);
  for (let i = 0; i < 5; i += 1) {
    await writeSkill(join(world.src, "lex"), `lex-${i}`, {
      description: `lexical words ${i}`,
      egaYaml: yaml(),
    });
  }
  await importAll(world.env, join(world.src, "lex"));
  const result = await resolveSkills({ task: "lexical matching words", projectPath: world.proj, env: world.env });
  assert.ok(result.candidates.length <= 3);
});

test("SPEC-004 §5.4: same inputs resolve deterministically except resolutionId", async (t) => {
  const world = await twoSkillWorld(t);
  const input = { task: "please build widget with react", projectPath: world.proj, env: world.env };
  const first = await resolveSkills(input);
  const second = await resolveSkills(input);
  const { resolutionId: _a, ...restA } = first;
  const { resolutionId: _b, ...restB } = second;
  assert.deepEqual(restB, restA);
  assert.notEqual(first.resolutionId, second.resolutionId);
});

// SPEC-004 §5.4 benchmark + §5.1.19 metadata target.

test("SPEC-004 §5.4: warm 100-skill resolve trends toward p95 <= 300 ms", async (t) => {
  const world = await isolatedWorld(t);
  for (let i = 0; i < 100; i += 1) {
    await writeSkill(join(world.src, "bench"), `bench-${String(i).padStart(3, "0")}`, {
      egaYaml: yaml(`frameworks: [react]\ntriggers: [shared chore]\n`),
    });
  }
  await importAll(world.env, join(world.src, "bench"));
  await writeFile(join(world.proj, "package.json"), JSON.stringify({ dependencies: { react: "1" } }));
  const input = { task: "shared chore with react", projectPath: world.proj, env: world.env };
  const first = await resolveSkills(input);
  assert.ok(first.selected.length > 0);
  const samples = [];
  for (let i = 0; i < 30; i += 1) {
    const start = performance.now();
    await resolveSkills(input);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  console.log(`ℹ warm resolve p95 over 30 runs: ${p95.toFixed(1)} ms`);
  assert.ok(p95 <= 300, `warm resolve p95 was ${p95.toFixed(1)} ms`);
}, { timeout: 180000 });

test("SPEC-004 §5.1.19: selection metadata trends under 500 ega-o200k-v1 tokens", async (t) => {
  const world = await twoSkillWorld(t);
  const result = await resolveSkills({
    task: "please build widget with react",
    projectPath: world.proj,
    env: world.env,
  });
  const schema = await import("../../packages/schema/dist/index.js");
  const metadata = JSON.stringify({ selected: result.selected, candidates: result.candidates, explicit: result.explicit });
  const tokens = schema.tokenEstimator.count(metadata);
  console.log(`ℹ selection metadata: ${tokens} ega-o200k-v1 tokens`);
  assert.ok(tokens < 500, `selection metadata was ${tokens} tokens`);
});

test("SPEC-004 §5.1.17 rule 5: ambiguous-workspace LOW retains candidates carrying WORKSPACE_AMBIGUOUS", async (t) => {
  // Regression: the resolver re-mapped confidence rows back to pre-confidence
  // composition rows, silently dropping the appended explanatory reason.
  const { env, src, proj } = await isolatedWorld(t);
  await writeSkill(src, "debug-helper", {
    description: "Debug helper skill",
    body: "# Debug Helper\n\nFix this flaky crash with systematic steps.\n",
    egaYaml: "schema_version: 1\ntriggers: [flaky crash]\n",
  });
  await importAll(env, src);
  // Workspace root with no framework deps of its own: no deterministic app.
  await writeFile(
    join(proj, "package.json"),
    JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
  );
  await mkdir(join(proj, "apps", "web"), { recursive: true });
  await writeFile(
    join(proj, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", dependencies: { next: "14.0.0", react: "18.0.0" } }),
  );
  const result = await resolveSkills({
    task: "fix this flaky crash now",
    projectPath: proj,
    env,
  });
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.selected.map((skill) => skill.id), []);
  const candidate = result.candidates.find((skill) => skill.id === "ega/debug-helper");
  assert.ok(candidate, "evidence-bearing skill retained as candidate");
  assert.ok(
    candidate.reasons.includes("WORKSPACE_AMBIGUOUS"),
    `candidate reasons carry WORKSPACE_AMBIGUOUS: ${JSON.stringify(candidate.reasons)}`,
  );
});
