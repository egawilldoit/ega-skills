import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHubRelease } from "../../packages/project/dist/index.js";

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-startup-fail-closed-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha startup skill.\n---\n\nUse alpha.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: startup-fail-closed\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const BUILD = await buildHubRelease(makeHub());

function validPolicy() {
  return {
    workspace_id: "startup-workspace",
    visibility: "private",
    owner_subject: "local-smoke",
    memberships: [{ subject: "local-smoke", role: "owner", active: true }],
    denies: [],
  };
}

let nextPort = 19800;
function reservePort() {
  nextPort += 1 + Math.floor(Math.random() * 50);
  return nextPort;
}

async function waitForListening(child, port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.stderrText ?? ""}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server never listened: ${child.stderrText ?? ""}`);
}

async function startHosted(t, policyJSON, artifactDir = BUILD.registryHome) {
  const workDir = mkdtempSync(join(tmpdir(), "ega-startup-env-"));
  const authzPath = join(workDir, "authz.json");
  writeFileSync(authzPath, policyJSON);
  const port = reservePort();
  const child = spawn(process.execPath, ["packages/mcp/bin/ega-mcp-hosted.mjs"], {
    cwd: join(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PORT: String(port),
      EGA_HOSTED_ARTIFACT_DIR: artifactDir,
      EGA_HOSTED_BEARER_TOKEN: "startup-secret-token",
      EGA_HOSTED_AUTHZ_FILE: authzPath,
      EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; child.stderrText = stderr; });
  t.after(() => child.kill());
  await waitForListening(child, port);
  return { port, child };
}

async function search(port) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer startup-secret-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "http://localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "alpha" } } }),
  });
}

async function assertUnavailable(t, policy, artifact) {
  const { port } = await startHosted(t, policy, artifact);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 503);
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(ready.status, 503);
  const mcp = await search(port);
  assert.equal(mcp.status, 503, "MCP must not serve after failed startup");
  const body = await mcp.text();
  assert.doesNotMatch(body, /ega\/alpha/, "failed startup leaked private metadata");
  assert.doesNotMatch(body, /startup-secret-token/, "failed startup leaked a secret");
}

test("failed startup from a malformed membership serves no MCP handler", async (t) => {
  const policy = validPolicy();
  policy.memberships.push({ subject: "bad-user", role: "not-a-role", active: true });
  await assertUnavailable(t, JSON.stringify(policy));
});

test("failed startup from a malformed deny serves no MCP handler", async (t) => {
  const policy = validPolicy();
  policy.denies = [123];
  await assertUnavailable(t, JSON.stringify(policy));
});

test("failed startup from a malformed policy shape serves no MCP handler", async (t) => {
  const policy = validPolicy();
  policy.visibility = "visible-to-nobody";
  await assertUnavailable(t, JSON.stringify(policy));
});

test("failed startup from an invalid artifact serves no MCP handler", async (t) => {
  const emptyDir = mkdtempSync(join(tmpdir(), "ega-startup-empty-"));
  await assertUnavailable(t, JSON.stringify(validPolicy()), emptyDir);
});

test("valid startup still serves search over HTTP", async (t) => {
  const { port } = await startHosted(t, JSON.stringify(validPolicy()));
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  const response = await search(port);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ega\/alpha/);
});
