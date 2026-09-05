// Codex acceptance smoke (EGA-595). CI-safe: SKIPS unless explicitly enabled.
//
// Live model runs cost money and need a credential, so they stay manual (see
// README.md). What this test proves without any model call:
//   1. the fixture builder is byte-deterministic: the imported version hash
//      equals the frozen value observed in the live EGA-595 acceptance run;
//   2. the built MCP server starts over stdio and advertises exactly the
//      four V1 tools (the same binary Codex launches).
// Enable with EGA_CODEX_ACCEPTANCE=1. Otherwise the test skips.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildFixture,
  removeFixture,
  FIXTURE_SKILL_ID,
} from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Built server binary (same artifact Codex launches via config.toml).
const SERVER_BIN = join(HERE, "..", "..", "..", "packages", "mcp", "bin", "ega-mcp.mjs");

// Frozen in the live EGA-595 acceptance run (Codex CLI 0.150.1, 2026-09-05):
// resolve/search/inspect/get_content all returned this exact hash, and the
// get_content L2 bytes hashed to cache blob 17e4305b… (see README.md).
const EXPECTED_VERSION_HASH =
  "sha256:74e83090de8a7ee2624a1d24d5b298c7d34d8e3c44a7043e56f65ea8d5bca7e0";

function send(proc, message) {
  return new Promise((resolve, reject) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

test("codex acceptance smoke: deterministic fixture + four-tool server", async (t) => {
  if (!process.env.EGA_CODEX_ACCEPTANCE) {
    t.skip("set EGA_CODEX_ACCEPTANCE=1 to run the Codex acceptance smoke");
    return;
  }
  const info = await buildFixture();
  t.after(async () => {
    await removeFixture(info.root);
  });

  // 1. Fixture determinism: byte-identical inputs → byte-identical identity.
  assert.equal(info.skillId, FIXTURE_SKILL_ID);
  assert.equal(info.versionHash, EXPECTED_VERSION_HASH);

  // 2. The same binary Codex launches advertises exactly the four V1 tools.
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
    void send(proc, {
      jsonrpc: "2.0",
      id: "smoke-list",
      method: "tools/list",
      params: {},
    });
  });
  assert.deepEqual(tools, ["resolve", "search", "inspect", "get_content"]);
});
