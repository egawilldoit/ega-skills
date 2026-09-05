// MCP tool metadata + structured-output contract tests (SPEC-006 §5.1.3, EGA-594).
//
// Validates the RUNTIME-REGISTERED tools (via tools/list over stdio), not
// copied metadata: exactly four tools, frozen names/descriptions/schemas,
// token budgets measured with the production ega-o200k-v1 estimator,
// structuredContent/output-schema agreement on success, frozen isError
// envelopes on failure, compact text fallbacks, and no resources/prompts.
//
// Pinned-SDK behaviors this suite accounts for explicitly:
// - handler returns are validated against the registered outputSchema
//   ("Invalid structured content" failures); success payloads must match.
// - isError error-envelopes pass through under success output schemas.
// - on protocol 2025-11-25 the era codec wraps structuredContent in
//   `.result`; tests unwrap defensively.
// - async tool handlers are awaited by the server executor.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GET_CONTENT_OUTPUT_SCHEMA,
  RESOLVE_OUTPUT_SCHEMA,
  SEARCH_OUTPUT_SCHEMA,
  inspectOutputSchema,
} from "../../packages/mcp/dist/index.js";
import { tokenEstimator } from "../../packages/schema/dist/index.js";
import {
  getCurrentVersionHash,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");
const PROTOCOL_VERSION = "2025-11-25";

/** SPEC-006 §5.1.3.1: per-tool description budget (ega-o200k-v1 tokens). */
const DESCRIPTION_BUDGET = 40;
/** SPEC-006 §5.1.3.1: combined four-tool metadata budget. */
const COMBINED_BUDGET = 1000;

const EXPECTED_TOOLS = ["resolve", "search", "inspect", "get_content"];

/**
 * Independently-reviewed frozen truth for the complete runtime-advertised
 * descriptors (Fix A review, 2026-09-05): dumped from a live tools/list
 * response, then verified field-by-field against packages/mcp/src/server.ts
 * registrations (names, descriptions, input fields/ranges/required) and the
 * per-tool output-schema projections (resolve/search/get_content expose the
 * frozen $ref container references; inspect exposes the full projection
 * minus additionalProperties flags). The pinned SDK v2 wraps $ref outputs as
 * {properties:{result:...},required:[result]} while embedding full-object
 * outputs directly — that asymmetry is SDK behavior, frozen here as observed.
 * Not generated blindly: any descriptor drift (description text, added or
 * removed fields, schema or additionalProperties changes) fails this test by
 * design. Budget measurement still runs over the live runtime definitions.
 */
const EXPECTED_DESCRIPTORS = JSON.parse(
  readFileSync(new URL("./contract-expected-tools.json", import.meta.url), "utf8"),
);

const tempRoots = new Set();
async function makeTempRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `ega-mcp-contract-${name}-`));
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

async function listTools(t, env) {
  const { send, request } = launch(t, env);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "contract-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const list = await request(2, "tools/list", {});
  return { send, request, tools: list.result.tools };
}

function unwrap(call) {
  return call.result.structuredContent?.result ?? call.result.structuredContent;
}

function assertValidates(schema, payload, what) {
  const checked = schema["~standard"].validate(payload);
  assert.ok(
    !("issues" in checked),
    `${what} must validate against its output schema: ${JSON.stringify(checked.issues ?? checked).slice(0, 300)}`,
  );
}

// --- Micro A: registered metadata --------------------------------------------------

test("contract: exactly the four V1 tools are registered, in order", async (t) => {
  const home = join(await makeTempRoot("home"), "absent");
  const { tools } = await listTools(t, { ...process.env, EGA_SKILLS_HOME: home });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );
});

test("contract: advertised descriptors match the frozen reviewed truth", async (t) => {
  const home = join(await makeTempRoot("home"), "absent");
  const { tools } = await listTools(t, { ...process.env, EGA_SKILLS_HOME: home });
  assert.deepEqual(tools, EXPECTED_DESCRIPTORS);
});

test("contract: input schemas expose the frozen required fields", async (t) => {
  const home = join(await makeTempRoot("home"), "absent");
  const { tools } = await listTools(t, { ...process.env, EGA_SKILLS_HOME: home });
  const requiredOf = (name) =>
    tools.find((tool) => tool.name === name).inputSchema.required ?? [];
  assert.deepEqual(requiredOf("resolve"), ["task"]);
  assert.deepEqual(requiredOf("search"), ["query"]);
  assert.deepEqual(requiredOf("inspect"), ["skill_id"]);
  assert.deepEqual(requiredOf("get_content"), ["skill_id", "version_hash", "level", "max_tokens"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} input is an object schema`);
    assert.ok(tool.outputSchema !== undefined, `${tool.name} defines an output schema`);
  }
});

test("contract: no resources or prompts exist in V1", async (t) => {
  const home = join(await makeTempRoot("home"), "absent");
  const { request } = await (async () => {
    const { send, request } = launch(t, { ...process.env, EGA_SKILLS_HOME: home });
    await request(1, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "contract-test", version: "0.0.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return { request };
  })();
  for (const method of ["resources/list", "prompts/list"]) {
    const response = await request(`no-${method}`, method, {});
    if (response.error !== undefined) {
      assert.ok(
        [-32601, -32602].includes(response.error.code),
        `${method} is unsupported (got ${JSON.stringify(response.error).slice(0, 120)})`,
      );
    } else {
      const entries = response.result?.resources ?? response.result?.prompts ?? [];
      assert.deepEqual(entries, [], `${method} exposes no entries`);
    }
  }
});

// --- Micro C: token budgets ------------------------------------------------------------

test("contract: tool metadata fits the frozen ega-o200k-v1 budgets", async (t) => {
  assert.equal(tokenEstimator?.id, "ega-o200k-v1", "measurement uses the frozen estimator");
  const home = join(await makeTempRoot("home"), "absent");
  const { tools } = await listTools(t, { ...process.env, EGA_SKILLS_HOME: home });
  for (const tool of tools) {
    const descriptionTokens = tokenEstimator.count(tool.description);
    assert.ok(
      descriptionTokens <= DESCRIPTION_BUDGET,
      `${tool.name} description is ${descriptionTokens} tokens (budget ${DESCRIPTION_BUDGET}): ${tool.description}`,
    );
  }
  const combined = tokenEstimator.count(JSON.stringify(tools));
  assert.ok(
    combined <= COMBINED_BUDGET,
    `combined four-tool metadata is ${combined} tokens (budget ${COMBINED_BUDGET})`,
  );
});

// --- Micro B: structured output agreement --------------------------------------------------

async function setupContractHome(t) {
  const base = await makeTempRoot("home");
  const home = join(base, "home");
  const src = join(base, "src");
  await mkdir(join(src, "contract"), { recursive: true });
  await writeFile(
    join(src, "contract", "SKILL.md"),
    "---\nname: contract\ndescription: contract fixture skill\n---\n# contract\n\nContract body marker CONTRACT-BODY-1138.\n",
  );
  await writeFile(join(src, "contract", "SKILL.core.md"), "# contract core\n\nCondensed core.\n");
  await writeFile(
    join(src, "contract", "ega.yaml"),
    "schema_version: 1\ndomains: [engineering]\ntriggers: [contract probe]\n",
  );
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    const summary = await importSkills(registry, { path: join(src, "contract"), namespace: "ega" });
    assert.equal(summary.failed, 0);
    return { home, versionHash: getCurrentVersionHash(registry.db, "ega/contract") };
  } finally {
    registry.close();
  }
}

async function setupContractProject(t) {
  return makeTempRoot("proj");
}

test("contract: success payloads validate against their output schemas", async (t) => {
  const { home, versionHash } = await setupContractHome(t);
  const project = await setupContractProject(t);
  const env = { ...process.env, EGA_SKILLS_HOME: home };
  const { send, request } = launch(t, env);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "contract-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const schemas = {
    resolve: RESOLVE_OUTPUT_SCHEMA,
    search: SEARCH_OUTPUT_SCHEMA,
    inspect: inspectOutputSchema,
    get_content: GET_CONTENT_OUTPUT_SCHEMA,
  };
  const calls = {
    resolve: { task: "contract probe work", project_path: project },
    search: { query: "contract probe", project_path: project },
    inspect: { skill_id: "ega/contract", project_path: project },
    get_content: {
      skill_id: "ega/contract",
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      project_path: project,
    },
  };
  for (const name of EXPECTED_TOOLS) {
    const call = await request(`ok-${name}`, "tools/call", { name, arguments: calls[name] });
    assert.equal(call.result.isError, false, `${name} succeeds: ${JSON.stringify(call.result).slice(0, 200)}`);
    assert.ok(Array.isArray(call.result.content), `${name} content is an array`);
    assert.ok(call.result.content.length >= 1, `${name} includes a text fallback`);
    const payload = unwrap(call);
    assertValidates(schemas[name], payload, `${name} structuredContent`);
    for (const part of call.result.content) {
      assert.ok(
        part.text.length <= 300,
        `${name} text fallback stays compact (${part.text.length} chars)`,
      );
    }
  }
  const bodies = JSON.stringify([
    unwrap(await request("x1", "tools/call", { name: "resolve", arguments: calls.resolve })),
    unwrap(await request("x2", "tools/call", { name: "search", arguments: calls.search })),
    unwrap(await request("x3", "tools/call", { name: "inspect", arguments: calls.inspect })),
  ]);
  assert.ok(
    !bodies.includes("CONTRACT-BODY-1138"),
    "resolve/search/inspect structured payloads never carry instruction bodies",
  );
});

test("contract: unknown input fields are permitted and ignored", async (t) => {
  // Frozen behavior (SPEC-006/AMEND-06 lists known fields without rejecting
  // extras; the runtime validator and advertised schemas both allow them):
  // unknown fields must not change the call outcome. No metadata change was
  // needed to freeze this — the advertised schemas already permit extras.
  const { home, versionHash } = await setupContractHome(t);
  const project = await setupContractProject(t);
  const env = { ...process.env, EGA_SKILLS_HOME: home };
  const { send, request } = launch(t, env);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "contract-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const pairs = [
    ["resolve", { task: "contract probe work", project_path: project }],
    ["search", { query: "contract probe", project_path: project }],
    ["inspect", { skill_id: "ega/contract", project_path: project }],
    [
      "get_content",
      {
        skill_id: "ega/contract",
        version_hash: versionHash,
        level: "L2",
        max_tokens: 4000,
        project_path: project,
      },
    ],
  ];
  for (const [name, args] of pairs) {
    const plain = await request(`plain-${name}`, "tools/call", { name, arguments: args });
    const extra = await request(`extra-${name}`, "tools/call", {
      name,
      arguments: { ...args, not_a_frozen_field: "ignored" },
    });
    assert.equal(plain.result.isError, false, `${name} baseline succeeds`);
    assert.equal(extra.result.isError, false, `${name} tolerates unknown fields`);
    const strip = (call) => {
      const copy = JSON.parse(JSON.stringify(unwrap(call)));
      delete copy.resolution_id;
      return copy;
    };
    assert.deepEqual(strip(extra), strip(plain), `${name} ignores unknown input fields`);
  }
});

test("contract: failures use isError plus the frozen McpToolError envelope", async (t) => {
  const { home } = await setupContractHome(t);
  const env = { ...process.env, EGA_SKILLS_HOME: home };
  const { send, request } = launch(t, env);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "contract-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const missing = join(await makeTempRoot("parent"), "no-such-project");
  const calls = {
    resolve: { task: "contract probe work", project_path: missing },
    search: { query: "contract probe", project_path: missing },
    inspect: { skill_id: "ega/contract", project_path: missing },
    get_content: {
      skill_id: "ega/contract",
      version_hash: `sha256:${"00".repeat(32)}`,
      level: "L2",
      max_tokens: 4000,
      project_path: missing,
    },
  };
  for (const name of EXPECTED_TOOLS) {
    const call = await request(`err-${name}`, "tools/call", { name, arguments: calls[name] });
    assert.equal(call.result.isError, true, `${name} marks the error result`);
    const envelope = unwrap(call);
    assert.equal(envelope?.error?.code, "E_PROJECT_NOT_FOUND", `${name} frozen code`);
    assert.equal(envelope?.error?.tool, name, `${name} names itself`);
    assert.equal(typeof envelope?.error?.message, "string", `${name} carries a message`);
  }
});
