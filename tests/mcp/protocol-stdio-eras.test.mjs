// Protocol-era acceptance (stdio) — Agent B tasks B5, B6, B8.
//
// Spawns the real stdio server (`packages/mcp/bin/ega-mcp.mjs`) and drives it
// with the SDK Protocol client helper:
//
// - B5: 2025-era stdio — initialize, notifications/initialized, tools/list,
//   tools/call (preserved existing behavior, clean exit on stdin EOF).
// - B6: 2026-07-28 stdio — server/discover with no initialize, same tool
//   catalog, same product semantics.
// - B8: exactly four tools in both eras over stdio.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildEraArtifact, COMPANION_BODY, COMPANION_PATH, SKILL_BODY, SKILL_ID } from "./helpers/era-fixture.mjs";
import {
  createStdioTransport,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  productResult,
  SERVER_INFO_META_KEY,
  toolNames,
} from "./helpers/sdk-era-client.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");
const EXPECTED_TOOLS = ["get_content", "inspect", "resolve", "search"];

async function startStdio(t) {
  const fixture = await buildEraArtifact();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  const transport = createStdioTransport({
    bin: BIN,
    cwd: REPO_ROOT,
    env: { ...process.env, EGA_SKILLS_HOME: fixture.artifactDir },
  });
  return { fixture, transport };
}

async function listTools(client) {
  const result = await client.request({ method: "tools/list", params: {} });
  assert.deepEqual(toolNames(result.tools), EXPECTED_TOOLS);
  return result.tools;
}

async function callTool(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } });
}

/** All four tools against one artifact; returns the product payloads. */
async function exerciseAllTools(client, artifactDir, versionHash) {
  const search = await callTool(client, "search", { query: "alpha", project_path: artifactDir });
  assert.equal(search.isError, false, JSON.stringify(search));
  const searched = productResult(search);
  assert.equal(searched.results[0]?.skill_id, SKILL_ID);
  assert.equal(searched.results[0]?.version_hash, versionHash);

  const resolve = await callTool(client, "resolve", {
    task: "alpha",
    explicit_skills: [SKILL_ID],
    project_path: artifactDir,
  });
  assert.equal(resolve.isError, false, JSON.stringify(resolve));
  const resolved = productResult(resolve);
  assert.equal(resolved.explicit[0]?.id, SKILL_ID);
  assert.equal(resolved.explicit[0]?.version_hash, versionHash);

  const inspect = await callTool(client, "inspect", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    project_path: artifactDir,
  });
  assert.notEqual(inspect.isError, true, JSON.stringify(inspect));
  const inspected = productResult(inspect);
  assert.equal(inspected.skill_id, SKILL_ID);
  assert.equal(inspected.version_hash, versionHash);

  const body = await callTool(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    project_path: artifactDir,
  });
  assert.equal(body.isError, false, JSON.stringify(body));
  const content = productResult(body);
  assert.equal(content.content, SKILL_BODY);

  const companion = await callTool(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    file_path: COMPANION_PATH,
    project_path: artifactDir,
  });
  assert.equal(companion.isError, false, JSON.stringify(companion));
  assert.equal(productResult(companion).content, COMPANION_BODY);

  return { search, resolve, inspect, body, companion };
}

test("B5 legacy stdio: initialize, initialized notification, discovery, all four tools", async (t) => {
  const { fixture, transport } = await startStdio(t);
  const client = new EraClient({ supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION] });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));

  const initialized = await client.initializeLegacy();
  assert.equal(initialized.protocolVersion, LEGACY_PROTOCOL_VERSION);
  assert.equal(initialized.serverInfo?.name, "ega-skills");
  assert.equal(initialized.capabilities?.resources, undefined);
  assert.equal(initialized.capabilities?.prompts, undefined);
  assert.ok(initialized.capabilities?.tools, "legacy stdio advertises tools");

  const tools = await listTools(client);
  assert.equal(tools.length, 4, "exactly four tools over legacy stdio");

  const products = await exerciseAllTools(client, fixture.artifactDir, fixture.versionHash);
  assert.equal(
    products.body._meta,
    undefined,
    "the 2025-era wire carries no modern result _meta",
  );

  await client.close();
  const exit = await transport.waitForExit();
  assert.equal(exit.code, 0, `clean stdio disconnect (${transport.stderr()})`);
});

test("B6 modern stdio: discovery without initialize, same catalog, same product semantics", async (t) => {
  const { fixture, transport } = await startStdio(t);
  const client = new EraClient({ supportedProtocolVersions: [MODERN_PROTOCOL_VERSION] });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));

  const discovered = await client.negotiateModernOnly();
  assert.deepEqual(discovered.supportedVersions, [MODERN_PROTOCOL_VERSION]);
  assert.equal(discovered._meta?.[SERVER_INFO_META_KEY]?.name, "ega-skills");
  assert.equal(client.protocolEra, "modern");

  const sentMethods = client.methodsSent(transport);
  assert.ok(sentMethods.includes("server/discover"));
  assert.equal(sentMethods.includes("initialize"), false, "modern stdio session never initializes");
  assert.equal(sentMethods.includes("notifications/initialized"), false);

  const tools = await listTools(client);
  assert.equal(tools.length, 4, "exactly four tools over modern stdio");

  // Same catalog shape as the legacy era: same names, same required args,
  // same advertised property sets.
  const requiredByName = Object.fromEntries(tools.map((tool) => [tool.name, [...(tool.inputSchema.required ?? [])].sort()]));
  assert.deepEqual(requiredByName, {
    resolve: ["task"],
    search: ["query"],
    inspect: ["skill_id"],
    get_content: ["level", "max_tokens", "skill_id", "version_hash"],
  });

  const products = await exerciseAllTools(client, fixture.artifactDir, fixture.versionHash);
  for (const [name, result] of Object.entries(products)) {
    assert.equal(
      result._meta?.[SERVER_INFO_META_KEY]?.name,
      "ega-skills",
      `${name}: modern results identify the server per modern semantics`,
    );
  }

  await client.close();
  const exit = await transport.waitForExit();
  assert.equal(exit.code, 0, `clean stdio disconnect (${transport.stderr()})`);
});

test("B8 stdio catalog: exactly four tools in both eras, no hidden or deprecated tools", async (t) => {
  for (const era of ["legacy", "modern"]) {
    const { transport } = await startStdio(t);
    const client = new EraClient({
      supportedProtocolVersions: [era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION],
    });
    await client.connect(transport);
    t.after(() => client.close().catch(() => {}));
    if (era === "modern") await client.negotiateModernOnly();
    else await client.initializeLegacy();
    const tools = await listTools(client);
    assert.equal(tools.length, 4, `${era}: no hidden fifth tool`);
    for (const forbidden of ["admin", "debug", "internal", "deprecated"]) {
      assert.equal(
        tools.some((tool) => tool.name.includes(forbidden)),
        false,
        `${era}: no ${forbidden} tool`,
      );
    }
    await client.close();
    assert.equal((await transport.waitForExit()).code, 0);
  }
});
