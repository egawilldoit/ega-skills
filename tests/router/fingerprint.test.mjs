import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveFingerprintSets,
  fingerprintDirectory,
  localDirectoryScan,
} from "../../packages/router/dist/index.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ega-571-"));
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

function detect(dir) {
  return fingerprintDirectory(localDirectoryScan, dir);
}

function sets(dir) {
  return deriveFingerprintSets(detect(dir));
}

function has(evidence, kind, value, source) {
  return evidence.some(
    (record) => record.kind === kind && record.value === value && record.source === source,
  );
}

// SPEC-004 §5.1.8 detectors.

test("SPEC-004 §5.1.8: Node/TypeScript evidence names file and property", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ typescript: "^5.0.0" }),
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "LANGUAGE", "node", "package.json"));
  assert.ok(has(evidence, "LANGUAGE", "typescript", "package.json#dependencies.typescript"));
  assert.ok(has(evidence, "LANGUAGE", "node", "pnpm-lock.yaml"));
  assert.deepEqual(sets(dir).languages, ["node", "typescript"]);
  assert.deepEqual(sets(dir).platforms, []);
  assert.deepEqual(sets(dir).frameworks, []);
});

test("SPEC-004 §5.1.8: tsconfig alone signals TypeScript", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "package.json": pkg(), "tsconfig.json": "{}" });
  assert.ok(has(detect(dir), "LANGUAGE", "typescript", "tsconfig.json"));
});

test("SPEC-004 §5.1.8: React dependency is framework evidence without platform", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "package.json": pkg({ react: "^19.0.0" }) });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "react", "package.json#dependencies.react"));
  assert.deepEqual(sets(dir).frameworks, ["react"]);
  assert.deepEqual(sets(dir).platforms, []);
});

test("SPEC-004 §5.1.8: Next.js dependency and config yield framework plus web", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ next: "^15.0.0", react: "^19.0.0" }),
    "next.config.mjs": "export default {};\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "nextjs", "package.json#dependencies.next"));
  assert.ok(has(evidence, "FRAMEWORK", "nextjs", "next.config.mjs"));
  assert.ok(has(evidence, "PLATFORM", "web", "package.json#dependencies.next"));
  assert.deepEqual(sets(dir).platforms, ["web"]);
});

test("SPEC-004 §5.1.8: Vite config alone signals framework and web", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ vite: "^6.0.0" }),
    "vite.config.ts": "export default {};\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "vite", "vite.config.ts"));
  assert.ok(has(evidence, "PLATFORM", "web", "package.json#dependencies.vite"));
});

test("SPEC-004 §5.1.8: config-only framework still sources platform from config", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg(),
    "vite.config.ts": "export default {};\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "vite", "vite.config.ts"));
  assert.ok(has(evidence, "PLATFORM", "web", "vite.config.ts"));
});

test("SPEC-004 §5.1.8: Angular core and angular.json signal framework and web", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ "@angular/core": "^19.0.0" }),
    "angular.json": "{}\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "angular", "package.json#dependencies.@angular/core"));
  assert.ok(has(evidence, "FRAMEWORK", "angular", "angular.json"));
  assert.ok(has(evidence, "PLATFORM", "web", "package.json#dependencies.@angular/core"));
});

test("SPEC-004 §5.1.8: Expo signals framework and mobile, never web", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ expo: "^52.0.0" }),
    "app.json": "{}\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "expo", "package.json#dependencies.expo"));
  assert.ok(has(evidence, "FRAMEWORK", "expo", "app.json"));
  assert.ok(has(evidence, "PLATFORM", "mobile", "package.json#dependencies.expo"));
  assert.ok(!evidence.some((record) => record.kind === "PLATFORM" && record.value === "web"));
});

test("SPEC-004 §5.1.8: React Native plus ios dir signals mobile", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "package.json": pkg({ "react-native": "^0.78.0" }) });
  await mkdir(join(dir, "ios"), { recursive: true });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "react-native", "package.json#dependencies.react-native"));
  assert.ok(has(evidence, "PLATFORM", "mobile", "ios/"));
});

test("SPEC-004 §5.1.8: package-local android dir signals mobile with no framework", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "package.json": pkg() });
  await mkdir(join(dir, "android"), { recursive: true });
  const evidence = detect(dir);
  assert.ok(has(evidence, "PLATFORM", "mobile", "android/"));
  assert.deepEqual(sets(dir).frameworks, []);
});

test("SPEC-004 §5.1.8: android dir contradicts Next web evidence", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "package.json": pkg({ next: "^15.0.0" }) });
  await mkdir(join(dir, "android"), { recursive: true });
  const evidence = detect(dir);
  assert.ok(has(evidence, "FRAMEWORK", "nextjs", "package.json#dependencies.next"));
  assert.ok(has(evidence, "PLATFORM", "mobile", "android/"));
  assert.ok(!evidence.some((record) => record.kind === "PLATFORM" && record.value === "web"));
});

test("SPEC-004 §5.1.8: linked android dir is not mobile evidence", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "package.json": pkg() });
  await mkdir(join(dir, "real-android"), { recursive: true });
  await symlink(join(dir, "real-android"), join(dir, "android"), "junction");
  assert.ok(!detect(dir).some((record) => record.kind === "PLATFORM" && record.value === "mobile"));
});

test("SPEC-004 §5.1.8: Maven and Gradle signal Java language only", async (t) => {
  const maven = await fixture(t);
  await writeProject(maven, { "pom.xml": "<project/>\n" });
  assert.ok(has(detect(maven), "LANGUAGE", "java", "pom.xml"));
  assert.deepEqual(sets(maven).frameworks, []);
  const gradle = await fixture(t);
  await writeProject(gradle, { "build.gradle.kts": "plugins {}\n" });
  assert.ok(has(detect(gradle), "LANGUAGE", "java", "build.gradle.kts"));
});

test("SPEC-004 §5.1.8: Python metadata signals python language only", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "pyproject.toml": "[project]\n",
    "requirements-dev.txt": "pytest\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "LANGUAGE", "python", "pyproject.toml"));
  assert.ok(has(evidence, "LANGUAGE", "python", "requirements-dev.txt"));
  assert.deepEqual(sets(dir), { languages: ["python"], platforms: [], frameworks: [] });
});

test("SPEC-004 §5.1.8: Cargo signals rust plus workspace marker", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, { "Cargo.toml": '[package]\nname = "x"\n\n[workspace]\n' });
  const evidence = detect(dir);
  assert.ok(has(evidence, "LANGUAGE", "rust", "Cargo.toml"));
  assert.ok(has(evidence, "WORKSPACE", "cargo-workspace", "Cargo.toml#[workspace]"));
});

test("SPEC-004 §5.1.8: workspace markers are tooling evidence, never identity", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "lerna.json": "{}\n",
    "nx.json": "{}\n",
  });
  const evidence = detect(dir);
  assert.ok(has(evidence, "WORKSPACE", "package.json#workspaces", "package.json#workspaces"));
  assert.ok(has(evidence, "WORKSPACE", "pnpm-workspace.yaml", "pnpm-workspace.yaml"));
  assert.ok(has(evidence, "WORKSPACE", "lerna.json", "lerna.json"));
  assert.ok(has(evidence, "WORKSPACE", "nx.json", "nx.json"));
  assert.ok(has(evidence, "LANGUAGE", "node", "package.json"));
  assert.deepEqual(sets(dir).frameworks, []);
  assert.deepEqual(sets(dir).platforms, []);
});

test("SPEC-004 §5.1.8: same-directory polyglot manifests combine", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ next: "^15.0.0" }),
    "Cargo.toml": '[package]\nname = "helper"\n',
  });
  const found = sets(dir);
  assert.deepEqual(found.languages, ["node", "rust"]);
  assert.deepEqual(found.frameworks, ["nextjs"]);
});

test("SPEC-004 §5.1.8: empty and malformed projects yield neutral absence", async (t) => {
  const empty = await fixture(t);
  assert.deepEqual(detect(empty), []);
  assert.deepEqual(sets(empty), { languages: [], platforms: [], frameworks: [] });
  const broken = await fixture(t);
  await writeProject(broken, { "package.json": "{not json" });
  assert.ok(!detect(broken).some((record) => record.source === "package.json"));
});

test("SPEC-004 §5.1.8: detection is deterministic across runs", async (t) => {
  const dir = await fixture(t);
  await writeProject(dir, {
    "package.json": pkg({ vite: "^6.0.0", react: "^19.0.0", typescript: "^5.0.0" }),
    "vite.config.ts": "export default {};\n",
    "yarn.lock": "# yarn\n",
  });
  const first = detect(dir);
  assert.deepEqual(detect(dir), first);
  assert.deepEqual(detect(dir), first);
  // Exact emission order is part of the contract: fixed detector order.
  assert.deepEqual(first, [
    { kind: "LANGUAGE", value: "node", source: "package.json" },
    { kind: "LANGUAGE", value: "typescript", source: "package.json#dependencies.typescript" },
    { kind: "LANGUAGE", value: "node", source: "yarn.lock" },
    { kind: "FRAMEWORK", value: "react", source: "package.json#dependencies.react" },
    { kind: "FRAMEWORK", value: "vite", source: "package.json#dependencies.vite" },
    { kind: "FRAMEWORK", value: "vite", source: "vite.config.ts" },
    { kind: "PLATFORM", value: "web", source: "package.json#dependencies.vite" },
  ]);
});
