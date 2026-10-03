/**
 * Contract tests for the console BFF entrypoint.
 *
 * `server.mts` starts an HTTP server on import, so it is exercised the way it
 * actually runs: boot it on an ephemeral port with `dist/` present, then assert
 * the real HTTP responses. This covers the routes Builder 2 will extend without
 * rewriting the file — /healthz, /readyz, the /api 404 boundary, the SPA
 * fallback, and the read-only method rejection.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(REPO_ROOT, "apps", "web", "server.mts");
const PORT = 34117;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let workdir;
let distDir;

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ega-web-server-"));
  distDir = join(workdir, "dist");
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(
    join(distDir, "index.html"),
    "<!doctype html><html><body><div id=root></div></body></html>",
  );
  writeFileSync(join(distDir, "assets", "index-test.js"), "console.log(1);\n");
  writeFileSync(join(distDir, "secret.txt"), "not-in-dist-marker\n");

  // `--experimental-strip-types` is a no-op on Node 24, which strips natively;
  // the flag is kept off so this test asserts the real runtime behavior.
  child = spawn(process.execPath, [SERVER], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), EGA_WEB_ARTIFACT_DIR: "", EGA_WEB_RETAINED_MANIFEST: "" },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.resume();
  await waitForReady();
});

after(() => {
  child?.kill("SIGKILL");
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

async function readFileText(path) {
  return readFile(path, "utf8");
}

async function waitForReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server.mts did not become healthy in time");
}

test("GET /healthz reports a live process", async () => {
  const response = await fetch(`${BASE}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /readyz reports unavailable when no release artifact is configured", async () => {
  // The console must never claim readiness it cannot back up: with no artifact
  // directory and no retained manifest, /readyz is a 503.
  const response = await fetch(`${BASE}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "unavailable");
  assert.equal(typeof body.detail, "string");
  assert.ok(body.detail.length > 0, "the reason must be stated");
});

test("an unknown /api path answers a controlled 404, never a stack trace", async () => {
  const response = await fetch(`${BASE}/api/releases`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.deepEqual(body, { error: { code: "E_NOT_FOUND", message: "No such route." } });
  assert.equal(response.headers.get("content-type").includes("application/json"), true);
});

test("/api with no path segment is also a controlled 404", async () => {
  const response = await fetch(`${BASE}/api`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "E_NOT_FOUND");
});

test("a built asset is served with a fingerprinted cache policy", async () => {
  const response = await fetch(`${BASE}/assets/index-test.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("an unknown non-API GET falls back to the SPA shell", async () => {
  const response = await fetch(`${BASE}/skills/alpha`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.match(await response.text(), /id=root/);
});

test("a deep SPA route also reaches the shell rather than a 404", async () => {
  const response = await fetch(`${BASE}/workspace/quotas`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id=root/);
});

test("path traversal cannot escape dist/", async () => {
  for (const attempt of ["/../server.mts", "/%2e%2e/server.mts", "/assets/../../server.mts"]) {
    const response = await fetch(`${BASE}${attempt}`);
    assert.match(await response.text(), /id=root/, `${attempt} must not serve server source`);
    assert.equal(response.status, 200);
  }
});

test("security headers are present on every response", async () => {
  const response = await fetch(`${BASE}/healthz`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=()",
  );
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' https:\/\/\*\.supabase\.co/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /font-src 'self'/);
});

test("an unregistered /api path 404s whatever the method", async () => {
  // No route is registered yet, so Builder 2's boundary is visible: an unknown
  // path answers a controlled 404 and never reaches a handler.
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await fetch(`${BASE}/api/releases`, { method });
    assert.equal(response.status, 404, `${method} must not reach a handler`);
    assert.equal((await response.json()).error.code, "E_NOT_FOUND");
  }
});

test("a write verb outside /api is refused too, never falling through to the SPA", async () => {
  const response = await fetch(`${BASE}/skills`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("dir resolves to the SPA shell, which the router then renders as Overview", async () => {
  const response = await fetch(`${BASE}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id=root/);
});

test("the served index.html is the one in dist/, confirming cwd-relative resolution", async () => {
  const response = await fetch(`${BASE}/index.html`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), await readFileText(join(distDir, "index.html")));
});