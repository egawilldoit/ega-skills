// Fixture that builds a real Hub, exports a real release artifact, and drives
// the real local MCP server against that export. Nothing is stubbed: the
// assertions must hold for the same bytes a deployment would serve.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHubRelease } from "../../../packages/project/dist/index.js";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");
const mcpBin = join(process.cwd(), "packages", "mcp", "bin", "ega-mcp.mjs");

function runSuccessfulCli(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} exited ${result.status}\n${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Build one owned skill in a fresh Hub and export a real release artifact from
 * it, following the same intake -> approve -> apply -> preview -> export
 * sequence the CLI end-to-end test uses.
 */
export async function buildHubFixture(t, { namespace, skill }) {
  const base = mkdtempSync(join(tmpdir(), "ega-prov-fixture-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const source = join(base, "source");
  const sourceSkill = join(source, "skills", skill);
  mkdirSync(sourceSkill, { recursive: true });
  writeFileSync(
    join(sourceSkill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: ${skill} skill used by the provenance disclosure invariants.\n---\n\nGuidance body for ${skill}.\n`,
  );
  writeFileSync(join(source, "LICENSE"), "License.\n");

  const hub = join(base, "hub");
  mkdirSync(hub, { recursive: true });
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: prov-fixture\nowned: []\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");

  const planPath = join(base, "plan.json");
  const candidateDir = join(base, "candidate");
  const exportedDir = join(base, "exported");
  const sourceId = `${namespace}-owned`;

  const baseline = await buildHubRelease(hub);
  runSuccessfulCli(
    "hub", "intake", "plan", source,
    "--namespace", namespace,
    "--source-id", sourceId,
    "--root", `skills/${skill}`,
    "--provenance-file", "LICENSE",
    "--hub", hub,
    "--output", planPath,
  );
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  runSuccessfulCli("hub", "intake", "stage", "--plan", planPath, hub);
  runSuccessfulCli("hub", "intake", "review", "--candidate", plan.digest, "--decision", "approve", "--expected-revision", "0", hub);
  runSuccessfulCli("hub", "intake", "apply", "--plan", planPath, hub);
  runSuccessfulCli("hub", "release", "preview", "--hub", hub, "--against", baseline.artifactPaths.release, "--output-dir", candidateDir);
  runSuccessfulCli("hub", "release", "export", "--candidate", join(candidateDir, "candidate.json"), "--out", exportedDir);

  return { base, hub, exportedDir, candidateDir, namespace, skill, versionHash: plan.payload.candidates[0].version_hash };
}

/** Start the real local MCP server against an exported artifact. */
export async function buildMcpSession(t, artifactDir) {
  const child = spawn(process.execPath, [mcpBin], {
    cwd: process.cwd(),
    env: { ...process.env, EGA_SKILLS_HOME: artifactDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

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

  let nextId = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for MCP ${method}\n${stderr}`));
    }, 15_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "provenance-disclosure", version: "1.0.0" },
  });
  if (!initialized.result?.serverInfo) {
    throw new Error(`MCP initialize failed: ${JSON.stringify(initialized)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  return {
    call: (name, args) => request("tools/call", { name, arguments: args }),
    stderr: () => stderr,
  };
}
