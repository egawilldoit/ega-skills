/**
 * Contract tests for the console BFF entrypoint.
 *
 * `server.mts` starts an HTTP server on import, so it is exercised the way it
 * actually runs: boot it on a dedicated test port with `dist/` present, then assert
 * the real HTTP responses. This covers the routes Builder 2 will extend without
 * rewriting the file — /healthz, /readyz, the /api 404 boundary, the SPA
 * fallback, and the read-only method rejection.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(REPO_ROOT, "apps", "web", "server.mts");
/** The real committed immutable release artifact, used where a verified release is required. */
const COMMITTED_ARTIFACT_DIR = join(REPO_ROOT, "packages", "mcp", "artifact");
const PORT = 34117;
const BASE = `http://127.0.0.1:${PORT}`;

/** Test-owned child state: drain both pipes and retain only the last 8 KiB. */
const childStates = new WeakMap();
const STDERR_LIMIT = 8192;
const SAFE_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EINVAL", "EADDRINUSE", "EADDRNOTAVAIL",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ERR_MODULE_NOT_FOUND",
  "ERR_UNKNOWN_FILE_EXTENSION", "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

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
  child = startChild(process.execPath, [SERVER], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), EGA_WEB_ARTIFACT_DIR: "", EGA_WEB_RETAINED_MANIFEST: "" },
  });
  await waitForReady();
});

after(async () => {
  await stopChild(child);
  if (workdir) removeTreeWithRetries(workdir);
});

function safeError(error) {
  // Never include message, stack, path, argv, env, or nested error text.
  const name = ["Error", "TypeError", "SyntaxError", "ReferenceError", "AbortError", "TimeoutError"].includes(error?.name)
    ? error.name : "Error";
  const code = SAFE_CODES.has(error?.code) ? error.code : "unreported";
  return `${name}/${code}`;
}
function safeStderr(state) {
  // An allowlisted projection is safer than trying to blacklist every secret
  // syntax in arbitrary exception text. Unknown lines (including URLs, headers,
  // env values and source excerpts) are entirely redacted.
  return state.stderr.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-12).map((line) => {
    if (/^ega-web-console listening on \d{1,5}$/.test(line)) return line;
    const codes = [...SAFE_CODES].filter((code) => new RegExp(`\\b${code}\\b`).test(line));
    const kind = line.match(/\b(Error|TypeError|SyntaxError|ReferenceError|RangeError):/)?.[1];
    return `${kind ?? "stderr"}${codes.length ? ` ${codes.join(",")}` : ""}: [redacted]`;
  }).join(" | ") || "(empty)";
}
function startChild(...args) {
  const proc = spawn(...args);
  let failed;
  let closed;
  const state = {
    stderr: Buffer.alloc(0), truncated: false, error: null,
    exited: false, closed: false, code: null, signal: null,
    failed: new Promise((resolve) => { failed = resolve; }),
    done: new Promise((resolve) => { closed = resolve; }),
  };
  childStates.set(proc, state);
  proc.stdout?.resume();
  proc.stderr?.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.truncated ||= state.stderr.length + bytes.length > STDERR_LIMIT;
    state.stderr = Buffer.from(Buffer.concat([state.stderr, bytes]).subarray(-STDERR_LIMIT));
  });
  proc.on("error", (error) => { state.error = safeError(error); failed("child error before response"); });
  proc.once("exit", (code, signal) => {
    Object.assign(state, { exited: true, code, signal });
    failed("child exit before response");
  });
  proc.once("close", (code, signal) => {
    Object.assign(state, { closed: true, code, signal });
    failed("child close before response");
    closed();
  });
  return proc;
}
function childDiagnostics(proc) {
  const state = childStates.get(proc);
  return `error=${state.error ?? "none"}; exit=${state.exited}; close=${state.closed}; ` +
    `code=${state.code}; signal=${state.signal}; stderr_tail_truncated=${state.truncated}; ` +
    `stderr=${safeStderr(state)}`;
}

/** Reap through close (including stdio); never silently accept a cleanup timeout. */
async function stopChild(proc, timeoutMs = 10_000) {
  if (!proc) return;
  const state = childStates.get(proc);
  if (state.closed) return;
  let timer;
  try {
    if (proc.pid !== undefined && !state.exited) proc.kill("SIGKILL");
    await Promise.race([
      state.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`child cleanup deadline exceeded; ${childDiagnostics(proc)}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The existing poll interval and 20s bound, now covering fetch AND body reads. */
async function waitForResponse(proc, url, { timeoutMs = 20_000, healthy = false } = {}) {
  const controller = new AbortController();
  const state = childStates.get(proc);
  let timer;
  let transport = "none";
  try {
    return await Promise.race([
      (async () => {
        while (!controller.signal.aborted) {
          try {
            const response = await fetch(url, { signal: controller.signal });
            const body = await response.json();
            if (!healthy || response.ok) return { status: response.status, body };
          } catch (error) {
            transport = safeError(error?.cause ?? error);
            if (controller.signal.aborted) throw error;
          }
          await delay(100, undefined, { signal: controller.signal });
        }
      })(),
      state.failed.then((reason) => { throw new Error(reason); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`startup deadline exceeded (${timeoutMs} ms)`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    // Close drains the final stderr bytes and releases Windows cwd handles.
    controller.abort();
    await stopChild(proc);
    throw new Error(`${error.message}; port=${new URL(url).port}; transport=${transport}; ${childDiagnostics(proc)}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Remove a tree, retrying while the OS still reports the handles as busy.
 *
 * On Windows an antivirus scanner or a just-exited child can hold a transient
 * handle that `rmSync` cannot take on the first attempt. `{ force: true }`
 * already swallows ENOENT for files that vanished mid-removal; what it cannot
 * swallow is EBUSY/EPERM on a directory that still has an open handle. Those are
 * transient by construction, so retrying with a short backoff resolves them
 * without hiding a genuine failure — the last attempt's error still propagates.
 *
 * The delay is synchronous because this runs inside node:test's `after` hook,
 * where returning a promise is the only way to await; a blocking sleep keeps the
 * ordering of the teardown steps explicit.
 */
function removeTreeWithRetries(path, attempts = 10, delayMs = 100) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = error?.code === "EPERM" || error?.code === "EBUSY";
      if (!retryable || attempt >= attempts) throw error;
      sleepSync(delayMs);
    }
  }
}

/** Synchronous backoff, for use inside a test teardown hook. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function readFileText(path) {
  return readFile(path, "utf8");
}

async function waitForReady() {
  await waitForResponse(child, `${BASE}/healthz`, { healthy: true });
}

test("GET /healthz reports a live process", async () => {
  const response = await fetch(`${BASE}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /readyz reports unavailable when no release artifact is configured", async () => {
  // The console must never claim readiness it cannot back up. The child is
  // booted with both artifact variables set to the empty string, which counts
  // as unset: a declared-but-blank env var must not read as a real path.
  const response = await fetch(`${BASE}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "unavailable");
  assert.match(body.detail, /EGA_WEB_ARTIFACT_DIR/);
  assert.ok(body.detail.length > 0, "the reason must be stated");
});

test("/readyz stays 503 for an artifact directory that does not exist", async () => {
  // Proves the probe checks the filesystem, not just the presence of the
  // variable: a configured-but-absent directory must not report ready.
  const response = await awaitReadyzFor({ EGA_WEB_ARTIFACT_DIR: join(workdir, "no-such-dir") });
  assert.equal(response.status, 503);
  assert.equal(response.body.status, "unavailable");
  assert.match(response.body.detail, /does not resolve to an existing directory/);
});

test("/readyz reports ready only when the artifact directory actually exists", async () => {
  // The fixture's `dist/` contains an index.html and an assets/ directory, so it
  // EXISTS as a directory but holds no release artifact. That is exactly the case
  // the real probe must catch: a present directory is not a verified release. The
  // previous expectation of 200 pinned the pre-route bootstrap probe, which only
  // checked configuration and filesystem presence.
  const missingRelease = await awaitReadyzFor({ EGA_WEB_ARTIFACT_DIR: distDir });
  assert.equal(missingRelease.status, 503);
  assert.equal(missingRelease.body.status, "unavailable");

  // The positive case now needs a real, verified artifact.
  const real = await awaitReadyzFor({ EGA_WEB_ARTIFACT_DIR: COMMITTED_ARTIFACT_DIR });
  assert.equal(real.status, 200);
  assert.equal(real.body.status, "ready");
});

test("/readyz rejects an artifact path that exists but is a file", async () => {
  const response = await awaitReadyzFor({
    EGA_WEB_ARTIFACT_DIR: join(distDir, "index.html"),
  });
  assert.equal(response.status, 503);
  assert.match(response.body.detail, /not a directory/);
});

test("/readyz stays 503 when only a retained manifest is configured", async () => {
  // A manifest says which digests are authorized; it is not itself readable
  // release content, so it cannot make the deployment ready on its own.
  const manifest = join(workdir, "retained.json");
  writeFileSync(manifest, "{}\n");
  const response = await awaitReadyzFor({
    EGA_WEB_ARTIFACT_DIR: "",
    EGA_WEB_RETAINED_MANIFEST: manifest,
  });
  assert.equal(response.status, 503);
  assert.match(response.body.detail, /EGA_WEB_ARTIFACT_DIR is not configured/);
});

/**
 * Boot a second server with specific readiness env, query /readyz, then stop it.
 * Kept separate from the shared fixture so each readiness rule is proven against
 * a real process rather than a re-implementation of the probe.
 */
async function awaitReadyzFor(env) {
  const port = PORT + 100 + readyzCounter++;
  const proc = startChild(process.execPath, [SERVER], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), EGA_WEB_ARTIFACT_DIR: "", EGA_WEB_RETAINED_MANIFEST: "", ...env },
  });
  try {
    return await waitForResponse(proc, `http://127.0.0.1:${port}/readyz`);
  } finally {
    await stopChild(proc);
  }
}

let readyzCounter = 0;

test("an unknown /api path answers a controlled 404, never a stack trace", async () => {
  // A path that is deliberately NOT registered. `/api/releases` used to be used
  // here, but it is now a real route, so probing it would assert the route's
  // behaviour rather than the unknown-path boundary.
  const response = await fetch(`${BASE}/api/no-such-view`);
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
  // The boundary is visible on a path no route claims: an unknown path answers a
  // controlled 404 for every method and never reaches a handler. A REGISTERED
  // path is the opposite case and is asserted separately (405 with an Allow
  // header), so this must probe a path that is genuinely unregistered.
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await fetch(`${BASE}/api/no-such-view`, { method });
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

/**
 * EGA-720 regression: an unexpected exception inside a real BFF route must be
 * diagnosable without printing its text to stderr.
 *
 * The old catch block wrote `cause.message` (or `String(cause)`) into stderr
 * under a "sanitized" comment; such text can embed request URLs or credentials,
 * including through a nested `cause`. The repair logs only the route id and the
 * fixed internal code, so this test drives the REAL server process and asserts
 * the whole stderr stream — not just one matched line.
 *
 * The throwing route is injected through the exported `API_ROUTES` seam by a
 * small child-side harness module, so the exercise is the genuine HTTP handler
 * (`server.mts`'s catch block) rather than a re-implementation of it.
 */
test("an unexpected route failure logs no exception text: 500 stays generic (EGA-720)", async () => {
  const canary = "SYNTHETIC_SECRET_CANARY";
  const port = PORT + 200;
  const base = `http://127.0.0.1:${port}`;
  const harness = join(workdir, "ega720-throw-route.mjs");
  writeFileSync(
    harness,
    `const mod = await import(${JSON.stringify(pathToFileURL(SERVER).href)});
mod.API_ROUTES.push({
  id: "ega720-canary-throw",
  path: "/__ega720_canary_throw",
  methods: ["GET"],
  handle() {
    throw new Error(
      "unexpected handler failure: upstream call to http://127.0.0.1:${port}/api/secret?token=${canary} failed",
      { cause: new Error("ECONNREFUSED 127.0.0.1:${port}; Authorization: Bearer ${canary}") },
    );
  },
});
`,
  );

  const proc = startChild(process.execPath, [harness], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), EGA_WEB_ARTIFACT_DIR: "", EGA_WEB_RETAINED_MANIFEST: "" },
  });
  proc.stdout.resume();
  proc.stderr.setEncoding("utf8");
  const stderrChunks = [];
  proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  try {
    // Wait for the injected route itself: /healthz only proves the process is
    // up, but the route must be registered before the probe can exercise the
    // catch block.
    let response;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`${base}/api/__ega720_canary_throw`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, "the canary server never answered");

    // HTTP boundary: the caller gets a generic 500 whose body carries no detail.
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, {
      error: { code: "E_INTERNAL", message: "The console API failed to handle this request." },
    });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.ok(!JSON.stringify(body).includes(canary), "the HTTP body must not echo the canary");

    // Log boundary: the entire stderr stream of the real server process must be
    // free of the canary, top-level message and nested cause alike, while still
    // naming the failing route for diagnosis.
    //
    // The child's stderr writes to a pipe are not guaranteed to have been
    // dispatched to this parent when the HTTP response arrives (POSIX pipe
    // delivery is asynchronous on some platforms). Asserting on a still-empty
    // capture would read as a flaky failure of the diagnostic assertion — and,
    // in a hypothetical future refactor that logs after responding, a vacuous
    // pass of the leak assertion. So wait, bounded, until the bounded
    // diagnostic line itself has been delivered: the leak check is only sound
    // once the very line that could carry the leak has arrived.
    const logDeadline = Date.now() + 5000;
    let stderr = stderrChunks.join("");
    while (
      !stderr.includes("ega-web route ega720-canary-throw failed: E_INTERNAL\n") &&
      Date.now() < logDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stderr = stderrChunks.join("");
    }
    assert.ok(!stderr.includes(canary), `stderr leaked the canary:\n${stderr}`);
    assert.ok(
      stderr.includes("ega-web route ega720-canary-throw failed: E_INTERNAL\n"),
      `stderr must carry only the bounded diagnostic line, got:\n${stderr}`,
    );

    // An ordinary successful route on the same process is unchanged.
    const healthy = await fetch(`${base}/healthz`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: "ok" });
  } finally {
    await stopChild(proc);
  }
});

// Exercise the lifecycle with real children, without adding discovered files.
test("startup diagnostics reap an early exit, drain stdout, and redact bounded stderr", async () => {
  const proc = startChild(process.execPath, ["-e", `
    process.stdout.write("x".repeat(2 * 1024 * 1024));
    process.stderr.write("x".repeat(16000) + "\\nReferenceError: SYNTHETIC_SECRET_CANARY\\nAuthorization: Bearer SYNTHETIC_SECRET_CANARY\\nhttps://user:password@example.invalid/?token=SYNTHETIC_SECRET_CANARY\\n");
    process.exitCode = 23;
  `], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    // No probe connection can mask a child failure in this regression.
    await assert.rejects(waitForResponse(proc, "http://127.0.0.1:0/readyz"), (error) => {
      assert.match(error.message, /child (exit|close) before response/);
      assert.match(error.message, /exit=true; close=true; code=23; signal=null/);
      assert.match(error.message, /stderr_tail_truncated=true/);
      assert.match(error.message, /ReferenceError: \[redacted\]/);
      assert.doesNotMatch(error.message, /SYNTHETIC_SECRET_CANARY|Authorization|password|https:/);
      assert.ok(childStates.get(proc).stderr.length <= STDERR_LIMIT);
      return true;
    });
  } finally {
    await stopChild(proc);
  }
});

test("startup diagnostics report and reap spawn failure without waiting for readiness", async () => {
  const proc = startChild(join(workdir, "nonexistent-child-executable"), [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await assert.rejects(waitForResponse(proc, "http://127.0.0.1:0/readyz"), (error) => {
      assert.match(error.message, /child error before response/);
      assert.match(error.message, /error=Error\/ENOENT/);
      assert.match(error.message, /close=true; code=-\d+; signal=null/);
      assert.ok(!error.message.includes(workdir), "spawn error paths must be redacted");
      return true;
    });
  } finally {
    await stopChild(proc);
  }
});

test("startup deadline aborts a stalled response body and reaps the child", async () => {
  let requested = false;
  const server = createServer((_request, response) => {
    requested = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":'); // Deliberately never completes the response.
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const proc = startChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await assert.rejects(waitForResponse(proc, `http://127.0.0.1:${server.address().port}/readyz`, {
      timeoutMs: 1000,
    }), /startup deadline exceeded \(1000 ms\).*close=true/);
    assert.equal(childStates.get(proc).closed, true);
    assert.equal(requested, true, "the deadline must cover a pending body read");
  } finally {
    await stopChild(proc);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("startup diagnostics identify a controlled address-in-use failure", async () => {
  const owner = createServer();
  await new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.listen(0, "127.0.0.1", resolve);
  });
  const proc = startChild(process.execPath, ["-e",
    `require("node:http").createServer().listen(${owner.address().port}, "127.0.0.1")`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await assert.rejects(waitForResponse(proc, "http://127.0.0.1:0/readyz"), (error) => {
      assert.match(error.message, /child (exit|close) before response/);
      assert.match(error.message, /code=1; signal=null/);
      assert.match(error.message, /stderr=.*EADDRINUSE/);
      return true;
    });
  } finally {
    await stopChild(proc);
    await new Promise((resolve, reject) => owner.close((error) => error ? reject(error) : resolve()));
  }
});
