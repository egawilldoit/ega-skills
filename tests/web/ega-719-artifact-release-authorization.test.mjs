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
  if (webChild) webChild.kill("SIGKILL");
  if (mockServer) mockServer.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

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
  child.kill("SIGKILL");
});

test("EGA-719: caller that cannot read the release is denied (403)", async () => {
  const r = await req(BASE, `/api/skills/${encodeURIComponent("anthropic/claude-api")}/content?level=L2`, "valid-token-unauthorized");
  assert.equal(r.status, 403, r.text);
  assert.equal(r.body?.error?.code, "E_WEB_CONTROL_PLANE_FORBIDDEN");
  assert.equal(r.body?.content, undefined, "no artifact bytes may be served");
});
