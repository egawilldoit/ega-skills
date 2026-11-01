import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ciGateState, waitForCanonical } from "../../scripts/release/verify-live.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/release/verify-live.mjs");
const TOOL_NAMES = ["resolve", "search", "inspect", "get_content"];
const TARGET = "dpl_target12345678";
const OLD = "dpl_old12345678";

function digest(letter) {
  return `sha256:${letter.repeat(64)}`;
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(server.address().port)));
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function runCli(env, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`verify-live timed out; stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function makeCatalog({ count = 126, tstackCount = 9 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ega-verify-live-"));
  const versions = {};
  for (let index = 0; index < count; index += 1) {
    const skillId = index < tstackCount ? `t3dotgg/skill-${index}` : `namespace${index}/skill-${index}`;
    versions[skillId] = digest(((index % 14) + 1).toString(16));
  }
  const manifest = {
    digest: digest("a"),
    object_type: "ega.hub-release",
    payload: { skill_versions: versions },
  };
  const releasePackage = {
    hub_release_digest: digest("a"),
    sqlite_artifact_digest: digest("b"),
    snapshot_rows: count,
  };
  const manifestPath = join(dir, "hub-release.json");
  const packagePath = join(dir, "release-package.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(packagePath, JSON.stringify(releasePackage));
  return { dir, manifestPath, packagePath, versions, skills: Object.entries(versions) };
}

function startOrigin({ expectedDigest, versions, failSkill = null, sse = false, authFailure = false, token = "test-token" }) {
  const state = {
    readyDigest: expectedDigest,
    mcpCalls: [],
    authFailure,
    sse,
    failSkill,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (typeof state.readyDigest === "string" && state.readyDigest !== "") {
        writeJson(response, 200, { status: "ready", release_digest: state.readyDigest });
      } else {
        writeJson(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp") {
      const body = await readBody(request);
      state.mcpCalls.push(body);
      if (state.authFailure || request.headers.authorization !== `Bearer ${token}`) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        writeJson(response, 400, { error: "bad json" });
        return;
      }
      let result;
      if (message.method === "tools/list") {
        result = { tools: TOOL_NAMES.map((name) => ({ name, description: name })) };
      } else if (message.method === "tools/call" && message.params?.name === "inspect") {
        const args = message.params.arguments ?? {};
        if (state.failSkill !== null && args.skill_id === state.failSkill) {
          result = {
            content: [{ type: "text", text: JSON.stringify({ error: { code: "E_VERSION_NOT_FOUND", message: "missing skill" } }) }],
            isError: true,
          };
        } else {
          result = {
            content: [{ type: "text", text: `inspect ${args.skill_id}` }],
            structuredContent: {
              skill_id: args.skill_id,
              version_hash: state.failSkill === "wrong-hash" ? digest("f") : versions[args.skill_id],
              effective_release_digest: state.readyDigest,
            },
            isError: false,
          };
        }
      } else if (message.method === "tools/call" && message.params?.name === "get_content") {
        const args = message.params.arguments ?? {};
        result = {
          content: [{ type: "text", text: `content ${args.skill_id}` }],
          structuredContent: {
            skill_id: args.skill_id,
            version_hash: versions[args.skill_id],
            level: "L2",
            content: `L2 body for ${args.skill_id}`,
            effective_release_digest: state.readyDigest,
          },
          isError: false,
        };
      } else if (message.method === "tools/call" && message.params?.name === "search") {
        result = {
          content: [{ type: "text", text: "search results" }],
          structuredContent: { results: [{ skill_id: "t3dotgg/skill-0" }], effective_release_digest: state.readyDigest },
          isError: false,
        };
      } else {
        result = { content: [{ type: "text", text: "unknown method" }], isError: true };
      }
      const envelope = { jsonrpc: "2.0", id: message.id, result };
      if (state.sse) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
      } else {
        writeJson(response, 200, envelope);
      }
      return;
    }
    writeJson(response, 404, { error: { code: "E_NOT_FOUND" } });
  });
  return { server, state };
}

function startVercel({ aliasTarget, checks = {}, target = TARGET, authFailure = false }) {
  const state = { aliasTarget, checks, target, aliasReads: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (authFailure) {
      writeJson(response, 403, { error: { code: "forbidden" } });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v4/aliases/")) {
      state.aliasReads += 1;
      writeJson(response, 200, {
        alias: decodeURIComponent(url.pathname.slice("/v4/aliases/".length)),
        projectId: "prj_test",
        deploymentId: state.aliasTarget,
      });
      return;
    }
    if (request.method === "GET" && /^\/v2\/deployments\/[^/]+\/check-runs$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      writeJson(response, 200, { runs: state.checks[id] ?? [] });
      return;
    }
    if (request.method === "GET" && /^\/v13\/deployments\//.test(url.pathname)) {
      writeJson(response, 200, { id: state.target, url: decodeURIComponent(url.pathname.split("/")[3]) });
      return;
    }
    writeJson(response, 404, { error: { code: "not_found" } });
  });
  return { server, state };
}

async function baseEnv({ originPort, vercelPort, tokenPath, catalog, overrides = {} }) {
  return {
    EGA_VERIFY_ORIGIN: `http://127.0.0.1:${originPort}`,
    EGA_VERIFY_DEPLOYMENT_URL: `http://127.0.0.1:${originPort}`,
    EGA_VERIFY_TARGET_DEPLOYMENT_ID: TARGET,
    EGA_VERIFY_EXPECTED_MANIFEST: catalog.manifestPath,
    EGA_VERIFY_EXPECTED_PACKAGE: catalog.packagePath,
    EGA_VERIFY_TOKEN_FILE: tokenPath,
    EGA_VERIFY_TIMEOUT_MS: "4000",
    EGA_VERIFY_POLL_MS: "25",
    VERCEL_TOKEN: "vercel-test-token",
    VERCEL_TEAM_ID: "team_test",
    VERCEL_PROJECT_ID: "prj_test",
    VERCEL_CANONICAL_ALIAS: "ega-skills-mcp.vercel.app",
    VERCEL_API_BASE: `http://127.0.0.1:${vercelPort}`,
    ...overrides,
  };
}

function parseSummary(stdout) {
  const start = stdout.indexOf("{");
  assert.ok(start >= 0, `stdout did not contain JSON: ${stdout}`);
  return JSON.parse(stdout.slice(start));
}

test("healthy 126-skill release with nine TStack L2 reads verifies over SSE", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions, sse: true });
  const vercel = startVercel({ aliasTarget: TARGET });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({ originPort, vercelPort, tokenPath, catalog }));
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.skill_count, 126);
  assert.equal(summary.release_digest, digest("a"));
  assert.equal(summary.canonical_alias_target, TARGET);
  assert.equal(summary.inspected, 126);
  assert.equal(summary.tstack.length, 9);
  assert.ok(summary.tstack.every((entry) => entry.content_chars > 0));
  assert.ok(summary.checks.some((check) => check.name === "tools/list" && check.ok));
});

test("a live digest different from the checked-out release exits 4 after promotion", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("c"), versions: catalog.versions });
  const vercel = startVercel({ aliasTarget: TARGET });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_DEPLOYMENT_URL: "", EGA_VERIFY_TIMEOUT_MS: "300" },
  }));
  assert.equal(result.code, 4, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.exit_code, 4);
});

test("a missing expected skill exits 4 without recovery", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions, failSkill: catalog.skills[50][0] });
  const vercel = startVercel({ aliasTarget: TARGET });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_DEPLOYMENT_URL: "" },
  }));
  assert.equal(result.code, 4, `${result.stderr}\n${result.stdout}`);
  const summary = parseSummary(result.stdout);
  assert.match(String(summary.reason), /missing skill|inspect/);
});

test("a missing token file exits 2 and never skips authentication", async (t) => {
  const catalog = makeCatalog();
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({ aliasTarget: TARGET });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath: join(catalog.dir, "missing-token.json"),
    catalog,
  }));
  assert.equal(result.code, 2, result.stderr);
  assert.equal(origin.state.mcpCalls.length, 0);
});

test("canonical alias left on an older deployment exits 3", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({ aliasTarget: OLD });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_TIMEOUT_MS: "300" },
  }));
  assert.equal(result.code, 3, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.exit_code, 3);
  assert.equal(origin.state.mcpCalls.length, 0);
});

test("resolves the deployment id from the event URL when the event omits it", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({ aliasTarget: TARGET });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_TARGET_DEPLOYMENT_ID: "" },
  }));
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.deployment_id, TARGET);
  assert.equal(summary.canonical_alias_target, TARGET);
});

test("a failed ci-gate deployment check exits 3 immediately", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({
    aliasTarget: TARGET,
    checks: {
      [TARGET]: [{
        name: "GitHub CI gate",
        source: { externalCheckName: "ci-gate" },
        status: "completed",
        conclusion: "failed",
      }],
    },
  });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const started = Date.now();
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_TIMEOUT_MS: "20000" },
  }));
  assert.equal(result.code, 3, `${result.stderr}\n${result.stdout}`);
  assert.ok(Date.now() - started < 5_000);
});


test("ci-gate is classified as pending, success, or failed, never guessed", () => {
  const run = (status, conclusion) => [{ name: "GitHub CI gate", source: { externalCheckName: "ci-gate" }, status, conclusion }];
  assert.equal(ciGateState([]).state, "pending");
  assert.equal(ciGateState(run("in_progress", null)).state, "pending");
  assert.equal(ciGateState(run("queued", null)).state, "pending");
  assert.equal(ciGateState(run("completed", "success")).state, "success");
  assert.equal(ciGateState(run("completed", "failure")).state, "failed");
  assert.equal(ciGateState(run("completed", "skipped")).state, "failed");
});

test("a still-pending ci-gate reports pending after the bounded wait, not a CI failure", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({
    aliasTarget: OLD,
    checks: { [TARGET]: [{ name: "GitHub CI gate", source: { externalCheckName: "ci-gate" }, status: "in_progress", conclusion: null }] },
  });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_TIMEOUT_MS: "300" },
  }));
  assert.equal(result.code, 3, `${result.stderr}\n${result.stdout}`);
  const summary = parseSummary(result.stdout);
  assert.match(String(summary.reason), /still pending/i);
  assert.ok(summary.checks.some((check) => check.name === "ci-gate" && check.state === "pending"));
});

test("pending ci-gate can settle and promote within the bounded wait", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({
    aliasTarget: OLD,
    checks: { [TARGET]: [{ name: "GitHub CI gate", source: { externalCheckName: "ci-gate" }, status: "in_progress", conclusion: null }] },
  });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const settle = setTimeout(() => {
    vercel.state.checks[TARGET] = [{ name: "GitHub CI gate", source: { externalCheckName: "ci-gate" }, status: "completed", conclusion: "success" }];
    vercel.state.aliasTarget = TARGET;
  }, 250);
  try {
    const result = await runCli(await baseEnv({
      originPort,
      vercelPort,
      tokenPath,
      catalog,
      overrides: { EGA_VERIFY_TIMEOUT_MS: "5000", EGA_VERIFY_POLL_MS: "25" },
    }));
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const summary = parseSummary(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.canonical_alias_target, TARGET);
  } finally {
    clearTimeout(settle);
  }
});

test("waitForCanonical keeps genuine CI failure blocking even when the alias is correct", async () => {
  const result = await waitForCanonical({
    expectedDigest: digest("a"),
    targetDeploymentId: TARGET,
    timeoutMs: 1000,
    pollMs: 1,
    readAlias: async () => TARGET,
    readReady: async () => ({ healthStatus: 200, readyStatus: 200, digest: digest("a") }),
    readCiGate: async () => ({ name: "ci-gate", state: "failed", detail: "failure", url: null }),
  });
  assert.equal(result.state, "ci_failed");
});

test("a Vercel API 403 exits 2 as a credential failure, not a release failure", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "test-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions });
  const vercel = startVercel({ aliasTarget: TARGET, authFailure: true });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({ originPort, vercelPort, tokenPath, catalog }));
  assert.equal(result.code, 2, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.match(String(summary.reason), /authentication failed with status 403/);
});

test("MCP authentication failure exits 2, not a skip", async (t) => {
  const catalog = makeCatalog();
  const tokenPath = join(catalog.dir, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "wrong-token" }), { mode: 0o600 });
  const origin = startOrigin({ expectedDigest: digest("a"), versions: catalog.versions, authFailure: true });
  const vercel = startVercel({ aliasTarget: TARGET });
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
    rmSync(catalog.dir, { recursive: true, force: true });
  });
  const originPort = await listen(origin.server);
  const vercelPort = await listen(vercel.server);
  const result = await runCli(await baseEnv({
    originPort,
    vercelPort,
    tokenPath,
    catalog,
    overrides: { EGA_VERIFY_DEPLOYMENT_URL: "" },
  }));
  assert.equal(result.code, 2, result.stderr);
});
