import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/lifecycle-suite.fixture.mjs", import.meta.url));
const LEAKY_FIXTURE = fileURLToPath(new URL("./fixtures/leaky-suite.fixture.mjs", import.meta.url));
const BOUNDED_RUNNER = fileURLToPath(new URL("../../scripts/release/run-tests-bounded.mjs", import.meta.url));

function run(command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
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
      reject(new Error(`command timed out after ${timeoutMs} ms: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`));
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

function processTable() {
  if (process.platform !== "linux") return [];
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      processes.push({ pid: Number(entry), cmdline });
    } catch {
      continue;
    }
  }
  return processes;
}

test("a late exit listener still observes an already-exited child", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.notEqual(child.exitCode, null, "child must have exited before the listener attaches");
  const result = child.exitCode !== null || child.signalCode !== null
    ? { code: child.exitCode, signal: child.signalCode }
    : await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(result, { code: 7, signal: null });
});

test("spawned node:test suite terminates, closes streams, frees its temp dir, and leaves no descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "ega-release-lifecycle-"));
  const result = await run(process.execPath, ["--test", FIXTURE], {
    timeoutMs: 60_000,
    env: { EGA_LIFECYCLE_FIXTURE_ROOT: root },
  });
  assert.equal(result.signal, null, `fixture must not be signalled\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.code, 0, `fixture suite must exit 0\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /fixture launches, works, and cleans up/);
  assert.equal(existsSync(join(root, "artifact", "done.txt")), true, "fixture work must complete before exit");

  const leftovers = processTable().filter((proc) => proc.cmdline.includes(root));
  assert.deepEqual(leftovers, [], `fixture descendants survived: ${JSON.stringify(leftovers)}`);

  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, "temporary directory must be removable after the suite exits");
});

test("bounded runner kills a leaked-handle suite at the overall bound and names the stuck file", async () => {
  const startedAt = Date.now();
  const result = await run(process.execPath, [BOUNDED_RUNNER, "--overall-timeout-ms=4000", "--per-test-timeout-ms=2000", LEAKY_FIXTURE], {
    timeoutMs: 45_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.signal, null, "bounded runner must terminate the tree by itself");
  assert.equal(result.code, 124, `bounded runner must fail with the timeout code\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /OVERALL TIMEOUT/);
  assert.ok(elapsed < 30_000, `bounded runner must stop near its bound, took ${elapsed} ms`);
  if (process.platform === "linux") {
    assert.match(result.stderr, /leaky-suite\.fixture\.mjs <== test-related/, "evidence must name the stuck file");
  }
});
