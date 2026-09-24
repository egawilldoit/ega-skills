#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHubRelease } from "../../packages/project/dist/index.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-verify-artifact-hub-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha artifact validation skill.\n---\n\nUse alpha when needed.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: verify-artifact\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const hub = makeHub();
let registryHome;
try {
  const build = await buildHubRelease(hub);
  registryHome = build.registryHome;
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "hosted", "validate-artifact.mjs"), registryHome], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`validate-artifact failed with exit ${String(result.status)}\n`);
    process.exit(1);
  }
  process.stdout.write(`validate-sample-artifact: OK artifact=${registryHome}\n`);
} finally {
  rmSync(hub, { recursive: true, force: true });
  if (registryHome !== undefined) rmSync(registryHome, { recursive: true, force: true });
}
