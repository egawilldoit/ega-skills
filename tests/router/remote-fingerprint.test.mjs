import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRemoteProjectFingerprint,
  detectRemoteFingerprintRevision,
  hashRemoteFingerprint,
  verifyRemoteProjectFingerprint,
} from "../../packages/router/dist/index.js";

const roots = new Set();
test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function monorepo() {
  const root = await mkdtemp(join(tmpdir(), "ega-remote-fingerprint-"));
  roots.add(root);
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await mkdir(join(root, "apps", "mobile"), { recursive: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({
    name: "web",
    dependencies: { next: "1.0.0", react: "1.0.0" },
  }));
  await writeFile(join(root, "apps", "web", "next.config.js"), "module.exports = {};\n");
  await writeFile(join(root, "apps", "mobile", "package.json"), JSON.stringify({
    name: "mobile",
    dependencies: { expo: "1.0.0", "react-native": "1.0.0" },
  }));
  await writeFile(join(root, "apps", "mobile", "app.json"), "{\"expo\":{}}\n");
  return root;
}

test("Contract E fingerprints isolate web and mobile package scopes with relative evidence", async () => {
  const root = await monorepo();
  const commit = "a".repeat(40);
  const web = createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "web"),
    revision: { mode: "git-clean", commit_sha: commit },
  });
  const mobile = createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "mobile"),
    revision: { mode: "git-dirty", base_commit_sha: commit },
  });
  assert.equal(web.package_root, "apps/web");
  assert.equal(mobile.package_root, "apps/mobile");
  assert.equal(web.workspace_root, ".");
  assert.equal(mobile.workspace_root, ".");
  assert.deepEqual(web.platforms, ["web"]);
  assert.deepEqual(mobile.platforms, ["mobile"]);
  assert.ok(web.frameworks.includes("nextjs"));
  assert.ok(mobile.frameworks.includes("expo"));
  assert.ok(web.evidence.every((record) => !record.path.startsWith("/")));
  assert.ok(mobile.evidence.every((record) => !record.path.startsWith("/")));
  assert.notEqual(web.relevant_input_digest, mobile.relevant_input_digest);
  assert.notEqual(hashRemoteFingerprint(web), hashRemoteFingerprint(mobile));
  assert.equal(web.revision.mode, "git-clean");
  assert.equal(mobile.revision.mode, "git-dirty");
});

test("Contract E marks non-Git repositories unversioned", async () => {
  const root = await monorepo();
  const revision = detectRemoteFingerprintRevision(root);
  assert.equal(revision.mode, "unversioned");
});

test("Contract E relevant-input digest changes only with bounded evidence bytes", async () => {
  const root = await monorepo();
  const revision = { mode: "unversioned" };
  const first = createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "web"),
    revision,
  });
  await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({
    name: "web",
    dependencies: { next: "2.0.0", react: "1.0.0" },
  }));
  const second = createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "web"),
    revision,
  });
  assert.notEqual(first.relevant_input_digest, second.relevant_input_digest);
  assert.equal(typeof (await readFile(join(root, "apps", "web", "package.json"))).byteLength, "number");
});

test("Contract E rejects non-portable or structurally forged fingerprints", () => {
  const valid = {
    package_root: "apps/web",
    workspace_root: ".",
    workspace_ambiguous: false,
    languages: ["node"],
    platforms: ["web"],
    frameworks: ["nextjs"],
    evidence: [{ path: "apps/web/package.json", kind: "package-manifest" }],
    revision: { mode: "unversioned" },
    relevant_input_digest: `sha256:${"a".repeat(64)}`,
  };
  verifyRemoteProjectFingerprint(valid);
  assert.throws(() => hashRemoteFingerprint({ ...valid, package_root: "/home/runner/repo/apps/web" }), /repository-relative/);
  assert.throws(() => verifyRemoteProjectFingerprint({ ...valid, evidence: [{ path: "apps\\web\\package.json", kind: "package-manifest" }] }), /repository-relative/);
  assert.throws(() => verifyRemoteProjectFingerprint({ ...valid, frameworks: ["vite", "nextjs"] }), /sorted and unique/);
});

test("Contract E derives relevant inputs only from bounded detected evidence", async () => {
  const root = await monorepo();
  assert.throws(() => createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "web"),
    revision: { mode: "unversioned" },
    relevant_inputs: [{ path: "unrelated.txt", bytes: "attacker-controlled" }],
  }), /exactly match bounded detected evidence/);
});

test("Contract E rejects symlinked evidence before hashing it", async () => {
  const root = await monorepo();
  const outside = await mkdtemp(join(tmpdir(), "ega-fingerprint-outside-"));
  roots.add(outside);
  await writeFile(join(outside, "package.json"), "{\"name\":\"outside\"}\n");
  await rm(join(root, "apps", "web", "package.json"));
  await symlink(join(outside, "package.json"), join(root, "apps", "web", "package.json"));
  assert.throws(() => createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "web"),
    revision: { mode: "unversioned" },
  }), /contains a symlink/);
});

test("Contract E bounds evidence reads and rejects oversized manifest files", async () => {
  const root = await monorepo();
  await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({
    name: "web",
    description: "x".repeat(1_048_600),
    dependencies: { next: "1.0.0" },
  }));
  assert.throws(() => createRemoteProjectFingerprint({
    repository_root: root,
    project_path: join(root, "apps", "web"),
    revision: { mode: "unversioned" },
  }), /bounded read limit/);
});
