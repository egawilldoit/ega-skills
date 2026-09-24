// Protocol-era acceptance (HTTP) — Agent B tasks B2, B3, B4, B8.
//
// Drives the EXISTING hosted MCP handler (createHostedMcpHandler) with a real
// SDK client (tests/mcp/helpers/sdk-era-client.mjs, built on the installed
// `@modelcontextprotocol/server@2.0.0` Protocol engine):
//
// - B2: 2025-era (legacy) initialize + tools/list + all four tools over HTTP.
// - B3: 2026-07-28-only client (no fallback): server/discover without any
//   initialize, modern server identity, exactly four tools, all four execute;
//   a server without modern support fails closed with no legacy fallback.
// - B4: `versionNegotiation = auto` selects modern on a dual-era server.
// - B8: exactly four tools — resolve, search, inspect, get_content — in both
//   eras, with no hidden/deprecated/admin tool and no resources/prompts.

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";

import { createMcpServer } from "../../packages/mcp/dist/index.js";
import {
  buildEraArtifact,
  COMPANION_BODY,
  COMPANION_PATH,
  SKILL_BODY,
  SKILL_CORE,
  SKILL_ID,
} from "./helpers/era-fixture.mjs";
import { connectHttp, EXPECTED_TOOLS, startHosted } from "./helpers/hosted-era-runtime.mjs";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  linkedInMemoryTransports,
  MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  productResult,
  SERVER_INFO_META_KEY,
  toolNames,
  withSentLog,
} from "./helpers/sdk-era-client.mjs";

async function listTools(client) {
  const result = await client.request({ method: "tools/list", params: {} });
  assert.deepEqual(toolNames(result.tools), EXPECTED_TOOLS);
  return result.tools;
}

async function callTool(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } });
}

/** Runs every tool against one release digest and returns the product payloads. */
async function exerciseAllTools(client, { releaseDigest, versionHash }) {
  const search = await callTool(client, "search", { query: "alpha", release_digest: releaseDigest });
  assert.equal(search.isError, false, JSON.stringify(search));
  const searched = productResult(search);
  assert.equal(searched.results[0]?.skill_id, SKILL_ID);
  assert.equal(searched.results[0]?.version_hash, versionHash);
  assert.equal(searched.effective_release_digest, releaseDigest);

  const resolve = await callTool(client, "resolve", {
    task: "alpha",
    explicit_skills: [SKILL_ID],
    release_digest: releaseDigest,
  });
  assert.equal(resolve.isError, false, JSON.stringify(resolve));
  const resolved = productResult(resolve);
  assert.equal(resolved.explicit[0]?.id, SKILL_ID);
  assert.equal(resolved.explicit[0]?.version_hash, versionHash);
  assert.equal(resolved.effective_release_digest, releaseDigest);

  const inspect = await callTool(client, "inspect", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    release_digest: releaseDigest,
  });
  assert.notEqual(inspect.isError, true, JSON.stringify(inspect));
  const inspected = productResult(inspect);
  assert.equal(inspected.skill_id, SKILL_ID);
  assert.equal(inspected.version_hash, versionHash);
  assert.equal(inspected.l0.skill_id, SKILL_ID);

  const body = await callTool(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    release_digest: releaseDigest,
  });
  assert.notEqual(body.isError, true, JSON.stringify(body));
  const content = productResult(body);
  assert.equal(content.skill_id, SKILL_ID);
  assert.equal(content.version_hash, versionHash);
  assert.equal(content.content, SKILL_BODY);

  const core = await callTool(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L1",
    max_tokens: 4000,
    release_digest: releaseDigest,
  });
  assert.equal(productResult(core).content, SKILL_CORE);

  const companion = await callTool(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    file_path: COMPANION_PATH,
    release_digest: releaseDigest,
  });
  assert.notEqual(companion.isError, true, JSON.stringify(companion));
  assert.equal(productResult(companion).content, COMPANION_BODY);
  assert.equal(productResult(companion).file_path, COMPANION_PATH);

  return { search, resolve, inspect, body, core, companion };
}

test("B2 legacy HTTP: initialize, discovery, exactly four tools, all four execute", async (t) => {
  const hosted = await startHosted(t);
  const { releaseDigest, versionHash } = hosted.fixture;
  const { client, transport } = connectHttp(t, hosted.url, {
    supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION],
  });
  await client.connect(transport);

  const initialized = await client.initializeLegacy();
  assert.equal(initialized.protocolVersion, LEGACY_PROTOCOL_VERSION);
  assert.equal(initialized.serverInfo?.name, "ega-skills-hosted");
  assert.ok(initialized.capabilities?.tools, "legacy server advertises tools");
  assert.equal(initialized.capabilities.resources, undefined);
  assert.equal(initialized.capabilities.prompts, undefined);

  const tools = await listTools(client);
  assert.equal(tools.length, 4, "exactly four tools over the legacy HTTP wire");
  assert.equal(client.protocolEra, "legacy");

  const products = await exerciseAllTools(client, { releaseDigest, versionHash });
  for (const [name, result] of Object.entries(products)) {
    assert.equal(
      result._meta,
      undefined,
      `${name}: the 2025-era codec never stamps result _meta (serverInfo)`,
    );
  }

  await client.close();
  assert.equal(client.methodsSent(transport).includes("initialize"), true);
  assert.equal(
    client.methodsSent(transport).filter((method) => method === "tools/call").length,
    6,
  );
});

test("B3 modern HTTP: server/discover without initialize, modern identity, four tools execute", async (t) => {
  const hosted = await startHosted(t);
  const { releaseDigest, versionHash } = hosted.fixture;
  const { client, transport } = connectHttp(t, hosted.url, {
    supportedProtocolVersions: [MODERN_PROTOCOL_VERSION],
  });
  await client.connect(transport);

  const discovered = await client.negotiateModernOnly();
  assert.deepEqual(discovered.supportedVersions, [MODERN_PROTOCOL_VERSION]);
  assert.ok(discovered.capabilities?.tools, "modern discovery advertises tools");
  assert.deepEqual(discovered._meta?.[SERVER_INFO_META_KEY], {
    name: "ega-skills-hosted",
    version: JSON.parse(readFileSync(new URL("../../packages/mcp/package.json", import.meta.url), "utf8")).version,
  });
  assert.equal(client.protocolEra, "modern");

  const sentMethods = client.methodsSent(transport);
  assert.ok(sentMethods.includes("server/discover"));
  assert.equal(sentMethods.includes("initialize"), false, "modern session never initializes");
  assert.equal(
    sentMethods.includes("notifications/initialized"),
    false,
    "modern session never sends the legacy initialized notification",
  );

  const tools = await listTools(client);
  assert.equal(tools.length, 4, "exactly four tools over the modern HTTP wire");

  const products = await exerciseAllTools(client, { releaseDigest, versionHash });
  for (const [name, result] of Object.entries(products)) {
    assert.equal(
      result._meta?.[SERVER_INFO_META_KEY]?.name,
      "ega-skills-hosted",
      `${name}: modern results identify the server per modern semantics`,
    );
  }

  await client.close();
});

test("B3 no fallback: a modern-required client fails closed on a legacy-only server", async (t) => {
  const fixture = await buildEraArtifact();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  const [rawClientTransport, serverTransport] = linkedInMemoryTransports();
  const clientTransport = withSentLog(rawClientTransport);
  const server = createMcpServer();
  await server.connect(serverTransport);
  t.after(() => server.close().catch(() => {}));

  const client = new EraClient({ supportedProtocolVersions: [MODERN_PROTOCOL_VERSION] });
  await client.connect(clientTransport);
  t.after(() => client.close().catch(() => {}));

  await assert.rejects(
    client.negotiateModernOnly(),
    (error) => {
      assert.match(String(error?.message), /Method not found|not supported|server\/discover/i);
      return true;
    },
    "server/discover must fail on a server that only serves the 2025 era",
  );
  assert.equal(client.protocolEra, "unnegotiated");
  assert.deepEqual(
    client.methodsSent(clientTransport),
    ["server/discover"],
    "the failed modern negotiation must not fall back to initialize",
  );
});

test("B4 auto-negotiation selects modern on a dual-era server when the client supports it", async (t) => {
  const hosted = await startHosted(t);
  const { client, transport } = connectHttp(t, hosted.url, {
    supportedProtocolVersions: [MODERN_PROTOCOL_VERSION],
  });
  await client.connect(transport);

  const negotiated = await client.negotiateAuto();
  assert.equal(negotiated.era, "modern");
  assert.equal(negotiated.result.supportedVersions.includes(MODERN_PROTOCOL_VERSION), true);
  assert.equal(client.protocolEra, "modern");
  assert.equal(client.protocolVersion, MODERN_PROTOCOL_VERSION);

  const sentMethods = client.methodsSent(transport);
  assert.deepEqual(sentMethods.slice(0, 1), ["server/discover"]);
  assert.equal(sentMethods.includes("initialize"), false);

  const search = await callTool(client, "search", {
    query: "alpha",
    release_digest: hosted.fixture.releaseDigest,
  });
  assert.equal(search.isError, false, JSON.stringify(search));
  assert.equal(
    search._meta?.[SERVER_INFO_META_KEY]?.name,
    "ega-skills-hosted",
    "auto-negotiated requests travel the modern wire",
  );
  await client.close();
});

test("B8 catalog: exactly resolve/search/inspect/get_content in both eras, no extras", async (t) => {
  const hosted = await startHosted(t);
  for (const era of ["legacy", "modern"]) {
    const { client, transport } = connectHttp(t, hosted.url, {
      supportedProtocolVersions: era === "modern" ? [MODERN_PROTOCOL_VERSION] : [LEGACY_PROTOCOL_VERSION],
    });
    await client.connect(transport);
    if (era === "modern") await client.negotiateModernOnly();
    else await client.initializeLegacy();
    const tools = await listTools(client);
    assert.equal(tools.length, 4, `${era}: no hidden fifth tool`);
    const names = new Set(toolNames(tools));
    assert.deepEqual([...names].sort(), EXPECTED_TOOLS);
    for (const forbidden of ["admin", "debug", "internal", "legacy", "deprecated"]) {
      assert.equal(
        [...names].some((name) => name.includes(forbidden)),
        false,
        `${era}: no ${forbidden} tool`,
      );
    }
    const methods = client.methodsSent(transport);
    assert.equal(methods.includes("resources/list"), false);
    assert.equal(methods.includes("prompts/list"), false);
    await client.close();
  }
});

test("B1/B3 wire truth: the modern envelope keys match the SDK's reserved keys", () => {
  // Guard against a future SDK key rename silently changing what the client
  // sends: the reserved keys are part of the 2026-07-28 wire contract.
  const envelope = new EraClient().modernEnvelope();
  assert.deepEqual(Object.keys(envelope).sort(), [
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
  ].sort());
  assert.equal(envelope[PROTOCOL_VERSION_META_KEY], MODERN_PROTOCOL_VERSION);
});
