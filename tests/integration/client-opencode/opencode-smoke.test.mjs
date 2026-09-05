// OpenCode/T3 acceptance smoke (EGA-596/EGA-597). CI-safe: the config
// template check always runs (no CLI needed); the live-server check SKIPS
// unless EGA_OPENCODE_ACCEPTANCE=1.
//
// Proves without any model call:
//   1. the committed opencode.json.template is a valid, complete OpenCode
//      MCP declaration for the SAME local stdio binary every client uses;
//   2. (enabled only) the deterministic fixture reproduces the frozen
//      version hash, and the built server advertises exactly the four V1
//      tools. Live model runs stay manual (see README.md).

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildFixture,
  removeFixture,
  FIXTURE_SKILL_ID,
} from "../client-codex/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = join(HERE, "..", "..", "..", "packages", "mcp", "bin", "ega-mcp.mjs");

// Same frozen value as the Codex run: one fixture, one identity, all clients.
const EXPECTED_VERSION_HASH =
  "sha256:74e83090de8a7ee2624a1d24d5b298c7d34d8e3c44a7043e56f65ea8d5bca7e0";

test("opencode config template declares the same local MCP server", async () => {
  const template = JSON.parse(
    await readFile(join(HERE, "opencode.json.template"), "utf8"),
  );
  const server = template?.mcp?.["ega-skills"];
  assert.ok(server, "template must declare mcp.ega-skills");
  assert.equal(server.type, "local");
  assert.ok(
    Array.isArray(server.command) && server.command.length === 2,
    "command must be [node, server-bin]",
  );
  assert.match(server.command[1], /packages\/mcp\/bin\/ega-mcp\.mjs$/);
  assert.ok(
    typeof server.environment?.EGA_SKILLS_HOME === "string" &&
      server.environment.EGA_SKILLS_HOME.length > 0,
    "environment must scope EGA_SKILLS_HOME",
  );
  assert.equal(server.enabled, true);
  assert.deepEqual(
    Object.keys(template.mcp),
    ["ega-skills"],
    "exactly one MCP server: no client-specific extras",
  );
});

test("opencode acceptance smoke: deterministic fixture + four-tool server", async (t) => {
  if (!process.env.EGA_OPENCODE_ACCEPTANCE) {
    t.skip("set EGA_OPENCODE_ACCEPTANCE=1 to run the OpenCode acceptance smoke");
    return;
  }
  const info = await buildFixture();
  t.after(async () => {
    await removeFixture(info.root);
  });
  assert.equal(info.skillId, FIXTURE_SKILL_ID);
  assert.equal(info.versionHash, EXPECTED_VERSION_HASH);

  const proc = spawn(process.execPath, [SERVER_BIN], {
    env: { ...process.env, EGA_SKILLS_HOME: info.home },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => {
    if (proc.exitCode === null) proc.kill();
  });
  let buffer = "";
  const tools = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tools/list timed out")), 15000);
    proc.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((candidate) => {
        try {
          return JSON.parse(candidate)?.id === "smoke-list";
        } catch {
          return false;
        }
      });
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).result.tools.map((entry) => entry.name));
      }
    });
    proc.on("error", reject);
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "smoke-list", method: "tools/list", params: {} })}\n`,
    );
  });
  assert.deepEqual(tools, ["resolve", "search", "inspect", "get_content"]);
});
