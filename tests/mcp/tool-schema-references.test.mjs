// Tool schema reference integrity — regression for the strict-client failure
// reported by Validation Agent B against OpenCode v2 (`protocol: "2026-07-28"`).
//
// Root cause: `jsonSchema.output()` returned `{ $ref: "#/$defs/<name>" }` while
// no `$defs` section was ever emitted, and the SDK re-rooted the reference
// under `#/properties/result/...`. Strict clients that validate `outputSchema`
// refused to execute `search`, `resolve`, and `get_content`.
//
// The emitted `tools/list` schemas (stdio and hosted HTTP, legacy and modern)
// must be self-contained: every local JSON Pointer reference must resolve
// inside the same schema document.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildEraArtifact, SKILL_ID } from "./helpers/era-fixture.mjs";
import { connectHttp, EXPECTED_TOOLS, startHosted } from "./helpers/hosted-era-runtime.mjs";
import {
  createStdioTransport,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
} from "./helpers/sdk-era-client.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");

function pointerSegments(ref) {
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function assertLocalReferencesResolve(schema, label) {
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string") {
      assert.ok(node.$ref.startsWith("#/"), `${label}: non-local $ref at ${path}: ${node.$ref}`);
      let current = schema;
      for (const segment of pointerSegments(node.$ref)) {
        assert.ok(
          current !== null && typeof current === "object" && segment in current,
          `${label}: dangling $ref at ${path}: ${node.$ref}`,
        );
        current = current[segment];
      }
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${path}/${key}`);
  };
  visit(schema, "#");
}

function assertToolSchemas(tools, label) {
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    EXPECTED_TOOLS,
    `${label}: exactly four tools`,
  );
  for (const tool of tools) {
    assert.ok(tool.inputSchema, `${label}/${tool.name}: inputSchema present`);
    assert.ok(tool.outputSchema, `${label}/${tool.name}: outputSchema present`);
    assertLocalReferencesResolve(tool.inputSchema, `${label}/${tool.name} inputSchema`);
    assertLocalReferencesResolve(tool.outputSchema, `${label}/${tool.name} outputSchema`);
  }
}

async function listTools(client) {
  return client.request({ method: "tools/list", params: {} });
}

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

test("stdio tool schemas are self-contained in both protocol eras", async (t) => {
  for (const protocolVersion of [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION]) {
    const { transport } = await startStdio(t);
    const client = new EraClient({ supportedProtocolVersions: [protocolVersion] });
    await client.connect(transport);
    t.after(() => client.close().catch(() => {}));
    if (protocolVersion === MODERN_PROTOCOL_VERSION) {
      await client.negotiateModernOnly();
    } else {
      await client.initializeLegacy();
    }
    const result = await listTools(client);
    assertToolSchemas(result.tools, `stdio ${protocolVersion}`);
    await client.close();
    await transport.waitForExit();
  }
});

// Strict clients validate `structuredContent` against the advertised
// `outputSchema`. Every top-level key of a real payload must therefore be
// declared, including the hosted `effective_release_digest` envelope field.
function resolveLocalReference(schema, node) {
  let current = node;
  const seen = new Set();
  while (
    current !== null &&
    typeof current === "object" &&
    typeof current.$ref === "string" &&
    current.$ref.startsWith("#/")
  ) {
    if (seen.has(current.$ref)) break;
    seen.add(current.$ref);
    let target = schema;
    for (const segment of pointerSegments(current.$ref)) target = target?.[segment];
    current = target;
  }
  return current;
}

function assertPayloadKeysDeclared(schema, payload, label) {
  const resolved = resolveLocalReference(schema, schema) ?? schema;
  for (const key of resolved.required ?? []) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(payload, key),
      `${label}: required key "${key}" missing from the payload`,
    );
  }
  let declared;
  if (resolved.properties !== undefined) {
    declared = resolved.properties;
  } else if (resolved.additionalProperties !== undefined && resolved.additionalProperties !== true) {
    declared = resolved.additionalProperties;
  }
  if (declared !== undefined) {
    for (const key of Object.keys(payload)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(declared, key),
        `${label}: payload key "${key}" is not declared in the advertised output schema`,
      );
    }
  }
}

test("stdio tool payloads conform to their advertised output schemas", async (t) => {
  const { fixture, transport } = await startStdio(t);
  const client = new EraClient({ supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION] });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  await client.initializeLegacy();

  const tools = (await listTools(client)).tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls = [
    ["search", { query: "alpha", project_path: fixture.artifactDir }],
    ["resolve", { task: "alpha", project_path: fixture.artifactDir }],
    ["inspect", { skill_id: SKILL_ID }],
    ["get_content", { skill_id: SKILL_ID, version_hash: fixture.versionHash, level: "L2", max_tokens: 4000 }],
  ];
  for (const [name, args] of calls) {
    const result = await client.request({ method: "tools/call", params: { name, arguments: args } });
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    assertPayloadKeysDeclared(byName.get(name).outputSchema, result.structuredContent ?? {}, `stdio ${name}`);
  }

  await client.close();
  await transport.waitForExit();
});

test("hosted search payload declares the effective release envelope field", async (t) => {
  const hosted = await startHosted(t);
  const { client, transport } = connectHttp(t, hosted.url, {
    supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION],
  });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  await client.initializeLegacy();

  const tools = (await listTools(client)).tools;
  const result = await client.request({
    method: "tools/call",
    params: { name: "search", arguments: { query: "alpha", release_digest: hosted.snapshot.releaseDigest } },
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  assertPayloadKeysDeclared(
    tools.find((tool) => tool.name === "search").outputSchema,
    result.structuredContent ?? {},
    "hosted search",
  );

  await client.close();
});

test("hosted tool schemas are self-contained in both protocol eras", async (t) => {
  const hosted = await startHosted(t);
  for (const protocolVersion of [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION]) {
    const { client, transport } = connectHttp(t, hosted.url, {
      supportedProtocolVersions: [protocolVersion],
    });
    await client.connect(transport);
    if (protocolVersion === MODERN_PROTOCOL_VERSION) {
      await client.negotiateModernOnly();
    } else {
      await client.initializeLegacy();
    }
    const result = await listTools(client);
    assertToolSchemas(result.tools, `hosted ${protocolVersion}`);
    await client.close();
  }
});
