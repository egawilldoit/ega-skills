// MCP `resolve` tool tests (SPEC-006 §5.1.5, EGA-590).
//
// Thin-adapter behavior over production-imported fixture skills: snake_case
// externals, metadata-only outputs, frozen input errors, no-match LOW
// results, determinism (ignoring only resolutionId), offline operation,
// read-only registry behavior, and a stdio wire test.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { runResolveTool } from "../../packages/mcp/dist/resolve.js";
import {
  getCurrentVersionHash,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");
const PROTOCOL_VERSION = "2025-11-25";

const tempRoots = new Set();
async function makeTempRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `ega-mcp-resolve-${name}-`));
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

function expectInputInvalid(promise) {
  return promise.then(
    () => assert.fail("expected E_MCP_INPUT_INVALID but the call succeeded"),
    (error) => {
      assert.ok(error instanceof McpContextError, `expected McpContextError, got ${error}`);
      assert.equal(error.code, "E_MCP_INPUT_INVALID");
    },
  );
}

function assertSnakeContainer(output) {
  for (const key of [
    "resolution_id",
    "router_contract_version",
    "router_implementation_version",
    "mode",
    "confidence",
    "project_fingerprint",
    "explicit",
    "selected",
    "candidates",
    "rejected",
    "automatic_selected_tokens",
    "explicit_selected_tokens",
    "max_tokens",
    "max_skills",
    "lock_status",
    "budget_status",
  ]) {
    assert.ok(key in output, `missing snake_case field: ${key}`);
  }
  assert.ok(!("resolutionId" in output), "no camelCase leakage: resolutionId");
  for (const row of [...output.explicit, ...output.selected, ...output.candidates]) {
    assert.ok(!("versionHash" in row), "no camelCase leakage in rows");
    assert.ok(!("recommendedContentLevel" in row), "no camelCase leakage in rows");
  }
  assert.ok(["HIGH", "MEDIUM", "LOW"].includes(output.confidence));
  assert.ok(["LOCKED", "UNLOCKED"].includes(output.lock_status));
  const fp = output.project_fingerprint;
  assert.equal(typeof fp.project_path, "string");
  assert.ok(!("projectPath" in fp), "no camelCase leakage in fingerprint");
}

// --- Behavior --------------------------------------------------------------------

test("resolve: explicit skill resolves with the exact snake_case container", async (t) => {
  const { home, hashes } = await setupHome(t, [
    ["alpha", {}],
    ["beta", {}],
  ]);
  const project = await makeProject();
  const result = await runResolveTool(
    { task: "build thing now", explicit_skills: ["ega/alpha"] },
    ctxFor(project, home),
  );
  assert.equal(result.isError, false);
  const output = result.structuredContent;
  assertSnakeContainer(output);
  assert.equal(output.explicit.length, 1);
  assert.equal(output.explicit[0].id, "ega/alpha");
  assert.equal(output.explicit[0].version_hash, hashes.alpha);
  assert.equal(typeof output.explicit[0].recommended_content_tokens, "number");
  assert.equal(output.lock_status, "UNLOCKED");
});

test("resolve: task-only call returns a valid container without bodies", async (t) => {
  const marker = "uniquely-marked-resolve-body-RES-9902";
  const { home } = await setupHome(t, [
    ["alpha", { body: `# alpha\n\n${marker} lives only in the body.\n` }],
    ["beta", {}],
  ]);
  const project = await makeProject();
  const result = await runResolveTool({ task: "build thing now" }, ctxFor(project, home));
  assert.equal(result.isError, false);
  assertSnakeContainer(result.structuredContent);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(marker), "instruction bodies never appear in resolve output");
  for (const part of result.content) {
    assert.ok(!part.text.includes(marker), "text fallback stays compact");
  }
});

test("resolve: no-match routing is a normal LOW-confidence result", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject({
    ".egaskills.yaml": "schema_version: 1\nskills:\n  deny: [ega/alpha]\n",
  });
  const result = await runResolveTool(
    { task: "build thing now" },
    ctxFor(project, home),
  );
  assert.equal(result.isError, false, "no-match is not an MCP error");
  assert.equal(result.structuredContent.confidence, "LOW");
  assert.deepEqual(result.structuredContent.selected, []);
});

test("resolve: malformed input maps to E_MCP_INPUT_INVALID", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  await expectInputInvalid(runResolveTool({}, ctx));
  await expectInputInvalid(runResolveTool({ task: "" }, ctx));
  await expectInputInvalid(runResolveTool({ task: "   " }, ctx));
  await expectInputInvalid(runResolveTool({ task: 42 }, ctx));
  await expectInputInvalid(runResolveTool({ task: "x".repeat(16385) }, ctx));
  await expectInputInvalid(runResolveTool({ task: "build", max_skills: 0 }, ctx));
  await expectInputInvalid(runResolveTool({ task: "build", max_skills: 4 }, ctx));
  await expectInputInvalid(runResolveTool({ task: "build", max_tokens: 0 }, ctx));
  await expectInputInvalid(runResolveTool({ task: "build", max_tokens: 1000001 }, ctx));
  await expectInputInvalid(runResolveTool({ task: "build", explicit_skills: "ega/alpha" }, ctx));
  // Valid boundaries succeed.
  await runResolveTool({ task: "build", max_skills: 1, max_tokens: 1 }, ctx);
});

test("resolve: unknown explicit reference surfaces E_SKILL_NOT_FOUND verbatim", async (t) => {
  const { home } = await setupHome(t, [["alpha", {}]]);
  const project = await makeProject();
  await runResolveTool({ task: "build", explicit_skills: ["ega/ghost"] }, ctxFor(project, home)).then(
    () => assert.fail("expected E_SKILL_NOT_FOUND"),
    (error) => {
      assert.ok(error instanceof McpContextError);
      assert.equal(error.code, "E_SKILL_NOT_FOUND");
    },
  );
});

test("resolve: repeated calls match except resolution_id, registry untouched", async (t) => {
  const { home } = await setupHome(t, [
    ["alpha", {}],
    ["beta", {}],
  ]);
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  const args = { task: "build thing now", explicit_skills: ["ega/alpha"] };
  const first = await runResolveTool(args, ctx);
  const second = await runResolveTool(args, ctx);
  const strip = (result) => {
    const copy = JSON.parse(JSON.stringify(result.structuredContent));
    delete copy.resolution_id;
    return copy;
  };
  assert.deepEqual(strip(second), strip(first), "resolve is deterministic ignoring resolution_id");
  const dbPath = join(home, "registry.sqlite");
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  await runResolveTool({ task: "build thing now" }, ctx);
  assert.equal(
    createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
    before,
    "resolve never mutates the database file",
  );
});

test("resolve: missing registry fails with E_REGISTRY_UNAVAILABLE", async (t) => {
  const home = join(await makeTempRoot("no-home"), "absent");
  const project = await makeProject();
  const ctx = ctxFor(project, home);
  await runResolveTool({ task: "build" }, ctx).then(
    () => assert.fail("expected E_REGISTRY_UNAVAILABLE"),
    (error) => {
      assert.ok(error instanceof McpContextError);
      assert.equal(error.code, "E_REGISTRY_UNAVAILABLE");
    },
  );
});

// --- Wire protocol --------------------------------------------------------------------

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
      }, 20000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  return { send, request };
}

test("resolve (wire): task resolution over stdio", async (t) => {
  const { home, hashes } = await setupHome(t, [["wired", { description: "wired resolve target" }]]);
  const project = await makeProject();
  const { send, request } = launch(t, envFor(home));
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "resolve-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const call = await request("wire-resolve", "tools/call", {
    name: "resolve",
    arguments: {
      task: "build thing now",
      project_path: project,
      explicit_skills: ["ega/wired"],
    },
  });
  assert.equal(call.result.isError, false, `resolve succeeds: ${JSON.stringify(call.result).slice(0, 300)}`);
  const output = call.result.structuredContent?.result ?? call.result.structuredContent;
  assert.equal(typeof output.resolution_id, "string");
  assert.equal(output.explicit[0].id, "ega/wired");
  assert.equal(output.explicit[0].version_hash, hashes.wired);
});
