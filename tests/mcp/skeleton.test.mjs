// MCP skeleton smoke test (SPEC-006 §5.1.1–§5.1.2, EGA-588).
//
// Spawns the real stdio server and drives the verified wire handshake:
// initialize -> notifications/initialized -> tools/list -> tools/call.
// Asserts exactly four tools, the frozen structured placeholder error,
// protocol-free stderr, offline startup, and clean exit on stdin close.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");

// The pinned MCP v2 SDK negotiates eras: on 2025-11-25 it carries the error
// envelope as structuredContent.result (era codec wrap); a 2024-11-05 client
// receives content+isError only. The skeleton test pins the 2025 era and
// asserts the full SPEC-006 §5.1.3 shape there.
const PROTOCOL_VERSION = "2025-11-25";

const VALID_ARGS = {
  resolve: { task: "fix a flaky crash" },
  search: { query: "flaky crash" },
  inspect: { skill_id: "ega/systematic-debugging" },
  get_content: {
    skill_id: "ega/systematic-debugging",
    version_hash: "sha256:0",
    level: "L1",
    max_tokens: 4000,
  },
};

function launch(t) {
  const child = spawn(process.execPath, [BIN], {
    cwd: REPO_ROOT,
    // Point at a home that does not exist: the skeleton performs no registry
    // I/O, so startup and calls must succeed regardless (no crash).
    env: { ...process.env, EGA_SKILLS_HOME: join(tmpdir(), "ega-mcp-no-such-home") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const pending = new Map();
  let buf = "";
  let stderr = "";
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
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
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
  const stderrText = () => stderr;
  return { child, send, request, stderrText };
}

test("MCP skeleton: initialize negotiates and lists exactly the four V1 tools", async (t) => {
  const { send, request } = launch(t);
  const init = await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "skeleton-test", version: "0.0.0" },
  });
  assert.ok(init.result?.serverInfo, "initialize returns serverInfo");
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const list = await request(2, "tools/list", {});
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["resolve", "search", "inspect", "get_content"],
  );
});

test("MCP skeleton: tool call returns the frozen structured placeholder error", async (t) => {
  const { send, request } = launch(t);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "skeleton-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  // `resolve` (EGA-590), `search` (EGA-591) and `inspect` (EGA-592) are
  // implemented: their placeholder assertions moved to their suites;
  // get_content is still a placeholder.
  for (const name of ["get_content"]) {
    const call = await request(`call-${name}`, "tools/call", { name, arguments: VALID_ARGS[name] });
    assert.equal(call.result.isError, true, `${name} is marked as an error result`);
    const envelope = call.result.structuredContent?.result ?? call.result.structuredContent;
    assert.equal(envelope?.error?.code, "E_TOOL_NOT_IMPLEMENTED", `${name} code`);
    assert.equal(envelope?.error?.tool, name, `${name} names itself`);
  }
});

async function failsClosedWithoutRegistry(t, name, args) {
  const { send, request } = launch(t);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "skeleton-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const call = await request(`call-${name}`, "tools/call", { name, arguments: args });
  assert.equal(call.result.isError, true, `${name} fails closed with no registry home`);
  const envelope = call.result.structuredContent?.result ?? call.result.structuredContent;
  assert.equal(envelope?.error?.code, "E_REGISTRY_UNAVAILABLE");
  assert.equal(envelope?.error?.tool, name);
}

test("MCP skeleton: resolve is implemented and fails closed without a registry", async (t) => {
  await failsClosedWithoutRegistry(t, "resolve", VALID_ARGS.resolve);
});

test("MCP skeleton: search is implemented and fails closed without a registry", async (t) => {
  await failsClosedWithoutRegistry(t, "search", VALID_ARGS.search);
});

test("MCP skeleton: inspect is implemented and fails closed without a registry", async (t) => {
  await failsClosedWithoutRegistry(t, "inspect", VALID_ARGS.inspect);
});

test("MCP skeleton: stderr stays protocol-free and stdin close exits cleanly", async (t) => {
  const { child, send, request, stderrText } = launch(t);
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "skeleton-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  await request(2, "tools/list", {});
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, "clean disconnect terminates with exit 0");
  assert.doesNotMatch(stderrText(), /"jsonrpc"/, "stderr carries no protocol frames");
});
