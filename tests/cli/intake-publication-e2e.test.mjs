import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildHubRelease, verifyReleaseCandidate } from "../../packages/project/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");
const validateArtifact = join(process.cwd(), "scripts", "hosted", "validate-artifact.mjs");

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function jsonOutput(result) {
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

function runSuccessfulCli(...args) {
  const result = runCli(...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return jsonOutput(result);
}

function writeEmptyHub(hub) {
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: e2e-hub\nowned: []\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function launchLocalMcp(t, registryHome) {
  const bin = join(process.cwd(), "packages", "mcp", "bin", "ega-mcp.mjs");
  const child = spawn(process.execPath, [bin], {
    cwd: process.cwd(),
    env: { ...process.env, EGA_SKILLS_HOME: registryHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for MCP response ${id} (${method})`));
    }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const close = () => new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.stdin.end();
  });
  return { request, send, close, stderr: () => stderr };
}

test("E2E-01: actual intake CLI publishes the exact approved candidate", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-intake-publication-e2e-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const source = join(base, "source");
  const skill = join(source, "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: Alpha intake end-to-end skill.\n---\n\nUse Alpha for the reviewed intake workflow.\n");
  writeFileSync(join(source, "LICENSE"), "License.\n");

  const hub = join(base, "hub");
  mkdirSync(hub);
  writeEmptyHub(hub);
  const planPath = join(base, "plan.json");
  const candidateDir = join(base, "candidate");
  const exportedDir = join(base, "exported");

  const baseline = await buildHubRelease(hub);
  const planned = runSuccessfulCli(
    "hub", "intake", "plan", source,
    "--namespace", "intake",
    "--source-id", "local-alpha",
    "--root", "skills/alpha",
    "--provenance-file", "LICENSE",
    "--hub", hub,
    "--output", planPath,
  );
  assert.equal(planned.blocked_count, 0);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(plan.payload.candidates[0].skill_id, "intake/alpha");
  assert.match(plan.payload.candidates[0].version_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(plan.payload.source.provenance_files, ["LICENSE"]);
  assert.match(plan.payload.source.selected_skill_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(plan.payload.source.vendored_snapshot_digest, /^sha256:[0-9a-f]{64}$/);

  const sourceSkillBytes = readFileSync(join(skill, "SKILL.md"));

  runSuccessfulCli("hub", "intake", "stage", "--plan", planPath, hub);
  const premature = runCli("hub", "intake", "apply", "--plan", planPath, hub);
  assert.equal(premature.status, 4, `${premature.stdout}\n${premature.stderr}`);
  assert.match(premature.stderr, /approved|approval|review/i);
  assert.equal(existsSync(join(hub, "owned", "local-alpha", "skills", "alpha", "SKILL.md")), false);
  const pending = runCli("hub", "release", "preflight", hub);
  assert.equal(pending.status, 0);
  assert.equal(jsonOutput(pending).payload.status, "READY");

  const reviewed = runSuccessfulCli(
    "hub", "intake", "review",
    "--candidate", plan.digest,
    "--decision", "approve",
    "--expected-revision", "0",
    hub,
  );
  assert.equal(reviewed.revision, 1);

  const applied = runSuccessfulCli("hub", "intake", "apply", "--plan", planPath, hub);
  assert.equal(applied.status, "COMMITTED");
  assert.equal(existsSync(join(hub, "owned", "local-alpha", "skills", "alpha", "SKILL.md")), true);

  const ready = runSuccessfulCli("hub", "release", "preflight", hub);
  assert.equal(ready.payload.status, "READY");
  const preview = runSuccessfulCli(
    "hub", "release", "preview",
    "--hub", hub,
    "--against", baseline.artifactPaths.release,
    "--output-dir", candidateDir,
  );
  assert.equal(preview.status, "READY");
  const previewReleaseDigest = JSON.parse(readFileSync(join(candidateDir, "hub-release.json"), "utf8")).digest;
  assert.equal(preview.candidate.payload.release_digest, previewReleaseDigest);
  assert.equal(existsSync(join(candidateDir, "publication-preflight.json")), true);

  const exported = runSuccessfulCli(
    "hub", "release", "export",
    "--candidate", join(candidateDir, "candidate.json"),
    "--out", exportedDir,
  );
  assert.equal(exported.release_digest, preview.candidate.payload.release_digest);
  assert.equal(verifyReleaseCandidate(exportedDir).release.digest, preview.candidate.payload.release_digest);
  const validate = spawnSync(process.execPath, [validateArtifact, exportedDir], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(validate.status, 0, `${validate.stderr}\n${validate.stdout}`);
  assert.deepEqual(readFileSync(join(source, "skills", "alpha", "SKILL.md")), sourceSkillBytes);

  // The exported artifact is the only registry input for the local transport;
  // the upstream checkout is deliberately gone before any MCP call.
  rmSync(source, { recursive: true, force: true });
  assert.equal(existsSync(source), false);
  const exportedRelease = JSON.parse(readFileSync(join(exportedDir, "hub-release.json"), "utf8"));
  assert.equal(exportedRelease.digest, preview.candidate.payload.release_digest);
  assert.equal(exportedRelease.payload.skill_versions["intake/alpha"], plan.payload.candidates[0].version_hash);

  const mcp = launchLocalMcp(t, exportedDir);
  const initialized = await mcp.request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "intake-publication-e2e", version: "1.0.0" },
  });
  assert.ok(initialized.result?.serverInfo);
  mcp.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const searchCall = await mcp.request(2, "tools/call", {
    name: "search",
    arguments: { query: "alpha", project_path: hub },
  });
  const search = searchCall.result.structuredContent?.result ?? searchCall.result.structuredContent;
  assert.equal(searchCall.result.isError, false, JSON.stringify(searchCall));
  assert.equal(search.results[0].skill_id, "intake/alpha");
  assert.equal(search.results[0].version_hash, plan.payload.candidates[0].version_hash);

  const resolveCall = await mcp.request(3, "tools/call", {
    name: "resolve",
    arguments: { task: "Alpha intake", explicit_skills: ["intake/alpha"], project_path: hub },
  });
  const resolved = resolveCall.result.structuredContent?.result ?? resolveCall.result.structuredContent;
  assert.equal(resolveCall.result.isError, false, JSON.stringify(resolveCall));
  assert.equal(resolved.explicit[0].id, "intake/alpha");
  assert.equal(resolved.explicit[0].version_hash, plan.payload.candidates[0].version_hash);

  const inspectCall = await mcp.request(4, "tools/call", {
    name: "inspect",
    arguments: { skill_id: "intake/alpha", version_hash: plan.payload.candidates[0].version_hash, project_path: hub },
  });
  const inspected = inspectCall.result.structuredContent?.result ?? inspectCall.result.structuredContent;
  assert.equal(inspectCall.result.isError, false, JSON.stringify(inspectCall));
  assert.equal(inspected.skill_id, "intake/alpha");
  assert.equal(inspected.version_hash, plan.payload.candidates[0].version_hash);

  const contentCall = await mcp.request(5, "tools/call", {
    name: "get_content",
    arguments: {
      skill_id: "intake/alpha",
      version_hash: plan.payload.candidates[0].version_hash,
      level: "L2",
      max_tokens: 4000,
      project_path: hub,
    },
  });
  const content = contentCall.result.structuredContent?.result ?? contentCall.result.structuredContent;
  assert.equal(contentCall.result.isError, false, JSON.stringify(contentCall));
  assert.equal(content.skill_id, "intake/alpha");
  assert.equal(content.version_hash, plan.payload.candidates[0].version_hash);
  assert.equal(content.content, sourceSkillBytes.toString("utf8"));

  const controlPlaneCall = await mcp.request(6, "tools/call", {
    name: "get_content",
    arguments: {
      skill_id: "intake/alpha",
      version_hash: plan.payload.candidates[0].version_hash,
      level: "L2",
      max_tokens: 4000,
      file_path: "hub-release.json",
      project_path: hub,
    },
  });
  const controlPlane = controlPlaneCall.result.structuredContent?.result ?? controlPlaneCall.result.structuredContent;
  assert.equal(controlPlaneCall.result.isError, true, JSON.stringify(controlPlaneCall));
  assert.equal(controlPlane.error.code, "E_CONTENT_FILE_UNKNOWN");
  const mcpExit = await mcp.close();
  assert.equal(mcpExit.code, 0, `${mcpExit.signal ?? ""}\n${mcp.stderr()}`);

  const marker = join(base, "preview-marker");
  const release = join(base, "preview-release");
  const staleCandidateDir = join(base, "stale-candidate");
  const previewProcess = spawn(process.execPath, [
    cli, "hub", "release", "preview",
    "--hub", hub,
    "--against", baseline.artifactPaths.release,
    "--output-dir", staleCandidateDir,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EGA_TEST_RELEASE_PREVIEW_BARRIER: "AFTER_BUILD_BEFORE_FINAL_PREFLIGHT",
      EGA_TEST_RELEASE_PREVIEW_BARRIER_FILE: marker,
      EGA_TEST_RELEASE_PREVIEW_BARRIER_RELEASE: release,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let previewStdout = "";
  let previewStderr = "";
  t.after(() => {
    if (previewProcess.exitCode === null) previewProcess.kill("SIGKILL");
  });
  previewProcess.stdout.on("data", (chunk) => { previewStdout += chunk; });
  previewProcess.stderr.on("data", (chunk) => { previewStderr += chunk; });
  await waitForFile(marker);
  const rejected = runSuccessfulCli(
    "hub", "intake", "review",
    "--candidate", plan.digest,
    "--decision", "reject",
    "--expected-revision", "1",
    hub,
  );
  assert.equal(rejected.revision, 2);
  writeFileSync(release, "release\n");
  const staleStatus = await new Promise((resolve) => previewProcess.on("close", (code) => resolve(code)));
  assert.equal(staleStatus, 4, `${previewStdout}\n${previewStderr}`);
  assert.match(previewStderr, /preflight became stale/);
  assert.equal(existsSync(staleCandidateDir), false);
  assert.equal(verifyReleaseCandidate(exportedDir).release.digest, preview.candidate.payload.release_digest);
});
