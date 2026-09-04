import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveProjectFingerprint } from "../../packages/router/dist/index.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ega-572-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeProject(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

function pkg(deps = {}, extra = {}) {
  return JSON.stringify({ name: "proj", version: "1.0.0", dependencies: deps, ...extra });
}

async function monorepo(t) {
  const root = await fixture(t);
  await writeProject(root, {
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/web/package.json": pkg({ next: "^15.0.0", react: "^19.0.0" }),
    "apps/web/next.config.mjs": "export default {};\n",
    "apps/mobile/package.json": pkg({ expo: "^52.0.0" }),
    "apps/mobile/app.json": "{}\n",
  });
  return root;
}

function values(fingerprint, kind) {
  return fingerprint.evidence.filter((record) => record.kind === kind).map((record) => record.value);
}

// SPEC-004 §5.1.9 nearest-package isolation.

test("SPEC-004 §5.1.9: web app never inherits the Expo sibling", async (t) => {
  const root = await monorepo(t);
  const fingerprint = resolveProjectFingerprint(join(root, "apps", "web"));
  assert.equal(fingerprint.packageRoot, join(root, "apps", "web"));
  assert.equal(fingerprint.workspaceRoot, root);
  assert.equal(fingerprint.workspaceAmbiguous, false);
  assert.deepEqual(fingerprint.frameworks, ["nextjs", "react"]);
  assert.deepEqual(fingerprint.platforms, ["web"]);
  assert.ok(!values(fingerprint, "FRAMEWORK").includes("expo"));
  assert.ok(!values(fingerprint, "PLATFORM").includes("mobile"));
  assert.ok(
    fingerprint.evidence.some((record) => record.kind === "WORKSPACE" && record.source === "../../pnpm-workspace.yaml"),
  );
});

test("SPEC-004 §5.1.9: mobile app never inherits the Next sibling", async (t) => {
  const root = await monorepo(t);
  const fingerprint = resolveProjectFingerprint(join(root, "apps", "mobile"));
  assert.equal(fingerprint.packageRoot, join(root, "apps", "mobile"));
  assert.equal(fingerprint.workspaceRoot, root);
  assert.equal(fingerprint.workspaceAmbiguous, false);
  assert.deepEqual(fingerprint.frameworks, ["expo"]);
  assert.deepEqual(fingerprint.platforms, ["mobile"]);
  assert.ok(!values(fingerprint, "FRAMEWORK").includes("nextjs"));
  assert.ok(!values(fingerprint, "PLATFORM").includes("web"));
});

test("SPEC-004 §5.1.9: workspace root without app evidence is ambiguous", async (t) => {
  const root = await monorepo(t);
  const fingerprint = resolveProjectFingerprint(root);
  assert.equal(fingerprint.workspaceRoot, root);
  assert.equal(fingerprint.workspaceAmbiguous, true);
  // No sibling identities merged: no frameworks from apps/*.
  assert.deepEqual(fingerprint.frameworks, []);
  assert.deepEqual(fingerprint.platforms, []);
  assert.deepEqual(fingerprint.languages, ["node"]);
});

test("SPEC-004 §5.1.9: workspace root with its own app identity is not ambiguous", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ next: "^15.0.0" }, { workspaces: ["apps/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
  });
  const fingerprint = resolveProjectFingerprint(dir);
  assert.equal(fingerprint.packageRoot, dir);
  assert.equal(fingerprint.workspaceRoot, dir);
  assert.equal(fingerprint.workspaceAmbiguous, false);
  assert.deepEqual(fingerprint.frameworks, ["nextjs"]);
});

test("SPEC-004 §5.1.9: same-directory polyglot manifests combine", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ vite: "^6.0.0" }),
    "Cargo.toml": '[package]\nname = "helper"\n',
  });
  const fingerprint = resolveProjectFingerprint(dir);
  assert.equal(fingerprint.packageRoot, dir);
  assert.deepEqual(fingerprint.languages, ["node", "rust"]);
  assert.deepEqual(fingerprint.frameworks, ["vite"]);
});

test("SPEC-004 §5.1.9: bare subdirectory resolves to the nearest package", async (t) => {
  const root = await monorepo(t);
  await mkdir(join(root, "apps", "web", "src", "pages"), { recursive: true });
  const fingerprint = resolveProjectFingerprint(join(root, "apps", "web", "src", "pages"));
  assert.equal(fingerprint.packageRoot, join(root, "apps", "web"));
  assert.deepEqual(fingerprint.frameworks, ["nextjs", "react"]);
});

test("SPEC-004 §5.1.9: symlinked project paths resolve deterministically", async (t) => {
  const root = await monorepo(t);
  const web = join(root, "apps", "web");
  // 'junction' works unprivileged on Windows and as a symlink elsewhere.
  await symlink(web, join(root, "web-link"), "junction");
  const direct = resolveProjectFingerprint(web);
  const linked = resolveProjectFingerprint(join(root, "web-link"));
  assert.deepEqual(linked, direct);
  assert.equal(linked.projectPath, web);
});

test("SPEC-004 §5.1.9: missing project path fails deterministically", async (t) => {
  const dir = await fixture(t);
  assert.throws(() => resolveProjectFingerprint(join(dir, "nope")), /does not exist/);
});

test("SPEC-004 §5.1.9: resolution is deterministic across runs", async (t) => {
  const root = await monorepo(t);
  const first = resolveProjectFingerprint(join(root, "apps", "web"));
  assert.deepEqual(resolveProjectFingerprint(join(root, "apps", "web")), first);
  // Contract ordering: evidence sorted by kind, value, source.
  const keys = first.evidence.map((record) => `${record.kind}\0${record.value}\0${record.source}`);
  assert.deepEqual(keys, [...keys].sort());
});
