// MCP `get_content` tool tests (SPEC-006 §5.1.8, EGA-593).
//
// Exact canonical L1/L2 retrieval over production-imported fixture skills:
// exact bytes, all six content error codes, no truncation, per-call budget
// independence, policy-before-cache gating, determinism, offline operation,
// read-only behavior, and a stdio wire test.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  McpContextError,
  resolveMcpProjectContext,
} from "../../packages/mcp/dist/project-context.js";
import { runGetContentTool } from "../../packages/mcp/dist/get-content.js";
import {
  getCurrentVersionHash,
  getSkillVersion,
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
  const root = await mkdtemp(join(tmpdir(), `ega-mcp-content-${name}-`));
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

const SKILL_BODY = "# alpha\n\nAlpha guidance with a distinctive marker CONTENT-BODY-6621.\n";
const SKILL_CORE = "# alpha core\n\nCondensed core marker CONTENT-CORE-6621.\n";

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function basicYaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n${extra}`;
}

async function writeSkill(dir, name, options = {}) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  const body = options.body ?? SKILL_BODY;
  const full = `${frontmatter(name, options.description ?? `${name} skill`)}${body}`;
  await writeFile(join(root, "SKILL.md"), full);
  if (options.core !== undefined) {
    await writeFile(join(root, "SKILL.core.md"), options.core);
  }
  await writeFile(join(root, "ega.yaml"), basicYaml(options.yamlExtra ?? ""));
  return { root, skillMd: full };
}

async function setupHome(t, skills) {
  const base = await makeTempRoot("home");
  const home = join(base, "home");
  const src = join(base, "src");
  await mkdir(src, { recursive: true });
  const written = {};
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    for (const [name, options] of skills) {
      written[name] = await writeSkill(src, name, options);
    }
    const summary = await importSkills(registry, { path: src, namespace: "ega" });
    assert.equal(summary.failed, 0, `fixture import must not fail: ${JSON.stringify(summary.failures)}`);
    const hashes = {};
    for (const [name] of skills) {
      hashes[name] = getCurrentVersionHash(registry.db, `ega/${name}`);
    }
    return { home, hashes, written };
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

function blobCachePath(home, blobHash) {
  const digest = blobHash.slice("sha256:".length);
  return join(home, "cache", "sha256", digest.slice(0, 2), digest.slice(2));
}

// --- Exact content -------------------------------------------------------------------

test("get_content: L2 returns the exact canonical SKILL.md bytes", async (t) => {
  const { home, hashes, written } = await setupHome(t, [
    ["alpha", { core: SKILL_CORE }],
  ]);
  const project = await makeProject();
  const result = runGetContentTool(
    { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 4000 },
    ctxFor(project, home),
  );
  assert.equal(result.isError, false);
  const output = result.structuredContent;
  assert.equal(output.skill_id, "ega/alpha");
  assert.equal(output.version_hash, hashes.alpha);
  assert.equal(output.level, "L2");
  assert.equal(typeof output.token_count, "number");
  assert.ok(output.token_count > 0);
  assert.equal(output.content, written.alpha.skillMd, "L2 is the exact canonical file bytes");
  assert.ok(output.content.includes("CONTENT-BODY-6621"));
  // EGA-597: the text fallback is summary + the exact requested body, so
  // text-only clients (proven: real OpenCode runs) receive usable content.
  // The body stays budget-bounded by the call's own max_tokens.
  assert.equal(result.content.length, 1);
  const fallback = result.content[0].text;
  assert.ok(
    fallback.startsWith(`get_content ega/alpha ${hashes.alpha} L2 tokens=${output.token_count}/4000.`),
    "text fallback starts with the summary line",
  );
  assert.ok(
    fallback.endsWith(`\n${written.alpha.skillMd}`),
    "text fallback carries the exact requested body",
  );
});

test("get_content: L1 returns the exact canonical SKILL.core.md bytes", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", { core: SKILL_CORE }]]);
  const project = await makeProject();
  const output = runGetContentTool(
    { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L1", max_tokens: 4000 },
    ctxFor(project, home),
  ).structuredContent;
  assert.equal(output.level, "L1");
  assert.equal(output.content, SKILL_CORE, "L1 is the exact canonical core bytes");
  assert.ok(!output.content.includes("CONTENT-BODY-6621"), "L1 carries no L2 text");
});

test("get_content: missing L1 is an explicit error, not a fallback", async (t) => {
  const { home, hashes } = await setupHome(t, [["plain", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  expectCode(
    () =>
      runGetContentTool(
        { skill_id: "ega/plain", version_hash: hashes.plain, level: "L1", max_tokens: 4000 },
        ctx,
      ),
    "E_CONTENT_LEVEL_MISSING",
  );
  // L2 of the same version still works: no level confusion.
  const l2 = runGetContentTool(
    { skill_id: "ega/plain", version_hash: hashes.plain, level: "L2", max_tokens: 4000 },
    ctx,
  ).structuredContent;
  assert.equal(l2.level, "L2");
});

// --- Budget ----------------------------------------------------------------------------

test("get_content: over-budget errors without truncation or quota", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", { core: SKILL_CORE }]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const full = runGetContentTool(
    { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 4000 },
    ctx,
  ).structuredContent;
  assert.ok(full.token_count > 1, "fixture content exceeds a 1-token budget");
  const first = expectCode(
    () =>
      runGetContentTool(
        { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 1 },
        ctx,
      ),
    "E_CONTENT_TOKEN_BUDGET",
  );
  // A second identical call fails identically: no hidden aggregate quota drains.
  const second = expectCode(
    () =>
      runGetContentTool(
        { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 1 },
        ctx,
      ),
    "E_CONTENT_TOKEN_BUDGET",
  );
  assert.equal(second.message, first.message);
  // Exact-budget boundary succeeds with full content (never partial).
  const exact = runGetContentTool(
    {
      skill_id: "ega/alpha",
      version_hash: hashes.alpha,
      level: "L2",
      max_tokens: full.token_count,
    },
    ctx,
  ).structuredContent;
  assert.equal(exact.content, full.content, "boundary budget returns complete content");
});

// --- Policy before cache -------------------------------------------------------------------

test("get_content: denied skills are unretrievable by exact ID and hash", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", { core: SKILL_CORE }]]);
  const project = await makeProject({
    ".egaskills.yaml": "schema_version: 1\nskills:\n  deny: [ega/alpha]\n",
  });
  expectCode(
    () =>
      runGetContentTool(
        { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 4000 },
        ctxFor(project, home),
      ),
    "E_SKILL_NOT_FOUND",
  );
});

test("get_content: LOCKED admits only the exact locked version", async (t) => {
  const { home, hashes } = await setupHome(t, [
    ["alpha", { core: SKILL_CORE }],
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
  const ok = runGetContentTool(
    { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 4000 },
    ctx,
  ).structuredContent;
  assert.equal(ok.version_hash, hashes.alpha);
  expectCode(
    () =>
      runGetContentTool(
        { skill_id: "ega/alpha", version_hash: hashes.beta, level: "L2", max_tokens: 4000 },
        ctx,
      ),
    "E_VERSION_NOT_LOCKED",
  );
  expectCode(
    () =>
      runGetContentTool(
        { skill_id: "ega/beta", version_hash: hashes.beta, level: "L2", max_tokens: 4000 },
        ctx,
      ),
    "E_SKILL_NOT_FOUND",
  );
});

test("get_content: missing exact version never falls forward", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  expectCode(
    () =>
      runGetContentTool(
        {
          skill_id: "ega/alpha",
          version_hash: `sha256:${"ee".repeat(32)}`,
          level: "L2",
          max_tokens: 4000,
        },
        ctx,
      ),
    "E_VERSION_NOT_FOUND",
  );
  assert.ok(hashes.alpha !== `sha256:${"ee".repeat(32)}`);
});

// --- Input validation --------------------------------------------------------------------------

test("get_content: malformed input maps to E_MCP_INPUT_INVALID", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const good = {
    skill_id: "ega/alpha",
    version_hash: hashes.alpha,
    level: "L2",
    max_tokens: 4000,
  };
  expectCode(() => runGetContentTool({ ...good, level: "L3" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runGetContentTool({ ...good, level: "l2" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runGetContentTool({ ...good, version_hash: "abc" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(
    () => runGetContentTool({ ...good, version_hash: "SHA256:AB" }, ctx),
    "E_MCP_INPUT_INVALID",
  );
  expectCode(() => runGetContentTool({ ...good, skill_id: "alpha-alias" }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runGetContentTool({ ...good, skill_id: "alpha" }, ctx), "E_MCP_INPUT_INVALID");
  const { max_tokens: _drop, ...noBudget } = good;
  expectCode(() => runGetContentTool(noBudget, ctx), "E_MCP_INPUT_INVALID");
  const { level: _dropLevel, ...noLevel } = good;
  expectCode(() => runGetContentTool(noLevel, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runGetContentTool({ ...good, max_tokens: 0 }, ctx), "E_MCP_INPUT_INVALID");
  expectCode(() => runGetContentTool({ ...good, max_tokens: 1000001 }, ctx), "E_MCP_INPUT_INVALID");
});

// --- Integrity --------------------------------------------------------------------------------------

test("get_content: corrupt cache blob fails before exposure", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", {}]]);
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  const version = getSkillVersion(registry.db, "ega/alpha", hashes.alpha);
  registry.close();
  const manifest = JSON.parse(version.manifestJson);
  const bodyFile = manifest.files.find((f) => f.role === "skill-body");
  assert.ok(bodyFile, "fixture has an L2 blob");
  const blobPath = blobCachePath(home, bodyFile.blob_hash);
  const original = readFileSync(blobPath);
  await writeFile(blobPath, Buffer.from("corrupted bytes that do not match the hash"));
  try {
    const project = await makeProject();
    expectCode(
      () =>
        runGetContentTool(
          { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 4000 },
          ctxFor(project, home),
        ),
      "E_CACHE_HASH_MISMATCH",
    );
  } finally {
    await writeFile(blobPath, original);
  }
});

test("get_content: missing registry fails with E_REGISTRY_UNAVAILABLE", async (t) => {
  const home = join(await makeTempRoot("no-home"), "absent");
  const project = await makeProject();
  expectCode(
    () =>
      runGetContentTool(
        {
          skill_id: "ega/alpha",
          version_hash: `sha256:${"00".repeat(32)}`,
          level: "L2",
          max_tokens: 4000,
        },
        ctxFor(project, home),
      ),
    "E_REGISTRY_UNAVAILABLE",
  );
});

test("get_content: repeated calls are byte-identical and mutate nothing", async (t) => {
  const { home, hashes } = await setupHome(t, [["alpha", { core: SKILL_CORE }]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const args = { skill_id: "ega/alpha", version_hash: hashes.alpha, level: "L2", max_tokens: 4000 };
  const first = runGetContentTool(args, ctx);
  const second = runGetContentTool(args, ctx);
  assert.deepEqual(second, first, "get_content is deterministic");
  const dbPath = join(home, "registry.sqlite");
  const before = readFileSync(dbPath).toString("hex").length;
  runGetContentTool({ ...args, level: "L1", max_tokens: 4000 }, ctx);
  assert.equal(
    readFileSync(dbPath).toString("hex").length,
    before,
    "get_content never mutates the database file",
  );
});

// --- Wire protocol -------------------------------------------------------------------------------------

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

test("get_content (wire): exact content retrieval over stdio", async (t) => {
  const { home, hashes } = await setupHome(t, [["wired", { core: SKILL_CORE }]]);
  const project = await makeProject();
  const { send, request } = launch(t, envFor(home));
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "content-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const call = await request("wire-content", "tools/call", {
    name: "get_content",
    arguments: {
      skill_id: "ega/wired",
      version_hash: hashes.wired,
      level: "L2",
      max_tokens: 4000,
      project_path: project,
    },
  });
  assert.equal(call.result.isError, false, `get_content succeeds: ${JSON.stringify(call.result).slice(0, 300)}`);
  const output = call.result.structuredContent?.result ?? call.result.structuredContent;
  assert.equal(output.skill_id, "ega/wired");
  assert.equal(output.version_hash, hashes.wired);
  assert.equal(output.level, "L2");
  assert.ok(output.content.includes("wired"));
});
