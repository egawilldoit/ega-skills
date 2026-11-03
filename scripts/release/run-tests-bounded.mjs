#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { ownedFiles, discover } from "../ci/ownership.mjs";

const DEFAULT_PER_TEST_TIMEOUT_MS = 600_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 1_500_000;
const TERM_GRACE_MS = 10_000;
const MAX_TEST_CONCURRENCY = 32;

// Node's documented default for `--test-concurrency` under process isolation is
// `availableParallelism() - 1`. The workflow does not set the flag unless an
// explicit benchmark value is requested, so this is what actually runs today.
// Logging it never changes the value; it only records what the runner resolved.
function documentedDefaultConcurrency() {
  const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, available - 1);
}

function parseConcurrency(raw, source) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw);
  if (text === "") return null;
  // Strict: no surrounding whitespace, no sign, no decimal. The workflow input
  // validator uses the same shape, so a value that passes one passes both.
  if (!/^\d+$/.test(text)) {
    throw new Error(`${source} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(text);
  if (value < 1 || value > MAX_TEST_CONCURRENCY) {
    throw new Error(`${source} must be between 1 and ${MAX_TEST_CONCURRENCY}, got ${value}`);
  }
  return value;
}

function readForwardedConcurrency(forwarded) {
  const values = [];
  for (let i = 0; i < forwarded.length; i += 1) {
    const arg = forwarded[i];
    const inline = arg.match(/^--test-concurrency=(\d+)$/);
    if (inline) {
      values.push(parseConcurrency(inline[1], "--test-concurrency"));
      continue;
    }
    if (arg === "--test-concurrency") {
      values.push(parseConcurrency(forwarded[i + 1], "--test-concurrency"));
      i += 1;
    }
  }
  if (new Set(values).size > 1) throw new Error("Conflicting --test-concurrency values");
  return values.length ? values[0] : null;
}

function readIsolation(forwarded) {
  for (let i = 0; i < forwarded.length; i += 1) {
    const arg = forwarded[i];
    const inline = arg.match(/^--test-isolation=(.+)$/);
    if (inline) return inline[1];
    if (arg === "--test-isolation") return forwarded[i + 1] ?? "unknown";
  }
  return "process (Node default)";
}

function envMs(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseArgs(argv) {
  const forwarded = [];
  let perTestTimeoutMs = DEFAULT_PER_TEST_TIMEOUT_MS;
  let overallTimeoutMs = envMs("EGA_TEST_OVERALL_TIMEOUT_MS", DEFAULT_OVERALL_TIMEOUT_MS);
  let seenSeparator = false;
  for (const arg of argv) {
    if (seenSeparator) {
      forwarded.push(arg);
      continue;
    }
    if (arg === "--") {
      seenSeparator = true;
      continue;
    }
    const perTest = arg.match(/^--per-test-timeout-ms=(\d+)$/);
    if (perTest) {
      perTestTimeoutMs = Number(perTest[1]);
      continue;
    }
    const overall = arg.match(/^--overall-timeout-ms=(\d+)$/);
    if (overall) {
      overallTimeoutMs = Number(overall[1]);
      continue;
    }
    forwarded.push(arg);
  }
  if (process.env.EGA_TEST_PER_TEST_TIMEOUT_MS) {
    perTestTimeoutMs = envMs("EGA_TEST_PER_TEST_TIMEOUT_MS", perTestTimeoutMs);
  }
  return { forwarded, perTestTimeoutMs, overallTimeoutMs };
}

function readProcProcesses() {
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const pid = Number(entry);
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .split("\0")
        .filter((part) => part.length > 0)
        .join(" ");
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      processes.push({ pid, ppid, cmdline });
    } catch {
      continue;
    }
  }
  return processes;
}

function readPsProcesses() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  const processes = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), cmdline: match[3] });
  }
  return processes;
}

function listProcesses() {
  if (process.platform === "linux") {
    try {
      return readProcProcesses();
    } catch {
      return [];
    }
  }
  if (process.platform === "win32") return [];
  try {
    return readPsProcesses();
  } catch {
    return [];
  }
}

function descendantProcesses(rootPid) {
  const all = listProcesses();
  const byParent = new Map();
  for (const proc of all) {
    const children = byParent.get(proc.ppid) ?? [];
    children.push(proc);
    byParent.set(proc.ppid, children);
  }
  const found = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function describeSurvivors(rootPid) {
  const survivors = descendantProcesses(rootPid);
  const lines = [];
  if (survivors.length === 0) {
    lines.push("  (no surviving descendant processes visible)");
    return lines;
  }
  for (const proc of survivors) {
    // A surviving process is test-related when it is running a test file or a
    // test support file. `.fixture.mjs` and friends are the harness's own
    // fixtures, so omitting them made the evidence drop the marker whenever the
    // fixture runner was the only process left alive at the bound.
    const marker = /\.(test|fixture|helper)\.mjs|ega-mcp\.mjs|ega-skill/.test(proc.cmdline) ? " <== test-related" : "";
    lines.push(`  pid=${proc.pid} ppid=${proc.ppid} ${proc.cmdline}${marker}`);
  }
  return lines;
}

function killTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const { forwarded, perTestTimeoutMs, overallTimeoutMs } = parseArgs(process.argv.slice(2));
const scopes = forwarded.filter((arg) => arg.startsWith("--ci-scope="));
if (scopes.length > 1) throw new Error("Only one CI scope may be specified");
const scope = scopes.length ? scopes[0].slice("--ci-scope=".length) : null;
const selected = scope ? ownedFiles(scope) : [];
const forwardedConcurrency = readForwardedConcurrency(forwarded);
const envConcurrency = parseConcurrency(process.env.EGA_TEST_CONCURRENCY, "EGA_TEST_CONCURRENCY");
if (forwardedConcurrency !== null && envConcurrency !== null && forwardedConcurrency !== envConcurrency) {
  throw new Error(
    `EGA_TEST_CONCURRENCY (${envConcurrency}) conflicts with --test-concurrency (${forwardedConcurrency})`,
  );
}
const explicitConcurrency = forwardedConcurrency ?? envConcurrency;
// Only inject the flag when the caller did not already pass it, so the forwarded
// argv stays exactly what the workflow asked for.
const concurrencyArgs =
  envConcurrency === null || forwardedConcurrency !== null ? [] : [`--test-concurrency=${envConcurrency}`];
const nodeArgs = [
  "--test",
  `--test-timeout=${perTestTimeoutMs}`,
  ...concurrencyArgs,
  ...forwarded.filter((arg) => !arg.startsWith("--ci-scope=")),
  ...selected,
];

// One machine-readable line so a hosted log proves the runtime it actually used
// instead of inferring it from the runner label. It never contains paths, tokens,
// or environment values other than the concurrency variable already selected.
const availableParallelism =
  typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const runtime = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  availableParallelism,
  cpuCount: os.cpus().length,
  totalMemMiB: Math.round(os.totalmem() / 1024 / 1024),
  testIsolation: readIsolation(forwarded),
  testConcurrency: explicitConcurrency ?? documentedDefaultConcurrency(),
  testConcurrencySource:
    explicitConcurrency === null
      ? "default (availableParallelism - 1)"
      : forwardedConcurrency !== null
        ? "flag"
        : "EGA_TEST_CONCURRENCY",
  scope: scope ?? "unscoped",
  files: scope ? selected.length : "default discovery",
  // For the unscoped Windows suite, record the default-discovery inventory so the
  // log itself proves how many files the run covered. It uses the same declared
  // glob as the ownership check; an explicit scope already returns its own list.
  discoveredFiles: scope ? selected.length : discover().length,
};
process.stderr.write(`[test:bounded] runtime ${JSON.stringify(runtime)}\n`);

process.stderr.write(
  `[test:bounded] node ${nodeArgs.join(" ")}\n` +
    `[test:bounded] per-test timeout ${perTestTimeoutMs} ms, overall bound ${overallTimeoutMs} ms\n`,
);

const startedAt = Date.now();
const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  detached: process.platform !== "win32",
  env: process.env,
});

let timedOut = false;
let forwardSignal = null;
const overallTimer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `\n[test:bounded] OVERALL TIMEOUT after ${Date.now() - startedAt} ms ` +
      `(bound ${overallTimeoutMs} ms). The suite did not terminate; collecting evidence.\n`,
  );
  process.stderr.write("[test:bounded] surviving descendant processes:\n");
  for (const line of describeSurvivors(child.pid)) process.stderr.write(`${line}\n`);
  process.stderr.write(
    "[test:bounded] This usually means a test left an open handle (server, timer, child process, or stdio pipe) " +
      "alive after its file finished. Fix the lifecycle owner; do not raise the bound.\n\n",
  );
  killTree(child, "SIGTERM");
  void waitForExit(child, TERM_GRACE_MS).then((exited) => {
    if (!exited) {
      process.stderr.write("[test:bounded] SIGTERM did not stop the tree; sending SIGKILL.\n");
      killTree(child, "SIGKILL");
    }
  });
}, overallTimeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardSignal = signal;
    killTree(child, signal);
  });
}

child.once("exit", async (code, signal) => {
  clearTimeout(overallTimer);
  const elapsed = Date.now() - startedAt;
  await waitForExit(child, 1000);
  if (timedOut) {
    process.stderr.write(`[test:bounded] suite killed after ${elapsed} ms by the overall bound\n`);
    process.exit(124);
  }
  if (forwardSignal) {
    process.stderr.write(`[test:bounded] forward signal ${forwardSignal}; suite exited after ${elapsed} ms\n`);
    process.exit(code ?? 143);
  }
  process.stderr.write(`[test:bounded] suite exited code=${code} signal=${signal} after ${elapsed} ms\n`);
  if (signal !== null) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
