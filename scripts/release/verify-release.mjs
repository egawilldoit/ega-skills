#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LOG_ROOT = process.env.EGA_RELEASE_VERIFY_LOG_DIR ?? join(tmpdir(), `ega-release-verify-${process.pid}`);
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const NODE = process.execPath;

function testFiles(relativeDir) {
  const dir = join(REPO_ROOT, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `${relativeDir}/${name}`)
    .sort();
}

function exists(relativePath) {
  return existsSync(join(REPO_ROOT, relativePath));
}

function stages() {
  const oauthTests = testFiles("tests/oauth");
  const list = [
    { name: "install:frozen-lockfile", command: [PNPM, "install", "--frozen-lockfile"] },
    { name: "lockfile:clean", command: ["git", "diff", "--exit-code", "--", "pnpm-lock.yaml"] },
    { name: "build", command: [PNPM, "build"] },
    { name: "typecheck", command: [PNPM, "typecheck"] },
    { name: "specs:check", command: [PNPM, "specs:check"] },
    { name: "contracts:check-a", command: [PNPM, "contracts:check-a"] },
    { name: "contracts:check-b", command: [PNPM, "contracts:check-b"] },
    { name: "contracts:check-c", command: [PNPM, "contracts:check-c"] },
    { name: "contracts:check-g", command: [PNPM, "contracts:check-g"] },
    { name: "versions:consistent", command: [NODE, "--test", "tests/release/version-consistency.test.mjs"] },
    { name: "registry:performance", command: [PNPM, "test:perf:registry"] },
    {
      name: "tokens:vectors",
      command: [NODE, "--test", "tests/tokens/canonicalization.test.mjs", "tests/tokens/errors.test.mjs", "tests/tokens/offline.test.mjs", "tests/tokens/token-estimator.test.mjs"],
    },
    { name: "lifecycle:termination-regression", command: [NODE, "--test", "tests/release/lifecycle-termination.test.mjs"] },
    { name: "test:full-suite", command: [PNPM, "test:ci"] },
    { name: "e2e:publication", command: [NODE, "--test", "tests/cli/intake-publication-e2e.test.mjs"] },
  ];
  if (exists("tests/cli/intake-derivative-publication-e2e.test.mjs")) {
    list.push({ name: "e2e:derivative-publication", command: [NODE, "--test", "tests/cli/intake-derivative-publication-e2e.test.mjs"] });
  }
  list.push({ name: "retained:serving", command: [NODE, "--test", "tests/mcp/retained-serving.test.mjs"] });
  if (oauthTests.length > 0) {
    list.push({ name: "oauth:offline", command: [NODE, "--test", ...oauthTests] });
  }
  if (exists("scripts/hosted/validate-artifact.mjs")) {
    list.push({ name: "artifact:validation", command: [NODE, "scripts/release/validate-sample-artifact.mjs"] });
  }
  list.push({ name: "git:diff-check", command: ["git", "diff", "--check"] });
  return list;
}

function parseArgs(argv) {
  const only = [];
  const skip = [];
  let list = false;
  for (const arg of argv) {
    if (arg === "--list") {
      list = true;
      continue;
    }
    const onlyMatch = arg.match(/^--only=(.+)$/);
    if (onlyMatch) {
      only.push(...onlyMatch[1].split(",").map((value) => value.trim()).filter(Boolean));
      continue;
    }
    const skipMatch = arg.match(/^--skip=(.+)$/);
    if (skipMatch) {
      skip.push(...skipMatch[1].split(",").map((value) => value.trim()).filter(Boolean));
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return { only, skip, list };
}

function tailLines(text, count) {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function runStage(stage, logPath) {
  return new Promise((resolveStage) => {
    const startedAt = Date.now();
    process.stdout.write(`\n=== [release:verify] ${stage.name}: ${stage.command.join(" ")}\n`);
    const child = spawn(stage.command[0], stage.command.slice(1), {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(stage.env ?? {}) },
    });
    const log = createWriteStream(logPath, { flags: "w" });
    const capture = { stdout: "", stderr: "" };
    const tee = (stream, target) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        target.write(chunk);
        log.write(chunk);
        capture[stream === child.stdout ? "stdout" : "stderr"] = `${capture[stream === child.stdout ? "stdout" : "stderr"]}${chunk}`.slice(-200_000);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.once("error", (error) => {
      log.end();
      resolveStage({ ...stage, code: 127, signal: null, ms: Date.now() - startedAt, logPath, error: String(error) });
    });
    child.once("close", (code, signal) => {
      log.end();
      resolveStage({ ...stage, code, signal, ms: Date.now() - startedAt, logPath, output: capture });
    });
  });
}

const { only, skip, list } = parseArgs(process.argv.slice(2));
const allStages = stages();
if (list) {
  for (const stage of allStages) process.stdout.write(`${stage.name}\t${stage.command.join(" ")}\n`);
  process.exit(0);
}
const selected = allStages.filter((stage) => (only.length === 0 || only.includes(stage.name)) && !skip.includes(stage.name));
if (selected.length === 0) {
  process.stderr.write("[release:verify] no stages selected\n");
  process.exit(2);
}

mkdirSync(LOG_ROOT, { recursive: true });
process.stdout.write(`[release:verify] ${selected.length}/${allStages.length} stages; logs in ${LOG_ROOT}\n`);

const results = [];
let failed = null;
for (const stage of selected) {
  const logPath = join(LOG_ROOT, `${stage.name.replaceAll(":", "_")}.log`);
  const result = await runStage(stage, logPath);
  results.push(result);
  if (result.code !== 0 || result.signal !== null) {
    failed = result;
    break;
  }
  process.stdout.write(`✔ [release:verify] ${stage.name} (${(result.ms / 1000).toFixed(1)}s)\n`);
}

process.stdout.write("\n[release:verify] summary\n");
for (const result of results) {
  const status = result.code === 0 && result.signal === null ? "PASS" : "FAIL";
  process.stdout.write(`  ${status}  ${result.name}  ${(result.ms / 1000).toFixed(1)}s  ${result.logPath}\n`);
}
if (failed !== null) {
  process.stderr.write(`\n[release:verify] FAILED stage ${failed.name} (exit=${failed.code} signal=${failed.signal})\n`);
  if (failed.output) {
    process.stderr.write("[release:verify] last output:\n");
    process.stderr.write(`${tailLines(`${failed.output.stdout}\n${failed.output.stderr}`, 40)}\n`);
  }
  process.exit(1);
}
process.stdout.write(`[release:verify] all ${results.length} stages passed\n`);
process.exit(0);
