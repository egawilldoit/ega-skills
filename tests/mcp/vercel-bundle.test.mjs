import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveArtifactDir } from "../../packages/mcp/dist/index.js";

const MCP_ROOT = resolve(import.meta.dirname, "../../packages/mcp");

test("vercel.json includeFiles globs match real bundled files", () => {
  const config = JSON.parse(readFileSync(join(MCP_ROOT, "vercel.json"), "utf8"));
  const patterns = config.functions?.["server.ts"]?.includeFiles;
  assert.ok(Array.isArray(patterns) && patterns.length > 0, "server.ts must declare includeFiles");
  for (const pattern of patterns) {
    assert.match(pattern, /^artifact\//, `includeFiles must stay inside the package root: ${pattern}`);
  }
  for (const required of ["artifact/hub-release.json", "artifact/release-package.json", "artifact/registry.sqlite"]) {
    assert.ok(existsSync(join(MCP_ROOT, required)), `${required} must exist for bundling`);
  }
  assert.ok(existsSync(join(MCP_ROOT, "artifact", "cache", "sha256")), "artifact cache must exist for bundling");
});

test("server.ts pins the native binding path that matches the installed version", () => {
  const serverSource = readFileSync(join(MCP_ROOT, "server.ts"), "utf8");
  const installed = JSON.parse(readFileSync(join(MCP_ROOT, "node_modules", "better-sqlite3", "package.json"), "utf8"));
  const pinned = serverSource.match(/better-sqlite3@([0-9.]+)\/node_modules\/better-sqlite3\/prebuilds\/linux-x64\.node/);
  assert.ok(pinned, "server.ts must statically reference the linux-x64 prebuild");
  assert.equal(pinned[1], installed.version, "pinned prebuild version must match the installed better-sqlite3");
  assert.ok(
    existsSync(join(MCP_ROOT, "node_modules", "better-sqlite3", "prebuilds", "linux-x64.node")),
    "pinned prebuild file must exist",
  );
  assert.match(serverSource, /process\.platform === "linux" && process\.arch === "x64"/, "prebuild require must be platform-guarded");
});

test("resolveArtifactDir prefers the configured directory and falls back deterministically", () => {
  const real = join(MCP_ROOT, "artifact");
  assert.equal(resolveArtifactDir(real), real);
  const missingAbsolute = join(tmpdir(), "ega-no-such-artifact-dir");
  assert.equal(resolveArtifactDir(missingAbsolute), missingAbsolute);
  const previous = process.cwd();
  const empty = mkdtempSync(join(tmpdir(), "ega-empty-cwd-"));
  try {
    process.chdir(empty);
    assert.equal(resolveArtifactDir("./artifact"), join(MCP_ROOT, "artifact"));
  } finally {
    process.chdir(previous);
  }
});
