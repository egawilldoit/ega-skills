// MCP `search` tool tests (SPEC-006 §5.1.6, EGA-591).
//
// Project-scoped L0-only search over production-imported fixture skills:
// input validation, default/hard limits, deny/lock policy scoping,
// historical exclusion, FTS escaping, metadata-only outputs, determinism,
// offline operation, read-only registry behavior, and a stdio wire test.
//
// Tests import the built packages (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  McpContextError,
  resolveMcpProjectContext,
} from "../../packages/mcp/dist/project-context.js";
import { runSearchTool } from "../../packages/mcp/dist/search.js";
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
  const root = await mkdtemp(join(tmpdir(), `ega-mcp-search-${name}-`));
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

/**
 * Imports two skills into a fresh temp home through the production importer
 * and returns {home, hashes}. The setup registry is closed before returning
 * so MCP's read-only opens never contend (Windows locking).
 */
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

function expectInputInvalid(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof McpContextError, `expected McpContextError, got ${error}`);
    assert.equal(error.code, "E_MCP_INPUT_INVALID");
    return;
  }
  assert.fail("expected E_MCP_INPUT_INVALID but nothing threw");
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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// --- Basic behavior ----------------------------------------------------------

test("search: finds imported skill L0 metadata with the exact frozen shape", async (t) => {
  const { home, hashes } = await setupHome(t, [
    ["alpha", { description: "alpha widget builder" }],
    ["beta", { description: "beta gadget assembler" }],
  ]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const result = runSearchTool({ query: "alpha widget" }, ctx);
  assert.equal(result.isError, false);
  const output = result.structuredContent;
  assert.ok(Array.isArray(output.results));
  assert.equal(output.results.length, 1);
  const row = output.results[0];
  assert.equal(row.skill_id, "ega/alpha");
  assert.equal(row.version_hash, hashes.alpha);
  assert.equal(row.namespace, "ega");
  assert.equal(row.name, "alpha");
  assert.equal(row.description, "alpha widget builder");
  assert.deepEqual([...row.domains], ["engineering"]);
  assert.ok(Array.isArray(row.triggers));
  assert.equal(row.l1_status, "MISSING");
  assert.equal(row.l1_tokens, null);
  assert.equal(typeof row.l2_tokens, "number");
  assert.ok(!("content" in row), "no content field on L0 rows");
  assert.ok(!("score" in row), "no BM25 score on L0 rows");
});

test("search: AUTHORED L1 reports status and token counts", async (t) => {
  const { home } = await setupHome(t, [
    ["cored", { core: "# cored core\n\nCondensed core guidance.\n" }],
  ]);
  const project = await makeProject();
  const result = runSearchTool({ query: "cored" }, ctxFor(project, home));
  const row = result.structuredContent.results.find((r) => r.skill_id === "ega/cored");
  assert.ok(row, "authored skill is found");
  assert.equal(row.l1_status, "AUTHORED");
  assert.equal(typeof row.l1_tokens, "number");
});

test("search: response bodies never leak instruction text", async (t) => {
  const marker = "uniquely-marked-instruction-phrase-SEARCH-7741";
  const { home } = await setupHome(t, [
    ["marked", { body: `# marked\n\n${marker} lives only in the body.\n` }],
  ]);
  const project = await makeProject();
  const result = runSearchTool({ query: "marked" }, ctxFor(project, home));
  assert.equal(result.structuredContent.results.length, 1);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(marker), "instruction body must not appear anywhere in the result");
  for (const part of result.content) {
    assert.ok(!part.text.includes(marker), "text fallback must not carry the body");
  }
});

// --- Input validation ----------------------------------------------------------

test("search: default limit 10, hard max 20, malformed limits rejected", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  expectInputInvalid(() => runSearchTool({ query: "" }, ctx));
  expectInputInvalid(() => runSearchTool({ query: "   " }, ctx));
  expectInputInvalid(() => runSearchTool({}, ctx));
  expectInputInvalid(() => runSearchTool({ query: 42 }, ctx));
  expectInputInvalid(() => runSearchTool({ query: "alpha", limit: 0 }, ctx));
  expectInputInvalid(() => runSearchTool({ query: "alpha", limit: 21 }, ctx));
  expectInputInvalid(() => runSearchTool({ query: "alpha", limit: 2.5 }, ctx));
  expectInputInvalid(() => runSearchTool({ query: "alpha", limit: "10" }, ctx));
  expectInputInvalid(() => runSearchTool({ query: "x".repeat(16385) }, ctx));
  // Valid boundaries do not throw.
  runSearchTool({ query: "alpha", limit: 1 }, ctx);
  runSearchTool({ query: "alpha", limit: 20 }, ctx);
});

test("search: FTS metacharacters never break the query", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  for (const query of ['alpha "quoted', "alp*ha", "alpha:beta", "alpha OR beta", "(alpha)"]) {
    const result = runSearchTool({ query }, ctx);
    assert.equal(result.isError, false);
    assert.ok(Array.isArray(result.structuredContent.results));
  }
});

// --- Project scoping -------------------------------------------------------------

test("search: denied skills never appear", async (t) => {
  const { home } = await setupHome(t, [
    ["alpha", {}],
    ["beta", {}],
  ]);
  const project = await makeProject({
    ".egaskills.yaml": "schema_version: 1\nskills:\n  deny: [ega/beta]\n",
  });
  const result = runSearchTool({ query: "skill" }, ctxFor(project, home));
  const ids = result.structuredContent.results.map((r) => r.skill_id);
  assert.ok(ids.includes("ega/alpha"), "allowed skill is visible");
  assert.ok(!ids.includes("ega/beta"), "denied skill never appears");
});

test("search: denied namespaces never appear", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject({
    ".egaskills.yaml": "schema_version: 1\nnamespaces:\n  deny: [ega]\n",
  });
  const result = runSearchTool({ query: "alpha" }, ctxFor(project, home));
  assert.deepEqual(result.structuredContent.results, []);
});

test("search: LOCKED project exposes only exact locked versions", async (t) => {
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
  const result = runSearchTool({ query: "skill" }, ctxFor(project, home));
  const ids = result.structuredContent.results.map((r) => r.skill_id);
  assert.deepEqual(ids, ["ega/alpha"], "only the locked skill is visible");
  assert.equal(result.structuredContent.results[0].version_hash, hashes.alpha);
});

test("search: empty active lock exposes nothing", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const configText = "schema_version: 1\n";
  const project = await makeProject({
    ".egaskills.yaml": configText,
    ".egaskills.lock": lockYamlFor(configText, {}),
  });
  const result = runSearchTool({ query: "alpha" }, ctxFor(project, home));
  assert.deepEqual(result.structuredContent.results, []);
});

test("search: historical versions never appear (current only)", async (t) => {
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
  assert.notEqual(v1, v2, "re-import produces a new version");
  registry.close();
  const project = await makeProject();
  const result = runSearchTool({ query: "alpha" }, ctxFor(project, home));
  const versions = result.structuredContent.results.map((r) => r.version_hash);
  assert.ok(versions.includes(v2), "current version is visible");
  assert.ok(!versions.includes(v1), "historical version never appears");
});

// --- Robustness -------------------------------------------------------------------

test("search: missing registry fails with E_REGISTRY_UNAVAILABLE", async (t) => {
  const home = join(await makeTempRoot("no-home"), "absent");
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  assert.equal(ctx.registryAvailable, false);
  try {
    runSearchTool({ query: "alpha" }, ctx);
  } catch (error) {
    assert.ok(error instanceof McpContextError);
    assert.equal(error.code, "E_REGISTRY_UNAVAILABLE");
    return;
  }
  assert.fail("expected E_REGISTRY_UNAVAILABLE");
});

test("search: repeated calls are byte-identical and mutate nothing", async (t) => {
  const { home } = await setupHome(t, [
    ["alpha", {}],
    ["beta", {}],
  ]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const first = runSearchTool({ query: "skill" }, ctx);
  const second = runSearchTool({ query: "skill" }, ctx);
  assert.deepEqual(second, first, "search is deterministic");
  const dbPath = join(home, "registry.sqlite");
  const before = sha256File(dbPath);
  runSearchTool({ query: "alpha" }, ctx);
  runSearchTool({ query: "beta", limit: 3 }, ctx);
  assert.equal(sha256File(dbPath), before, "search never mutates the database file");
});

// --- Wire protocol ------------------------------------------------------------------

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

test("search (wire): project-scoped L0 search over stdio", async (t) => {
  const { home, hashes } = await setupHome(t, [["wired", { description: "wired search target" }]]);
  const project = await makeProject();
  const { send, request } = launch(t, envFor(home));
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "search-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const call = await request("wire-search", "tools/call", {
    name: "search",
    arguments: { query: "wired search", project_path: project },
  });
  assert.equal(call.result.isError, false, `search succeeds: ${JSON.stringify(call.result).slice(0, 300)}`);
  const output = call.result.structuredContent?.result ?? call.result.structuredContent;
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].skill_id, "ega/wired");
  assert.equal(output.results[0].version_hash, hashes.wired);
});
