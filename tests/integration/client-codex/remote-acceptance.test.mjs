// Live remote Codex acceptance (OAuth against the hosted MCP). SKIPS unless
// explicitly enabled: it needs a staging user token, a Supabase API key, and
// model credentials, so it can never run in generic CI.
//
// Enable with EGA_REMOTE_ACCEPTANCE=1 plus:
//   EGA_CODEX_HOME            isolated CODEX_HOME (config + auth)
//   EGA_INTEROP_USER_TOKEN    Supabase user access token
//   EGA_INTEROP_API_KEY       Supabase API key
//   EGA_MCP_TOKEN_FILE        delegated MCP token file (for the identity probe)
// Optional: EGA_MCP_URL, EGA_MCP_EXPECT_VERSION, EGA_MCP_EXPECT_DIGEST
//
// The harness never prints tokens; assertions read only its summary.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

function run(script, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("codex remote OAuth login completes headlessly and preserves the four-tool identity", async (t) => {
  if (!process.env.EGA_REMOTE_ACCEPTANCE) {
    t.skip("set EGA_REMOTE_ACCEPTANCE=1 to run the live remote Codex acceptance");
    return;
  }
  assert.ok(process.env.EGA_CODEX_HOME, "EGA_CODEX_HOME is required");
  assert.ok(process.env.EGA_INTEROP_USER_TOKEN, "EGA_INTEROP_USER_TOKEN is required");
  assert.ok(process.env.EGA_INTEROP_API_KEY, "EGA_INTEROP_API_KEY is required");

  const login = await run(join(HERE, "remote-login.mjs"), {}, 240000);
  assert.equal(login.code, 0, `login harness failed: ${login.stderr.slice(0, 200)}`);
  const summary = JSON.parse(login.stdout);
  assert.deepEqual(summary.failures, [], "login checks must all pass");
  assert.equal(summary.client_id_kind, "opaque-uuid", "Codex must register via DCR");

  if (process.env.EGA_MCP_TOKEN_FILE) {
    const probe = await run(join(ROOT, "scripts", "oauth", "mcp-probe.mjs"), {}, 120000);
    assert.equal(probe.code, 0, `identity probe failed: ${probe.stderr.slice(0, 200)}`);
    const identity = JSON.parse(probe.stdout);
    assert.deepEqual(identity.failures, []);
    assert.deepEqual(identity.tools, ["get_content", "inspect", "resolve", "search"]);
  }
});
