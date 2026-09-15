import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveArtifactDir } from "../../packages/mcp/dist/index.js";

const MCP_ROOT = resolve(import.meta.dirname, "../../packages/mcp");

test("vercel.json includeFiles globs match real bundled files", () => {
  const config = JSON.parse(readFileSync(join(MCP_ROOT, "vercel.json"), "utf8"));
  const declared = config.functions?.["server.mts"]?.includeFiles;
  // Schema requires a single string (array form is rejected at deploy time).
  assert.equal(typeof declared, "string", "server.mts includeFiles must be a string glob");
  const patterns = [declared];
  for (const pattern of patterns) {
    assert.match(pattern, /^artifact\//, `includeFiles must stay inside the package root: ${pattern}`);
  }
  for (const required of ["artifact/hub-release.json", "artifact/release-package.json", "artifact/registry.sqlite"]) {
    assert.ok(existsSync(join(MCP_ROOT, required)), `${required} must exist for bundling`);
  }
  assert.ok(existsSync(join(MCP_ROOT, "artifact", "cache", "sha256")), "artifact cache must exist for bundling");
});

test("server.mts never statically requires a native binding path", () => {
  // A bundle-relative .node path cannot resolve reliably, and the require
  // would throw at boot, failing every route. The binding resolves at
  // runtime through the package's own relative path; when tracers omit it,
  // the first Database construction fails inside the runtime try/catch and
  // the server keeps serving fail-closed JSON instead of crashing.
  const serverSource = readFileSync(join(MCP_ROOT, "server.mts"), "utf8");
  assert.doesNotMatch(serverSource, /\.node["']/, "server entrypoint must not reference .node files");
  assert.doesNotMatch(serverSource, /createRequire/, "server entrypoint must not use createRequire");
  assert.match(serverSource, /server\.listen\(/, "server entrypoint must call listen for detection");
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
