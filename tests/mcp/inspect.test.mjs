// MCP `inspect` tool tests (SPEC-006 §5.1.7, EGA-592).
//
// Metadata/provenance/version inspection over production-imported fixture
// skills: canonical-ID gating, no-oracle deny behavior, exact locked/current/
// historical version selection with no fallback, frozen output shape without
// bodies, determinism, offline operation, and a stdio wire test.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpContextError } from "../../packages/mcp/dist/project-context.js";
import {
  runInspectTool,
  toInspectErrorResult,
} from "../../packages/mcp/dist/inspect.js";
import { resolveMcpProjectContext } from "../../packages/mcp/dist/project-context.js";
import {
  getCurrentVersionHash,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";
import {
  hashNormalizedConfig,
  parseProjectConfig,
} from "../../packages/project/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");
const PROTOCOL_VERSION = "2025-11-25";

const tempRoots = new Set();
async function makeTempRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `ega-mcp-inspect-${name}-`));
  tempRoots.add(root);
  return root;
}
test.after(async () => {
  for (const root of tempRoots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tempRoots.clear();
});

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function basicYaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n${extra}`;
}

async function writeSkill(dir, name, options = {}) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name}.\n`;
  await writeFile(
    join(root, "SKILL.md"),
    `${frontmatter(name, options.description ?? `${name} skill`)}${body}`,
  );
  if (options.core !== undefined) {
    await writeFile(join(root, "SKILL.core.md"), options.core);
  }
  await writeFile(join(root, "ega.yaml"), basicYaml(options.yamlExtra ?? ""));
  return root;
}

async function setupHome(t, skills) {
  const base = await makeTempRoot("home");
  const home = join(base, "home");
  const src = join(base, "src");
  await mkdir(src, { recursive: true });
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    for (const [name, options] of skills) {
      await writeSkill(src, name, options);
    }
    const summary = await importSkills(registry, { path: src, namespace: "ega" });
    assert.equal(summary.failed, 0, `fixture import must not fail: ${JSON.stringify(summary.failures)}`);
    const hashes = {};
    for (const [name] of skills) {
      hashes[name] = getCurrentVersionHash(registry.db, `ega/${name}`);
    }
    return { home, hashes };
  } finally {
    registry.close();
  }
}

function envFor(home) {
  return { ...process.env, EGA_SKILLS_HOME: home };
}

async function makeProject(extraFiles = {}) {
  const project = await makeTempRoot("proj");
  for (const [rel, content] of Object.entries(extraFiles)) {
    await writeFile(join(project, rel), content);
  }
  return project;
}

function ctxFor(project, home) {
  return resolveMcpProjectContext(project, { env: envFor(home) });
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof McpContextError, `expected McpContextError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code} but nothing threw`);
}

function lockYamlFor(configText, skills) {
  const configHash = hashNormalizedConfig(parseProjectConfig(configText));
  const entries = Object.entries(skills)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, entry]) => `  ${id}:\n    name: ${entry.name}\n    version_hash: ${entry.version_hash}`);
  return (
    "generated_from:\n" +
    `  config_hash: ${configHash}\n` +
    "lockfile_version: 1\n" +
    `skills: ${entries.length === 0 ? "{}" : "\n" + entries.join("\n")}\n` +
    "token_estimator: ega-o200k-v1\n"
  );
}

// --- Basic shape ---------------------------------------------------------------

test("inspect: current version metadata with the exact frozen shape", async (t) => {
  const marker = "uniquely-marked-inspect-body-INS-5512";
  const { home, hashes } = await setupHome(t, [
    ["alpha", { body: `# alpha\n\n${marker} lives only in the body.\n`, core: "# alpha core\n\nCondensed.\n" }],
  ]);
  const project = await makeProject();
  const output = runInspectTool({ skill_id: "ega/alpha" }, ctxFor(project, home));
  assert.equal(output.skill_id, "ega/alpha");
  assert.equal(output.version_hash, hashes.alpha);
  assert.ok(["OWNED", "EXTERNAL", "UNKNOWN"].includes(output.trust_level));
  assert.equal(output.l0.skill_id, "ega/alpha");
  assert.equal(output.l0.version_hash, hashes.alpha);
  assert.equal(output.l0.namespace, "ega");
  assert.equal(output.l0.name, "alpha");
  assert.equal(output.l0.l1_status, "AUTHORED");
  assert.equal(typeof output.l0.l1_tokens, "number");
  assert.equal(typeof output.l0.l2_tokens, "number");
  assert.equal(output.token_metadata.estimator_id, "ega-o200k-v1");
  assert.equal(output.token_metadata.l1_tokens, output.l0.l1_tokens);
  assert.equal(output.token_metadata.l2_tokens, output.l0.l2_tokens);
  assert.ok(["NORMAL", "LARGE", "OVERSIZED"].includes(output.token_metadata.l2_size_class));
  assert.equal(output.manifest.skill_id, "ega/alpha");
  assert.ok(Array.isArray(output.manifest.files) && output.manifest.files.length > 0);
  assert.ok(Array.isArray(output.sources) && output.sources.length > 0);
  for (const source of output.sources) {
    assert.ok(["local", "git"].includes(source.source_type));
    assert.equal(typeof source.observed_at, "string");
  }
  const text = JSON.stringify(output);
  assert.ok(!text.includes(marker), "instruction bodies never appear in inspect output");
  assert.ok(!text.includes("Guidance"), "no body prose leaks via description-adjacent fields");
});

// --- Canonical ID gate ------------------------------------------------------------

test("inspect: aliases and bare names are malformed input", async (t) => {
  const { home } = await setupHome(t, [
    ["alpha", { yamlExtra: "aliases: [alpha-alias]\n" }],
  ]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  expectCode(() => runInspectTool({ skill_id: "alpha-alias" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runInspectTool({ skill_id: "alpha" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runInspectTool({ skill_id: "" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runInspectTool({ skill_id: "ega/" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runInspectTool({ skill_id: "EGA/alpha" }, ctx), "E_MCP_INPUT_INVALID");
});

// --- No-oracle deny behavior ----------------------------------------------------------

test("inspect: denied and unknown skills are indistinguishable", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const open = await makeProject();
  const denied = await makeProject({
    ".egaskills.yaml": "schema_version: 1\nskills:\n  deny: [ega/alpha]\n",
  });
  const deniedError = expectCode(
    () => runInspectTool({ skill_id: "ega/alpha" }, ctxFor(denied, home)),
    "E_SKILL_NOT_FOUND",
  );
  const unknownError = expectCode(
    () => runInspectTool({ skill_id: "ega/never-imported" }, ctxFor(open, home)),
    "E_SKILL_NOT_FOUND",
  );
  assert.equal(deniedError.code, unknownError.code, "no existence oracle for denied skills");
});

// --- Version selection ---------------------------------------------------------------------

test("inspect: LOCKED exposes only the exact locked version", async (t) => {
  const { home, hashes } = await setupHome(t, [
    ["alpha", {}],
    ["beta", {}],
  ]);
  const configText = "schema_version: 1\n";
  const project = await makeProject({
    ".egaskills.yaml": configText,
    ".egaskills.lock": lockYamlFor(configText, {
      "ega/alpha": { name: "alpha", version_hash: hashes.alpha },
    }),
  });
  const ctx = ctxFor(project, home);
  const output = runInspectTool({ skill_id: "ega/alpha" }, ctx);
  assert.equal(output.version_hash, hashes.alpha);
  expectCode(
    () => runInspectTool({ skill_id: "ega/alpha", version_hash: hashes.beta }, ctx),
    "E_VERSION_NOT_LOCKED",
  );
  expectCode(() => runInspectTool({ skill_id: "ega/beta" }, ctx), "E_SKILL_NOT_FOUND");
});

test("inspect: UNLOCKED explicit historical version is exact, missing is not found", async (t) => {
  const base = await makeTempRoot("hist-home");
  const home = join(base, "home");
  const src = join(base, "src");
  await mkdir(join(src, "alpha"), { recursive: true });
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  await writeFile(
    join(src, "alpha", "SKILL.md"),
    `${frontmatter("alpha", "alpha skill")}# alpha\n\nFirst revision.\n`,
  );
  await writeFile(join(src, "alpha", "ega.yaml"), basicYaml());
  await importSkills(registry, { path: join(src, "alpha"), namespace: "ega" });
  const v1 = getCurrentVersionHash(registry.db, "ega/alpha");
  await writeFile(
    join(src, "alpha", "SKILL.md"),
    `${frontmatter("alpha", "alpha skill")}# alpha\n\nSecond revision with wholly different wording.\n`,
  );
  await importSkills(registry, { path: join(src, "alpha"), namespace: "ega" });
  const v2 = getCurrentVersionHash(registry.db, "ega/alpha");
  assert.notEqual(v1, v2);
  registry.close();
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  // Omitted version resolves ONLY to current.
  assert.equal(runInspectTool({ skill_id: "ega/alpha" }, ctx).version_hash, v2);
  // Explicit historical version is exact, never forwarded.
  assert.equal(runInspectTool({ skill_id: "ega/alpha", version_hash: v1 }, ctx).version_hash, v1);
  // Missing exact version never falls forward to current.
  expectCode(
    () => runInspectTool({ skill_id: "ega/alpha", version_hash: `sha256:${"ff".repeat(32)}` }, ctx),
    "E_VERSION_NOT_FOUND",
  );
});

test("inspect: error mapping helper keeps frozen codes verbatim", () => {
  const result = toInspectErrorResult(new McpContextError("E_SKILL_NOT_FOUND", "hidden"));
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "E_SKILL_NOT_FOUND");
  assert.equal(result.structuredContent.error.tool, "inspect");
});

// --- Robustness -------------------------------------------------------------------------------

test("inspect: missing registry fails with E_REGISTRY_UNAVAILABLE", async (t) => {
  const home = join(await makeTempRoot("no-home"), "absent");
  const project = await makeProject();
  expectCode(
    () => runInspectTool({ skill_id: "ega/alpha" }, ctxFor(project, home)),
    "E_REGISTRY_UNAVAILABLE",
  );
});

test("inspect: repeated calls are byte-identical", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const first = runInspectTool({ skill_id: "ega/alpha" }, ctx);
  const second = runInspectTool({ skill_id: "ega/alpha" }, ctx);
  assert.deepEqual(second, first, "inspect is deterministic");
});

// --- Wire protocol -------------------------------------------------------------------------------

function launch(t, env) {
  const child = spawn(process.execPath, [BIN], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for response ${id} (${method})`));
      }, 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  return { send, request };
}

test("inspect (wire): metadata inspection over stdio", async (t) => {
  const { home, hashes } = await setupHome(t, [["wired", { description: "wired inspect target" }]]);
  const project = await makeProject();
  const { send, request } = launch(t, envFor(home));
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "inspect-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const call = await request("wire-inspect", "tools/call", {
    name: "inspect",
    arguments: { skill_id: "ega/wired", project_path: project },
  });
  assert.equal(call.result.isError, false, `inspect succeeds: ${JSON.stringify(call.result).slice(0, 300)}`);
  const output = call.result.structuredContent?.result ?? call.result.structuredContent;
  assert.equal(output.skill_id, "ega/wired");
  assert.equal(output.version_hash, hashes.wired);
  assert.equal(output.l0.skill_id, "ega/wired");
});
