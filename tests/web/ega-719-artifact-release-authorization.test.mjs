/**
 * EGA-719: protected artifact release authorization through the real BFF.
 */

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(REPO_ROOT, "apps", "web", "server.mts");
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");
const COMMITTED_PACKAGE = JSON.parse(readFileSync(join(ARTIFACT, "release-package.json"), "utf8"));
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;

const MOCK_PORT = 34974;
const WEB_PORT = 34975;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const MOCK_BASE = `https://127.0.0.1:${MOCK_PORT}`;

let mockServer;
let webChild;
let workdir;
let artifactCopy;
let keyPath;
let certPath;

function startMockSupabase() {
  mockServer = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const url = new URL(req.url, MOCK_BASE);
    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer valid-token")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "user-123" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/hub_releases") {
      const auth = req.headers.authorization ?? "";
      const authorized = auth === "Bearer valid-token-authorized";
      const digest = (url.searchParams.get("release_digest") ?? "").replace(/^eq\./, "");
      const rows = authorized && digest === COMMITTED_DIGEST
        ? [{ hub_id: "hub-1", release_digest: digest }]
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => {
    mockServer.listen(MOCK_PORT, "127.0.0.1", () => resolve());
  });
}

async function startWebServer({ artifactDir, port = WEB_PORT }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      EGA_WEB_ARTIFACT_DIR: artifactDir ?? "",
      EGA_WEB_RETAINED_MANIFEST: "",
      EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST,
      EGA_WEB_PUBLIC_POLICY: "",
      EGA_SUPABASE_URL: MOCK_BASE,
      EGA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(c));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) { healthy = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) {
    child.kill("SIGKILL");
    throw new Error(`web server never became healthy: ${stderr.join("").slice(0, 400)}`);
  }
  return { child, base };
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ega-719-"));
  mkdirSync(join(workdir, "dist"), { recursive: true });
  writeFileSync(join(workdir, "dist", "index.html"), "<!doctype html><div id=root></div>");
  keyPath = join(workdir, "key.pem");
  certPath = join(workdir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  artifactCopy = join(workdir, "artifact");
  cpSync(ARTIFACT, artifactCopy, { recursive: true });
  await startMockSupabase();
  const started = await startWebServer({ artifactDir: artifactCopy, port: WEB_PORT });
  webChild = started.child;
});

after(async () => {
  // Windows-safe teardown: `kill()` only requests termination, and the child
  // holds `workdir` as its cwd until it is reaped. Removing the directory
  // before the `exit` event raises EPERM on Windows (CI run 39072855176).
  // Await the exit, drain the mock server, then remove with bounded retries
  // for transient AV/scanner handles. No assertion is touched.
  if (mockServer) {
    mockServer.closeAllConnections?.();
    await new Promise((resolve) => mockServer.close(resolve));
  }
  await stopChild(webChild);
  webChild = undefined;
  if (workdir) removeTreeWithRetries(workdir);
});

/**
 * Terminate a spawned server and wait for it to actually be gone.
 * `kill("SIGKILL")` only *requests* termination; on Windows the process, and
 * any handle it still holds on the working directory, outlives the call, so
 * removing that directory immediately after it raises EPERM. `exit` is the
 * only reliable signal that the handle is released. Mirrors the helper in
 * tests/web/console-server.test.mjs.
 */
function stopChild(proc, timeoutMs = 10_000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      proc.off("exit", done);
      resolve();
    };
    // SIGKILL is not implemented on Windows; Node maps it to TerminateProcess.
    proc.once("exit", done);
    proc.once("error", done);
    const timer = setTimeout(done, timeoutMs);
    // Do not let a stuck child keep the event loop alive past teardown.
    timer.unref?.();
    proc.kill("SIGKILL");
  });
}

/**
 * Remove a tree, retrying while the OS still reports handles as busy.
 * On Windows an antivirus scanner or a just-exited child can hold a transient
 * handle that `rmSync` cannot take on the first attempt. Only EPERM/EBUSY are
 * retried, bounded (10 x 100ms); the last attempt's error still propagates,
 * so a genuine failure is never hidden. Mirrors console-server.test.mjs.
 */
function removeTreeWithRetries(path, attempts = 10, delayMs = 100) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = error?.code === "EPERM" || error?.code === "EBUSY";
      if (!retryable || attempt >= attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

async function req(base, path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, text, body, size: Buffer.byteLength(text, "utf8") };
}

test("EGA-719: authorized session fetches one verified artifact (200)", async () => {
  const r = await req(BASE, `/api/skills/${encodeURIComponent("anthropic/claude-api")}/content?level=L2`, "valid-token-authorized");
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body && r.body.content, "artifact content must be present");
  assert.equal(r.body.release.release_digest, COMMITTED_DIGEST);
});

test("EGA-719: missing release identity is denied with zero artifact bytes (503)", async () => {
  const { child, base } = await startWebServer({ artifactDir: "", port: 34976 });
  const r = await req(base, `/api/skills/${encodeURIComponent("anthropic/claude-api")}/content?level=L2`, "valid-token-authorized");
  assert.equal(r.status, 503, r.text);
  assert.equal(r.body?.error?.code, "E_WEB_RELEASE_UNVERIFIED");
  assert.equal(r.body?.content, undefined, "no artifact bytes may be served");
  // Await the exit: this server also runs with cwd inside `workdir`, and a
  // bare `kill()` would race the suite `after()` removal on Windows (EPERM).
  await stopChild(child);
});

test("EGA-719: caller that cannot read the release is denied (403)", async () => {
  const r = await req(BASE, `/api/skills/${encodeURIComponent("anthropic/claude-api")}/content?level=L2`, "valid-token-unauthorized");
  assert.equal(r.status, 403, r.text);
  assert.equal(r.body?.error?.code, "E_WEB_CONTROL_PLANE_FORBIDDEN");
  assert.equal(r.body?.content, undefined, "no artifact bytes may be served");
});
