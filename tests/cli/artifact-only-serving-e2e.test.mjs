// Artifact-only serving + content isolation E2E — Agent B tasks B9, B10.
//
// Uses the COMPLETE connected publication flow (plan → stage → review →
// apply → preflight → preview → export, same pattern as
// tests/cli/intake-publication-e2e.test.mjs), then moves BOTH the upstream
// source checkout and the Hub working copy away. The MCP runtime is started
// from the exported artifact alone and must serve all four tools with exact
// bytes, proving runtime independence from upstream Git/source data.
//
// B10 then drives `get_content` at every control-plane file and path shape:
// none may become skill content, and each must fail closed with the frozen
// code and a non-enumerating message.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildHubRelease, verifyReleaseCandidate } from "../../packages/project/dist/index.js";
import {
  createStdioTransport,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  productResult,
} from "../mcp/helpers/sdk-era-client.mjs";

const cli = join(process.cwd(), "packages", "cli", "bin", "ega-skills.mjs");
const mcpBin = join(process.cwd(), "packages", "mcp", "bin", "ega-mcp.mjs");

const SKILL_ID = "intake/alpha";
const SKILL_BODY =
  "---\nname: alpha\ndescription: Alpha artifact-only skill.\n---\n\n# alpha\n\nArtifact-only body marker B9-BODY-2.0.\n";
const SKILL_CORE = "# alpha core\n\nArtifact-only core marker B9-CORE-2.0.\n";
const COMPANION_PATH = "references/notes.md";
const COMPANION_BODY = "# notes\n\nArtifact-only companion marker B9-COMPANION-2.0.\n";

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

function runSuccessfulCli(...args) {
  const result = runCli(...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

function writeEmptyHub(hub) {
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: artifact-only-e2e\nowned: []\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
}

async function connectStdio(t, era, artifactDir) {
  const transport = createStdioTransport({
    bin: mcpBin,
    cwd: process.cwd(),
    env: { ...process.env, EGA_SKILLS_HOME: artifactDir },
  });
  const client = new EraClient({
    supportedProtocolVersions: [era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION],
  });
  await client.connect(transport);
  if (era === "modern") await client.negotiateModernOnly();
  else await client.initializeLegacy();
  t.after(async () => {
    await client.close().catch(() => {});
    transport.child.kill();
  });
  return { client, transport };
}

async function call(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } });
}

function errorCode(result) {
  return productResult(result)?.error?.code;
}

test("B9/B10: artifact-only MCP serving is independent of upstream source and isolates control-plane files", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-artifact-only-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // --- Complete connected publication flow ---------------------------------
  const source = join(base, "source");
  const sourceSkill = join(source, "skills", "alpha");
  mkdirSync(join(sourceSkill, "references"), { recursive: true });
  writeFileSync(join(sourceSkill, "SKILL.md"), SKILL_BODY);
  writeFileSync(join(sourceSkill, "SKILL.core.md"), SKILL_CORE);
  writeFileSync(join(sourceSkill, COMPANION_PATH), COMPANION_BODY);
  writeFileSync(join(source, "LICENSE"), "License for the artifact-only fixture.\n");
  const sourceSkillBytes = readFileSync(join(sourceSkill, "SKILL.md"));

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
    "--source-id", "artifact-only-source",
    "--root", "skills/alpha",
    "--provenance-file", "LICENSE",
    "--hub", hub,
    "--output", planPath,
  );
  assert.equal(planned.blocked_count, 0);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(plan.payload.candidates[0].skill_id, SKILL_ID);
  const versionHash = plan.payload.candidates[0].version_hash;

  runSuccessfulCli("hub", "intake", "stage", "--plan", planPath, hub);
  runSuccessfulCli(
    "hub", "intake", "review",
    "--candidate", plan.digest,
    "--decision", "approve",
    "--expected-revision", "0",
    hub,
  );
  const applied = runSuccessfulCli("hub", "intake", "apply", "--plan", planPath, hub);
  assert.equal(applied.status, "COMMITTED");

  const ready = runSuccessfulCli("hub", "release", "preflight", hub);
  assert.equal(ready.payload.status, "READY");
  const preview = runSuccessfulCli(
    "hub", "release", "preview",
    "--hub", hub,
    "--against", baseline.artifactPaths.release,
    "--output-dir", candidateDir,
  );
  assert.equal(preview.status, "READY");
  const exported = runSuccessfulCli(
    "hub", "release", "export",
    "--candidate", join(candidateDir, "candidate.json"),
    "--out", exportedDir,
  );
  assert.equal(exported.release_digest, preview.candidate.payload.release_digest);
  assert.equal(verifyReleaseCandidate(exportedDir).release.digest, exported.release_digest);

  // --- Upstream data is moved away before the MCP runtime starts -----------
  const sourceAway = join(base, "source-away");
  const hubAway = join(base, "hub-away");
  renameSync(source, sourceAway);
  renameSync(hub, hubAway);
  assert.equal(existsSync(source), false, "upstream source checkout is gone");
  assert.equal(existsSync(hub), false, "Hub working copy is gone");
  assert.equal(existsSync(join(exportedDir, "hub-release.json")), true);

  // --- All four tools from the artifact alone, exact bytes -----------------
  const legacy = await connectStdio(t, "legacy", exportedDir);
  const search = await call(legacy.client, "search", {
    query: "alpha",
    project_path: exportedDir,
  });
  const searched = productResult(search);
  assert.equal(search.isError, false, JSON.stringify(search));
  assert.equal(searched.results[0].skill_id, SKILL_ID);
  assert.equal(searched.results[0].version_hash, versionHash);

  const resolve = await call(legacy.client, "resolve", {
    task: "alpha",
    explicit_skills: [SKILL_ID],
    project_path: exportedDir,
  });
  assert.equal(resolve.isError, false, JSON.stringify(resolve));
  assert.equal(productResult(resolve).explicit[0].id, SKILL_ID);

  const inspect = await call(legacy.client, "inspect", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    project_path: exportedDir,
  });
  assert.equal(productResult(inspect).skill_id, SKILL_ID);

  const body = await call(legacy.client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    project_path: exportedDir,
  });
  assert.deepEqual(Buffer.from(productResult(body).content), sourceSkillBytes);
  assert.equal(productResult(body).content, SKILL_BODY);

  const core = await call(legacy.client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L1",
    max_tokens: 4000,
    project_path: exportedDir,
  });
  assert.equal(productResult(core).content, SKILL_CORE);

  const companion = await call(legacy.client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    file_path: COMPANION_PATH,
    project_path: exportedDir,
  });
  assert.equal(productResult(companion).content, COMPANION_BODY);

  // --- B10: control-plane isolation ----------------------------------------
  const isolationCases = [
    ["hub-release.json", "E_CONTENT_FILE_UNKNOWN"],
    ["release-package.json", "E_CONTENT_FILE_UNKNOWN"],
    ["registry.sqlite", "E_CONTENT_FILE_UNKNOWN"],
    ["alias-map.json", "E_CONTENT_FILE_UNKNOWN"],
    ["../hub-release.json", "E_CONTENT_FILE_UNKNOWN"],
    ["references/../notes.md", "E_CONTENT_FILE_UNKNOWN"],
    ["references/ghost.md", "E_CONTENT_FILE_UNKNOWN"],
    ["SKILL.md", "E_CONTENT_FILE_FORBIDDEN"],
  ];
  const controlPlaneBytes = new Map([
    ["hub-release.json", readFileSync(join(exportedDir, "hub-release.json"), "utf8")],
    ["release-package.json", readFileSync(join(exportedDir, "release-package.json"), "utf8")],
    ["alias-map.json", readFileSync(join(exportedDir, "alias-map.json"), "utf8")],
  ]);
  for (const [filePath, expectedCode] of isolationCases) {
    const result = await call(legacy.client, "get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      file_path: filePath,
      project_path: exportedDir,
    });
    assert.equal(result.isError, true, `${filePath} must never be served`);
    assert.equal(errorCode(result), expectedCode, `${filePath} code`);
    const product = productResult(result);
    assert.equal("content" in (product ?? {}), false, `${filePath} produced no content field`);
    assert.equal("file_path" in (product ?? {}), false, `${filePath} produced no file_path field`);
    const payload = JSON.stringify(result);
    for (const [name, bytes] of controlPlaneBytes) {
      assert.equal(
        payload.includes(bytes.slice(0, 80)),
        false,
        `${filePath} leaked ${name} bytes`,
      );
    }
    // Non-enumerating: the message echoes only the requested path; it must not
    // list the version's real manifest files or artifact control-plane names.
    const message = productResult(result).error.message;
    for (const leaked of ["SKILL.core.md", "references/notes.md", "alias-map.json"]) {
      assert.equal(
        message.includes(leaked) && filePath !== leaked,
        false,
        `${filePath} must not enumerate version files (saw ${leaked})`,
      );
    }
  }

  // --- The modern era serves the same artifact-only runtime -----------------
  const modern = await connectStdio(t, "modern", exportedDir);
  const modernSearch = await call(modern.client, "search", {
    query: "alpha",
    project_path: exportedDir,
  });
  assert.equal(modernSearch.isError, false, JSON.stringify(modernSearch));
  assert.equal(productResult(modernSearch).results[0].version_hash, versionHash);
  const modernContent = await call(modern.client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    project_path: exportedDir,
  });
  assert.equal(productResult(modernContent).content, SKILL_BODY);
  assert.equal(modern.client.methodsSent(modern.transport).includes("initialize"), false);

  await legacy.client.close();
  assert.equal((await legacy.transport.waitForExit()).code, 0);
  await modern.client.close();
  assert.equal((await modern.transport.waitForExit()).code, 0);

  // The upstream copies were never touched by the runtime.
  assert.deepEqual(readFileSync(join(sourceAway, "skills", "alpha", "SKILL.md")), sourceSkillBytes);
});
