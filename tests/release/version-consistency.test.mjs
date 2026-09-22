import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHubRelease } from "../../packages/project/dist/index.js";
import { createHostedRuntimeFromEnv } from "../../packages/mcp/dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RELEASE_VERSION = "2.0.0";

function readVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function workspacePackagePaths() {
  return readdirSync(join(REPO_ROOT, "packages"))
    .filter((name) => !name.startsWith("."))
    .map((name) => join(REPO_ROOT, "packages", name, "package.json"))
    .filter((path) => path.endsWith("package.json"));
}

function spawnWithBound(command, args, { timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs} ms: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-version-hub-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha version skill.\n---\n\nUse alpha when needed.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: version-test\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

function parseRpcBody(text) {
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text);
}

test("root and every workspace package report the 2.0.0 release version", () => {
  const rootVersion = readVersion(join(REPO_ROOT, "package.json"));
  assert.equal(rootVersion, RELEASE_VERSION, "root package version must be the release version");
  const packages = workspacePackagePaths().map((path) => ({
    path: path.replace(`${REPO_ROOT}/`, ""),
    version: readVersion(path),
  }));
  assert.ok(packages.length >= 10, `expected the release workspace packages, found ${packages.length}`);
  for (const entry of packages) {
    assert.equal(entry.version, RELEASE_VERSION, `${entry.path} must report ${RELEASE_VERSION}`);
  }
});

test("the CLI reports the release version", async () => {
  const result = await spawnWithBound(process.execPath, [join(REPO_ROOT, "packages", "cli", "bin", "ega-skills.mjs"), "--version"]);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), RELEASE_VERSION);
});

test("the stdio MCP server self-identity matches the release version", async () => {
  const child = spawn(process.execPath, [join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs")], {
    cwd: REPO_ROOT,
    env: { ...process.env, EGA_SKILLS_HOME: mkdtempSync(join(tmpdir(), "ega-version-home-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const serverInfo = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("stdio MCP server did not answer initialize"));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(message.result?.serverInfo);
          }
        } catch {
          continue;
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "version-test", version: "0.0.0" } },
    })}\n`);
  });
  assert.deepEqual(serverInfo, { name: "ega-skills", version: RELEASE_VERSION });
});

test("the hosted MCP server self-identity matches the release version", async () => {
  const build = await buildHubRelease(makeHub());
  const runtime = createHostedRuntimeFromEnv({
    EGA_HOSTED_ARTIFACT_DIR: build.registryHome,
    EGA_HOSTED_AUTHZ_JSON: JSON.stringify({
      workspace_id: "version-workspace",
      visibility: "private",
      owner_subject: "local-smoke",
      memberships: [{ subject: "local-smoke", role: "owner", active: true }],
      denies: [],
    }),
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    EGA_HOSTED_BEARER_TOKEN: "test-token",
    EGA_HOSTED_ALLOW_STATIC_TOKEN: "true",
  });
  const response = await runtime.handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "http://localhost",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "version-test", version: "0.0.0" } },
    }),
  }));
  assert.equal(response.status, 200);
  const body = parseRpcBody(await response.text());
  assert.deepEqual(body.result?.serverInfo, { name: "ega-skills-hosted", version: RELEASE_VERSION });
});
