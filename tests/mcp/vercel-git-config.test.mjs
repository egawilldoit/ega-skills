import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MCP_ROOT = join(REPO_ROOT, "packages/mcp");
const ARTIFACT_ROOT = join(MCP_ROOT, "artifact");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// The reviewed t3dotgg catalog entries committed into the deployable artifact.
// Keep in sync with catalog/presentation.yaml; every one must be present in
// hub-release.json so the hosted tools advertise the same catalog.
const T3DOTGG_SKILLS = [
  "t3dotgg/babysit-pr",
  "t3dotgg/council",
  "t3dotgg/file-pr",
  "t3dotgg/full-send",
  "t3dotgg/full-stop",
  "t3dotgg/leaving-pr-comments",
  "t3dotgg/modernize",
  "t3dotgg/sol-loop",
  "t3dotgg/takeover",
];

test("vercel.json leaves native Git deployments enabled", () => {
  const raw = readFileSync(join(MCP_ROOT, "vercel.json"), "utf8");
  const config = JSON.parse(raw);

  assert.equal(typeof config, "object", "vercel.json must parse to an object");
  assert.equal(Object.hasOwn(config, "git"), false, "vercel.json must not contain a git block");
  assert.doesNotMatch(raw, /deploymentEnabled/, "vercel.json must not disable Git deployments");
  assert.doesNotMatch(raw, /\/home\/ubuntu/, "vercel.json must not contain machine-specific absolute paths");
});

test("vercel.json builds server.mts with the committed artifact", () => {
  const config = readJson(join(MCP_ROOT, "vercel.json"));

  assert.ok(Array.isArray(config.builds), "vercel.json must declare builds");
  assert.equal(config.builds.length, 1, "vercel.json must declare exactly one build");
  const [build] = config.builds;
  assert.equal(build.src, "server.mts", "the build must select server.mts");
  assert.equal(build.use, "@vercel/node", "server.mts must build with @vercel/node");
  assert.equal(
    build.config?.includeFiles,
    "artifact/**/*",
    "the build must include the committed artifact tree",
  );

  assert.deepEqual(
    config.routes,
    [{ src: "/(.*)", dest: "server.mts" }],
    "every path must route to server.mts",
  );
});

test("workspace install and build context matches the native Vercel flow", () => {
  const packageJson = readJson(join(MCP_ROOT, "package.json"));
  assert.equal(
    packageJson.scripts?.["vercel-build"],
    "pnpm -w build",
    "the MCP package must build the workspace for Vercel",
  );

  const workspace = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  assert.match(
    workspace,
    /^\s*-\s*['"]?packages\/\*['"]?\s*$/m,
    "pnpm-workspace.yaml must include packages/*",
  );

  assert.ok(existsSync(join(REPO_ROOT, "pnpm-lock.yaml")), "the repo-root pnpm lockfile must exist");

  const rootPackageJson = readJson(join(REPO_ROOT, "package.json"));
  assert.equal(
    rootPackageJson.packageManager,
    "pnpm@10.0.0",
    "the root packageManager must pin pnpm@10.0.0",
  );
});

test("the committed artifact is complete and self-consistent", () => {
  for (const relative of ["hub-release.json", "release-package.json", "registry.sqlite"]) {
    const path = join(ARTIFACT_ROOT, relative);
    assert.ok(existsSync(path), `${relative} must be committed in the artifact`);
    assert.ok(statSync(path).isFile(), `${relative} must be a file`);
  }
  const cacheDir = join(ARTIFACT_ROOT, "cache", "sha256");
  assert.ok(existsSync(cacheDir), "artifact/cache/sha256 must be committed");
  assert.ok(statSync(cacheDir).isDirectory(), "artifact/cache/sha256 must be a directory");

  const hubRelease = readJson(join(ARTIFACT_ROOT, "hub-release.json"));
  const releasePackage = readJson(join(ARTIFACT_ROOT, "release-package.json"));

  assert.equal(releasePackage.snapshot_rows, 126, "the snapshot must carry 126 rows");
  assert.equal(
    releasePackage.hub_release_digest,
    hubRelease.digest,
    "release-package must reference the committed hub-release digest",
  );

  const skillVersions = hubRelease.payload?.skill_versions;
  assert.equal(typeof skillVersions, "object", "hub-release payload must carry skill_versions");
  assert.notEqual(skillVersions, null, "hub-release payload must carry skill_versions");

  const missing = T3DOTGG_SKILLS.filter((skill) => !Object.hasOwn(skillVersions, skill));
  assert.deepEqual(missing, [], "every reviewed t3dotgg skill must be in the committed release");

  const shipped = Object.keys(skillVersions)
    .filter((skill) => skill.startsWith("t3dotgg/"))
    .sort();
  assert.deepEqual(shipped, [...T3DOTGG_SKILLS].sort(), "the artifact must ship exactly the nine t3dotgg skills");
});
