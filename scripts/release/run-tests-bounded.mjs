#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const DEFAULT_PER_TEST_TIMEOUT_MS = 600_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 1_500_000;
const TERM_GRACE_MS = 10_000;

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
    const marker = /\.test\.mjs|ega-mcp\.mjs|ega-skill/.test(proc.cmdline) ? " <== test-related" : "";
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
const nodeArgs = ["--test", `--test-timeout=${perTestTimeoutMs}`, ...forwarded];

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
