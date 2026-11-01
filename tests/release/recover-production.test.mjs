import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/release/recover-production.mjs");
const FAILED = "dpl_failed12345678";
const PREVIOUS = "dpl_prev12345678";
const NEWER = "dpl_newer12345678";

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
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function runRecovery(args, env, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
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
      reject(new Error(`recover-production timed out; stdout=${stdout} stderr=${stderr}`));
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

function startOrigin({ digestValue }) {
  const state = { readyDigest: digestValue };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (state.readyDigest) writeJson(response, 200, { status: "ready", release_digest: state.readyDigest });
      else writeJson(response, 503, { status: "unavailable" });
      return;
    }
    writeJson(response, 404, { error: { code: "E_NOT_FOUND" } });
  });
  return { server, state };
}

function startVercel({ aliasTarget, deployments, checks = {}, project, aliasSequence = null }) {
  const state = {
    aliasTarget,
    aliasSequence,
    aliasReads: 0,
    deployments,
    checks,
    project: {
      autoAssignCustomDomains: true,
      commandForIgnoringBuildStep: null,
      gitProviderOptions: { createDeployments: "enabled" },
      ...project,
    },
    promoteCalls: 0,
    patchCalls: 0,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && parts[0] === "v4" && parts[1] === "aliases") {
      const index = state.aliasSequence ? Math.min(state.aliasReads, state.aliasSequence.length - 1) : null;
      const target = index === null ? state.aliasTarget : state.aliasSequence[index];
      state.aliasReads += 1;
      writeJson(response, 200, {
        alias: decodeURIComponent(parts.slice(2).join("/")),
        projectId: "prj_test",
        deploymentId: target,
      });
      return;
    }
    if (request.method === "GET" && parts[0] === "v13" && parts[1] === "deployments" && parts[2]) {
      const deployment = state.deployments.find((entry) => entry.id === decodeURIComponent(parts[2]));
      if (!deployment) {
        writeJson(response, 404, { error: { code: "not_found" } });
        return;
      }
      writeJson(response, 200, deployment);
      return;
    }
    if (request.method === "GET" && parts[0] === "v6" && parts[1] === "deployments") {
      writeJson(response, 200, { deployments: state.deployments });
      return;
    }
    if (request.method === "GET" && parts[0] === "v2" && parts[1] === "deployments" && parts[3] === "check-runs") {
      const id = decodeURIComponent(parts[2]);
      writeJson(response, 200, { runs: state.checks[id] ?? [] });
      return;
    }
    if (request.method === "GET" && parts[0] === "v9" && parts[1] === "projects" && parts[2]) {
      writeJson(response, 200, { id: decodeURIComponent(parts[2]), ...state.project });
      return;
    }
    if (request.method === "PATCH" && parts[0] === "v9" && parts[1] === "projects" && parts[2]) {
      const body = JSON.parse((await readBody(request)) || "{}");
      state.project = {
        ...state.project,
        ...body,
        ...(body.gitProviderOptions === undefined
          ? {}
          : { gitProviderOptions: { ...state.project.gitProviderOptions, ...body.gitProviderOptions } }),
      };
      state.patchCalls += 1;
      writeJson(response, 200, { id: decodeURIComponent(parts[2]), ...state.project });
      return;
    }
    if (request.method === "POST" && parts[0] === "v10" && parts[1] === "projects" && parts[3] === "promote" && parts[4]) {
      state.promoteCalls += 1;
      state.aliasTarget = decodeURIComponent(parts[4]);
      writeJson(response, 200, { ok: true });
      return;
    }
    writeJson(response, 404, { error: { code: "not_found" } });
  });
  return { server, state };
}

function baseEnv(originPort, vercelPort) {
  return {
    EGA_VERIFY_ORIGIN: `http://127.0.0.1:${originPort}`,
    EGA_VERIFY_TIMEOUT_MS: "2000",
    EGA_VERIFY_POLL_MS: "25",
    VERCEL_TOKEN: "vercel-test-token",
    VERCEL_TEAM_ID: "team_test",
    VERCEL_PROJECT_ID: "prj_test",
    VERCEL_CANONICAL_ALIAS: "ega-skills-mcp.vercel.app",
    VERCEL_API_BASE: `http://127.0.0.1:${vercelPort}`,
  };
}

function parseSummary(stdout) {
  const start = stdout.indexOf("{");
  assert.ok(start >= 0, `stdout did not contain JSON: ${stdout}`);
  return JSON.parse(stdout.slice(start));
}

test("recovery promotes the newest healthy previous deployment and re-enables auto-publication", async (t) => {
  const origin = startOrigin({ digestValue: digest("1") });
  const originPort = await listen(origin.server);
  const originUrl = `http://127.0.0.1:${originPort}`;
  const deployments = [
    { id: PREVIOUS, url: originUrl, readyState: "READY", created: 100, target: "production", projectId: "prj_test" },
    { id: FAILED, url: originUrl, readyState: "READY", created: 200, target: "production", projectId: "prj_test" },
  ];
  const vercel = startVercel({
    aliasTarget: FAILED,
    deployments,
    project: { autoAssignCustomDomains: false, commandForIgnoringBuildStep: null },
  });
  const vercelPort = await listen(vercel.server);
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
  });

  const result = await runRecovery(["--failed-deployment", FAILED], baseEnv(originPort, vercelPort));
  assert.equal(result.code, 0, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.recovered, true);
  assert.equal(summary.superseded, false);
  assert.equal(summary.previous_deployment, PREVIOUS);
  assert.equal(summary.release_digest, digest("1"));
  assert.equal(summary.canonical_alias_target_after, PREVIOUS);
  assert.equal(summary.auto_publication.patched, true);
  assert.equal(summary.auto_publication.after, true);
  assert.deepEqual(summary.blockers, []);
  assert.equal(vercel.state.promoteCalls, 1);
  assert.equal(vercel.state.patchCalls, 1);
});

test("recovery restores GitHub deployment events for future automatic releases", async (t) => {
  const origin = startOrigin({ digestValue: digest("1") });
  const originPort = await listen(origin.server);
  const originUrl = `http://127.0.0.1:${originPort}`;
  const deployments = [
    { id: PREVIOUS, url: originUrl, readyState: "READY", created: 100, target: "production", projectId: "prj_test" },
    { id: FAILED, url: originUrl, readyState: "READY", created: 200, target: "production", projectId: "prj_test" },
  ];
  const vercel = startVercel({
    aliasTarget: FAILED,
    deployments,
    project: { autoAssignCustomDomains: true, commandForIgnoringBuildStep: null, gitProviderOptions: { createDeployments: "disabled" } },
  });
  const vercelPort = await listen(vercel.server);
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
  });

  const result = await runRecovery(["--failed-deployment", FAILED], baseEnv(originPort, vercelPort));
  assert.equal(result.code, 0, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.recovered, true);
  assert.equal(summary.auto_publication.create_deployments_before, "disabled");
  assert.equal(summary.auto_publication.create_deployments_after, "enabled");
  assert.equal(vercel.state.project.gitProviderOptions.createDeployments, "enabled");
  assert.equal(vercel.state.patchCalls, 1);
});

test("recovery is a no-op when the canonical alias already points at a newer deployment", async (t) => {
  const origin = startOrigin({ digestValue: digest("1") });
  const originPort = await listen(origin.server);
  const originUrl = `http://127.0.0.1:${originPort}`;
  const deployments = [
    { id: PREVIOUS, url: originUrl, readyState: "READY", created: 100, target: "production" },
    { id: FAILED, url: originUrl, readyState: "READY", created: 200, target: "production" },
    { id: NEWER, url: originUrl, readyState: "READY", created: 300, target: "production" },
  ];
  const vercel = startVercel({ aliasTarget: NEWER, deployments });
  const vercelPort = await listen(vercel.server);
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
  });

  const result = await runRecovery(["--failed-deployment", FAILED], baseEnv(originPort, vercelPort));
  assert.equal(result.code, 0, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.superseded, true);
  assert.equal(summary.recovered, false);
  assert.equal(vercel.state.promoteCalls, 0);
  assert.equal(vercel.state.patchCalls, 0);
});

test("recovery aborts if the canonical alias moves after selection", async (t) => {
  const origin = startOrigin({ digestValue: digest("1") });
  const originPort = await listen(origin.server);
  const originUrl = `http://127.0.0.1:${originPort}`;
  const deployments = [
    { id: PREVIOUS, url: originUrl, readyState: "READY", created: 100, target: "production" },
    { id: FAILED, url: originUrl, readyState: "READY", created: 200, target: "production" },
  ];
  const vercel = startVercel({
    aliasTarget: FAILED,
    deployments,
    aliasSequence: [FAILED, NEWER],
  });
  const vercelPort = await listen(vercel.server);
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
  });

  const result = await runRecovery(["--failed-deployment", FAILED], baseEnv(originPort, vercelPort));
  assert.equal(result.code, 1, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.aborted, true);
  assert.match(String(summary.reason), /changed before promotion/);
  assert.equal(vercel.state.promoteCalls, 0);
});

test("recovery reports a commandForIgnoringBuildStep blocker instead of silently leaving auto releases disabled", async (t) => {
  const origin = startOrigin({ digestValue: digest("1") });
  const originPort = await listen(origin.server);
  const originUrl = `http://127.0.0.1:${originPort}`;
  const deployments = [
    { id: PREVIOUS, url: originUrl, readyState: "READY", created: 100, target: "production" },
    { id: FAILED, url: originUrl, readyState: "READY", created: 200, target: "production" },
  ];
  const vercel = startVercel({
    aliasTarget: FAILED,
    deployments,
    project: { autoAssignCustomDomains: true, commandForIgnoringBuildStep: "pnpm build" },
  });
  const vercelPort = await listen(vercel.server);
  t.after(async () => {
    await close(origin.server);
    await close(vercel.server);
  });

  const result = await runRecovery(["--failed-deployment", FAILED], baseEnv(originPort, vercelPort));
  assert.equal(result.code, 1, result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.recovered, true);
  assert.equal(summary.ok, false);
  assert.ok(summary.blockers.some((blocker) => blocker.includes("commandForIgnoringBuildStep")));
  assert.equal(vercel.state.promoteCalls, 1);
  assert.equal(vercel.state.patchCalls, 0);
});
