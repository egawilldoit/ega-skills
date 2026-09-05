// MCP shared project/runtime boundary tests (SPEC-006 §5.1.4, §5.3, EGA-589).
//
// Proves the ONE effective-project normalization helper used by all four
// tools: explicit project_path, cwd fallback, symlinked paths, file inputs,
// nearest-config wins, stray-lock ignored, locked/unlocked modes, frozen
// error codes (E_PROJECT_NOT_FOUND / E_PROJECT_CONFIG_INVALID / verbatim
// SPEC-005 validity codes / E_REGISTRY_UNAVAILABLE), read-only offline
// behavior (no source mutation, no DB mutation, no network/shell/script
// surface), and context-first wiring over the real stdio wire protocol.
//
// Tests import the built packages (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  McpContextError,
  openReadOnlyRegistry,
  resolveMcpProjectContext,
  toMcpErrorResult,
} from "../../packages/mcp/dist/project-context.js";
import {
  hashNormalizedConfig,
  parseProjectConfig,
} from "../../packages/project/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");
const SRC_DIR = join(REPO_ROOT, "packages", "mcp", "src");
const PROTOCOL_VERSION = "2025-11-25";

const tempRoots = new Set();
function makeTempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `ega-mcp-boundary-${name}-`));
  tempRoots.add(root);
  return root;
}
test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tempRoots.clear();
});

function envFor(home) {
  return { ...process.env, EGA_SKILLS_HOME: home };
}

function writeConfig(dir, text = "schema_version: 1\n") {
  writeFileSync(join(dir, ".egaskills.yaml"), text);
}

function writeLock(dir, lockYaml) {
  writeFileSync(join(dir, ".egaskills.lock"), lockYaml);
}

/** A valid lock for the given config text with an empty skill catalog. */
function emptyLockYamlFor(configText = "schema_version: 1\n") {
  const configHash = hashNormalizedConfig(parseProjectConfig(configText));
  return (
    "generated_from:\n" +
    `  config_hash: ${configHash}\n` +
    "lockfile_version: 1\n" +
    "skills: {}\n" +
    "token_estimator: ega-o200k-v1\n"
  );
}

function expectContextError(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof McpContextError, `expected McpContextError, got ${error}`);
    assert.equal(error.name, "McpContextError");
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected McpContextError(${code}) but nothing threw`);
}

// --- Project path normalization -------------------------------------------

test("boundary: explicit project_path resolves to the real directory", () => {
  const home = makeTempRoot("home-explicit");
  const project = makeTempRoot("proj-explicit");
  writeConfig(project);
  const ctx = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(ctx.projectPath, realpathSync(project));
  assert.equal(ctx.configPath, join(realpathSync(project), ".egaskills.yaml"));
  assert.equal(ctx.hasSelectedConfig, true);
  assert.equal(ctx.lockMode, "UNLOCKED");
  assert.equal(ctx.lock, null);
});

test("boundary: omitted project_path falls back to realpath(cwd)", () => {
  const home = makeTempRoot("home-cwd");
  const project = makeTempRoot("proj-cwd");
  writeConfig(project);
  const viaFallback = resolveMcpProjectContext(undefined, {
    env: envFor(home),
    cwd: project,
  });
  const viaExplicit = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(viaFallback.projectPath, viaExplicit.projectPath);
  assert.equal(viaFallback.projectPath, realpathSync(project));
});

test("boundary: symlinked project path resolves identically to the real path", (t) => {
  const home = makeTempRoot("home-symlink");
  const real = makeTempRoot("proj-real");
  writeConfig(real);
  const link = join(makeTempRoot("links"), "proj-link");
  try {
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("symlinks unavailable in this environment");
    return;
  }
  const viaLink = resolveMcpProjectContext(link, { env: envFor(home) });
  const viaReal = resolveMcpProjectContext(real, { env: envFor(home) });
  assert.equal(viaLink.projectPath, viaReal.projectPath);
  assert.equal(viaLink.configPath, viaReal.configPath);
});

test("boundary: file input resolves to its parent directory", () => {
  const home = makeTempRoot("home-file");
  const project = makeTempRoot("proj-file");
  writeConfig(project);
  const file = join(project, "notes.txt");
  writeFileSync(file, "hello\n");
  const ctx = resolveMcpProjectContext(file, { env: envFor(home) });
  assert.equal(ctx.projectPath, realpathSync(project));
});

test("boundary: missing project path fails with E_PROJECT_NOT_FOUND", () => {
  const home = makeTempRoot("home-missing");
  const missing = join(makeTempRoot("parent"), "no-such-project-dir");
  expectContextError(
    () => resolveMcpProjectContext(missing, { env: envFor(home) }),
    "E_PROJECT_NOT_FOUND",
  );
});

// --- Config / lock discovery ------------------------------------------------

test("boundary: nearest .egaskills.yaml wins for nested projects", () => {
  const home = makeTempRoot("home-nearest");
  const outer = makeTempRoot("proj-outer");
  writeConfig(outer);
  const inner = join(outer, "packages", "app");
  mkdirSync(inner, { recursive: true });
  writeConfig(inner, "schema_version: 1\nrouting:\n  max_skills: 2\n");
  const ctx = resolveMcpProjectContext(inner, { env: envFor(home) });
  assert.equal(ctx.configPath, join(realpathSync(inner), ".egaskills.yaml"));
  assert.equal(ctx.config.routing.max_skills, 2);
});

test("boundary: stray lock without a selected config is ignored", () => {
  const home = makeTempRoot("home-stray");
  const project = makeTempRoot("proj-stray");
  // Deliberately malformed: discovery must ignore it (no selected config).
  writeFileSync(join(project, ".egaskills.lock"), "not: [valid yaml\n");
  const ctx = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(ctx.configPath, null);
  assert.equal(ctx.lockPath, null);
  assert.equal(ctx.hasSelectedConfig, false);
  assert.equal(ctx.lock, null);
  assert.equal(ctx.lockMode, "UNLOCKED");
});

test("boundary: no config selects frozen defaults in UNLOCKED mode", () => {
  const home = makeTempRoot("home-defaults");
  const project = makeTempRoot("proj-defaults");
  const ctx = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(ctx.hasSelectedConfig, false);
  assert.equal(ctx.config.routing.mode, "suggest");
  assert.equal(ctx.lockMode, "UNLOCKED");
});

test("boundary: invalid config fails with E_PROJECT_CONFIG_INVALID", () => {
  const home = makeTempRoot("home-badconfig");
  const project = makeTempRoot("proj-badconfig");
  writeConfig(project, "schema_version: 999\n");
  expectContextError(
    () => resolveMcpProjectContext(project, { env: envFor(home) }),
    "E_PROJECT_CONFIG_INVALID",
  );
});

test("boundary: valid adjacent lock enters LOCKED mode", () => {
  const home = makeTempRoot("home-locked");
  const project = makeTempRoot("proj-locked");
  writeConfig(project);
  writeLock(project, emptyLockYamlFor());
  const ctx = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(ctx.hasSelectedConfig, true);
  assert.equal(ctx.lockMode, "LOCKED");
  assert.ok(ctx.lock !== null);
  assert.deepEqual(ctx.lock.skills, {});
});

test("boundary: stale lock hash propagates E_LOCK_CONFIG_MISMATCH verbatim", () => {
  const home = makeTempRoot("home-stale");
  const project = makeTempRoot("proj-stale");
  writeConfig(project);
  writeLock(
    project,
    "generated_from:\n" +
      `  config_hash: sha256:${"00".repeat(32)}\n` +
      "lockfile_version: 1\n" +
      "skills: {}\n" +
      "token_estimator: ega-o200k-v1\n",
  );
  expectContextError(
    () => resolveMcpProjectContext(project, { env: envFor(home) }),
    "E_LOCK_CONFIG_MISMATCH",
  );
});

test("boundary: locking.required without a lock propagates E_LOCK_REQUIRED", () => {
  const home = makeTempRoot("home-required");
  const project = makeTempRoot("proj-required");
  writeConfig(project, "schema_version: 1\nlocking:\n  required: true\n");
  expectContextError(
    () => resolveMcpProjectContext(project, { env: envFor(home) }),
    "E_LOCK_REQUIRED",
  );
});

// --- Registry availability (read-only, offline) ------------------------------

test("boundary: absent registry reports unavailable without creating anything", () => {
  const home = makeTempRoot("home-absent");
  const project = makeTempRoot("proj-absent");
  writeConfig(project);
  const ctx = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(ctx.registryAvailable, false);
  assert.equal(ctx.registryDatabase, join(ctx.registryHome, "registry.sqlite"));
  expectContextError(() => openReadOnlyRegistry(ctx), "E_REGISTRY_UNAVAILABLE");
  assert.deepEqual(readdirSync(home), [], "registry home must stay untouched");
});

test("boundary: empty EGA_SKILLS_HOME maps to E_REGISTRY_UNAVAILABLE", () => {
  const project = makeTempRoot("proj-emptyhome");
  writeConfig(project);
  expectContextError(
    () => resolveMcpProjectContext(project, { env: { ...process.env, EGA_SKILLS_HOME: "" } }),
    "E_REGISTRY_UNAVAILABLE",
  );
});

test("boundary: read-only open leaves the database file byte-identical", () => {
  const home = makeTempRoot("home-rodummy");
  const project = makeTempRoot("proj-rodummy");
  writeConfig(project);
  // A zero-byte file opens as an empty SQLite database: enough to prove the
  // open/probe/lockdown/close cycle mutates nothing.
  const dbPath = join(home, "registry.sqlite");
  mkdirSync(home, { recursive: true });
  writeFileSync(dbPath, Buffer.alloc(0));
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const ctx = resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(ctx.registryAvailable, true);
  const handle = openReadOnlyRegistry(ctx);
  try {
    const enforced = handle.db.pragma("query_only", { simple: true });
    assert.equal(enforced, 1, "read-only lockdown is enforced on the handle");
  } finally {
    handle.close();
  }
  const after = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  assert.equal(after, before, "database file must be byte-identical after read-only open");
});

test("boundary: project sources are never mutated by context resolution", () => {
  const home = makeTempRoot("home-nomut");
  const project = makeTempRoot("proj-nomut");
  writeConfig(project, "schema_version: 1\nrouting:\n  max_skills: 2\n");
  writeLock(project, emptyLockYamlFor("schema_version: 1\nrouting:\n  max_skills: 2\n"));
  const snapshot = () =>
    JSON.stringify(
      readdirSync(project)
        .sort()
        .map((name) => [name, readFileSync(join(project, name), "utf8")]),
    );
  const before = snapshot();
  for (let i = 0; i < 5; i += 1) {
    resolveMcpProjectContext(project, { env: envFor(home) });
  }
  assert.equal(snapshot(), before, "project control files must be unchanged");
});

// --- Structured error shape ---------------------------------------------------

test("boundary: toMcpErrorResult carries the frozen isError envelope", () => {
  const result = toMcpErrorResult("search", new McpContextError("E_PROJECT_NOT_FOUND", "gone"));
  assert.equal(result.isError, true);
  const structured = result.structuredContent;
  assert.deepEqual(structured, {
    error: { code: "E_PROJECT_NOT_FOUND", message: "gone", tool: "search" },
  });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), structured);
});

// --- Static offline / read-only surface audit ----------------------------------

test("boundary: mcp sources import no network, shell, or script execution surface", () => {
  const bannedImport = /from\s+["']node:(child_process|net|http|https|vm|worker_threads|cluster|dgram|dns|tls)["']/;
  const bannedToken =
    /child_process|execSync|execFileSync|spawnSync|XMLHttpRequest|WebSocket/;
  const bannedCall = /\bfetch\s*\(|\beval\s*\(/;
  for (const name of readdirSync(SRC_DIR).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    const text = readFileSync(join(SRC_DIR, name), "utf8");
    assert.doesNotMatch(text, bannedImport, `${name} must not import network/shell/script modules`);
    assert.doesNotMatch(text, bannedToken, `${name} must not reference shell/network tokens`);
    assert.doesNotMatch(text, bannedCall, `${name} must not call fetch/eval`);
  }
});

// --- Wire protocol: context-first tool behavior ---------------------------------

function launch(t, env) {
  const child = spawn(process.execPath, [BIN], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for response ${id} (${method})`));
      }, 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  return { child, send, request };
}

async function handshake(request, send) {
  await request(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "boundary-test", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

function envelopeOf(call) {
  return call.result.structuredContent?.result ?? call.result.structuredContent;
}

test("boundary (wire): missing project_path returns E_PROJECT_NOT_FOUND", async (t) => {
  const home = makeTempRoot("home-wire-missing");
  const { send, request } = launch(
    t,
    envFor(join(home, "no-such-home")),
  );
  await handshake(request, send);
  const missing = join(makeTempRoot("wire-parent"), "no-such-project");
  const call = await request("wire-missing", "tools/call", {
    name: "resolve",
    arguments: { task: "fix a flaky crash", project_path: missing },
  });
  assert.equal(call.result.isError, true);
  assert.equal(envelopeOf(call)?.error?.code, "E_PROJECT_NOT_FOUND");
  assert.equal(envelopeOf(call)?.error?.tool, "resolve");
});

test("boundary (wire): valid project falls through to the tool body", async (t) => {
  const home = makeTempRoot("home-wire-valid");
  const project = makeTempRoot("proj-wire-valid");
  writeConfig(project);
  const { send, request } = launch(t, envFor(home));
  await handshake(request, send);
  // `search` now has a real body (EGA-591), so `inspect` — still a skeleton
  // placeholder — proves the boundary runs FIRST without swallowing success.
  const call = await request("wire-valid", "tools/call", {
    name: "inspect",
    arguments: { skill_id: "ega/not-installed", project_path: project },
  });
  assert.equal(call.result.isError, true);
  assert.equal(envelopeOf(call)?.error?.code, "E_TOOL_NOT_IMPLEMENTED");
  assert.equal(envelopeOf(call)?.error?.tool, "inspect");
});

test("boundary: fixture stat snapshot is stable across repeated resolutions", () => {
  const home = makeTempRoot("home-stat");
  const project = makeTempRoot("proj-stat");
  writeConfig(project);
  const mtimeOf = () => statSync(join(project, ".egaskills.yaml")).mtimeMs;
  const before = mtimeOf();
  resolveMcpProjectContext(project, { env: envFor(home) });
  resolveMcpProjectContext(project, { env: envFor(home) });
  assert.equal(mtimeOf(), before, "control-file mtime must not advance on reads");
});
