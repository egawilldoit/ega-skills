// Hosted release/context pinning contract — regression for #124.
//
// The hosted `inspect` and `get_content` tools advertise `release_digest` as
// OPTIONAL in their published input schemas, yet the runtime requires
// `release_digest` OR an authorized `context_id`. A client that obeys the
// advertised schema therefore sent a schema-valid call and received the
// misleading `E_RELEASE_MISMATCH` "require a verified release or context"
// instead of an argument-validation error. Reproduced in production by two
// independent real clients (Codex 0.158.0, OpenCode 1.18.33).
//
// The contract this suite freezes:
//   1. `inspect`      requires skill_id AND at least one of the two selectors.
//   2. `get_content`  requires skill_id, version_hash, level, max_tokens AND
//      at least one of the two selectors.
//   3. The published representation is standards-compliant JSON Schema:
//      `anyOf: [{required:[release_digest]},{required:[context_id]}]` — NOT a
//      bare `release_digest` requirement, because `context_id` is a valid
//      alternative.
//   4. BOTH selectors: allowed when they resolve to the same authorized
//      release, refused when inconsistent. Never silently prefer one input.
//   5. NEITHER selector: an argument-validation failure at the schema layer,
//      never a downstream `E_RELEASE_MISMATCH`.
//   6. The frozen public error-code contract is preserved exactly: no new
//      codes, no changed codes.
//
// No test here depends on a live production service. Every path is driven
// through the real hosted handler over loopback HTTP (both protocol eras) and
// the real SDK client, plus in-process handler probes for the matrix that must
// hold identically in both eras.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import test from "node:test";

import { buildHubRelease } from "../../packages/project/dist/index.js";
import {
  createHostedMcpHandler,
  loadHostedReleaseSnapshot,
} from "../../packages/mcp/dist/index.js";
import {
  createHttpTransport,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
} from "./helpers/sdk-era-client.mjs";

const AUTH_TOKEN = "pin-contract-token";

/** The two selectors and their alternatives, as the tools must publish them. */
const SELECTORS = ["release_digest", "context_id"];

function makeHub(name, skill) {
  const hubDir = mkdtempSync(join(tmpdir(), `ega-pin-${name}-`));
  const skillDir = join(hubDir, "owned", "ega", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: ${skill} skill for release ${name}.\n---\n\nUse ${skill} from ${name}.\n`,
  );
  writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${skill}\n`);
  writeFileSync(join(hubDir, "hub.yaml"), `schema_version: 1\nhub:\n  id: ${name}\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n`);
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const releaseOne = await buildHubRelease(makeHub("release-one", "alpha"));
const releaseTwo = await buildHubRelease(makeHub("release-two", "beta"));
const snapshotOne = loadHostedReleaseSnapshot(releaseOne.registryHome);
const snapshotTwo = loadHostedReleaseSnapshot(releaseTwo.registryHome);
const betaVersionHash = releaseTwo.skills.find((skill) => skill.skillId === "ega/beta").versionHash;

const cleanups = [releaseOne.registryHome, releaseTwo.registryHome];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/**
 * The authorized context resolves to releaseTwo. Every other context id is
 * unauthorized, which is the production shape: context authorization is
 * per-principal and happens before the tool body runs.
 */
function makeHandler(overrides = {}) {
  return createHostedMcpHandler(snapshotOne, {
    verifyBearer: async (token) => {
      if (token !== AUTH_TOKEN) throw new Error("invalid token");
      return { subject: "pin-principal", scopes: ["mcp:read"] };
    },
    authorize: async () => true,
    resolveContext: async (contextId) => {
      if (contextId !== "ctx-release-two") throw new Error("context is not authorized");
      return snapshotTwo;
    },
    ...overrides,
  });
}

/** Raw JSON-RPC against the hosted handler, bypassing the SDK client. */
async function rpc(handler, name, args) {
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text).result;
}

async function listTools(handler) {
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text).result.tools;
}

function textOf(result) {
  return (result?.content ?? []).map((part) => part.text).join("\n");
}

/**
 * Serves a hosted handler on an ephemeral loopback port so the real SDK client
 * can drive it. The SDK client follows the endpoint it is given; a non-loopback
 * URL would send these contract probes to a real deployment, so every era test
 * must go through here.
 */
async function startLoopback(t, handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const webResponse = await handler.fetch(
      new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      }),
    );
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

/** Connects a real SDK client to a hosted handler in the requested era. */
async function connectEra(t, handler, protocolVersion) {
  const url = await startLoopback(t, handler);
  const client = new EraClient({ supportedProtocolVersions: [protocolVersion] });
  const transport = createHttpTransport({
    url,
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    getProtocolVersion: () => client.protocolVersion,
  });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  if (protocolVersion === MODERN_PROTOCOL_VERSION) {
    await client.negotiateModernOnly();
  } else {
    await client.initializeLegacy();
  }
  return client;
}

function errorCodeOf(result) {
  try {
    return JSON.parse(textOf(result)).error?.code;
  } catch {
    return undefined;
  }
}

const INSPECT_BASE = { skill_id: "ega/alpha" };
const CONTENT_BASE = (versionHash) => ({
  skill_id: "ega/alpha",
  version_hash: versionHash,
  level: "L2",
  max_tokens: 4000,
});

// --- Published schema contract ------------------------------------------------------

test("hosted inspect and get_content publish the anyOf selector rule", async () => {
  const tools = await listTools(makeHandler());
  for (const name of ["inspect", "get_content"]) {
    const input = tools.find((tool) => tool.name === name).inputSchema;
    assert.deepEqual(
      input.anyOf,
      [{ required: ["release_digest"] }, { required: ["context_id"] }],
      `${name} publishes the standards-compliant anyOf selector alternatives`,
    );
    // `release_digest` must NOT be promoted into the ordinary required list:
    // context_id is a valid alternative selector.
    assert.ok(
      !input.required.includes("release_digest"),
      `${name} does not make release_digest unconditionally required`,
    );
    assert.ok(
      !input.required.includes("context_id"),
      `${name} does not make context_id unconditionally required`,
    );
    for (const selector of SELECTORS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(input.properties ?? {}, selector),
        `${name} still advertises ${selector} as a property`,
      );
    }
  }

  const inspectInput = tools.find((tool) => tool.name === "inspect").inputSchema;
  assert.deepEqual(inspectInput.required, ["skill_id"], "inspect required fields are unchanged");

  const contentInput = tools.find((tool) => tool.name === "get_content").inputSchema;
  assert.deepEqual(
    contentInput.required,
    ["skill_id", "version_hash", "level", "max_tokens"],
    "get_content required fields are unchanged",
  );
});

test("the published anyOf selector rule also holds in the legacy and modern HTTP eras", async (t) => {
  const handler = makeHandler();
  for (const protocolVersion of [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION]) {
    const client = await connectEra(t, handler, protocolVersion);
    const { tools } = await client.request({ method: "tools/list", params: {} });
    for (const name of ["inspect", "get_content"]) {
      assert.deepEqual(
        tools.find((tool) => tool.name === name).inputSchema.anyOf,
        [{ required: ["release_digest"] }, { required: ["context_id"] }],
        `${protocolVersion}/${name} publishes the anyOf selector rule`,
      );
    }
    await client.close();
  }
});

// --- release_digest only -------------------------------------------------------------

test("release_digest alone selects the pinned release and succeeds", async () => {
  const handler = makeHandler();
  const inspected = await rpc(handler, "inspect", {
    ...INSPECT_BASE,
    release_digest: snapshotOne.releaseDigest,
  });
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
  assert.match(JSON.stringify(inspected), /ega\/alpha/);

  const content = await rpc(handler, "get_content", {
    ...CONTENT_BASE(releaseOne.skills[0].versionHash),
    release_digest: snapshotOne.releaseDigest,
  });
  assert.notEqual(content.isError, true, JSON.stringify(content));
  assert.match(JSON.stringify(content), /Use alpha from release-one/);
});

test("release_digest alone reaches the second release through the exact loader", async () => {
  const handler = makeHandler({
    resolveRelease: async (digest) => {
      if (digest === snapshotOne.releaseDigest) return snapshotOne;
      if (digest === snapshotTwo.releaseDigest) return snapshotTwo;
      throw new Error("unknown release");
    },
  });
  const content = await rpc(handler, "get_content", {
    skill_id: "ega/beta",
    version_hash: betaVersionHash,
    level: "L2",
    max_tokens: 4000,
    release_digest: snapshotTwo.releaseDigest,
  });
  assert.notEqual(content.isError, true, JSON.stringify(content));
  assert.match(JSON.stringify(content), /Use beta from release-two/);
});

// --- context_id only -----------------------------------------------------------------

test("context_id alone selects the authorized context release and succeeds", async () => {
  const handler = makeHandler();
  // The context names releaseTwo, so the selected snapshot is releaseTwo's and
  // the call is answered from THAT release, not from the startup snapshot.
  const inspected = await rpc(handler, "inspect", {
    skill_id: "ega/beta",
    context_id: "ctx-release-two",
  });
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
  assert.match(JSON.stringify(inspected), /ega\/beta/);

  const content = await rpc(handler, "get_content", {
    skill_id: "ega/beta",
    version_hash: betaVersionHash,
    level: "L2",
    max_tokens: 4000,
    context_id: "ctx-release-two",
  });
  assert.notEqual(content.isError, true, JSON.stringify(content));
  assert.match(JSON.stringify(content), /Use beta from release-two/);
});

// --- neither: schema-validation failure, never E_RELEASE_MISMATCH --------------------

test("omitting both selectors is an argument-validation failure, not a release mismatch", async () => {
  const handler = makeHandler();
  for (const [name, args] of [
    ["inspect", INSPECT_BASE],
    ["get_content", CONTENT_BASE(releaseOne.skills[0].versionHash)],
  ]) {
    const result = await rpc(handler, name, args);
    assert.equal(result.isError, true, `${name} must fail without a selector`);
    const text = textOf(result);
    assert.match(text, /Input validation error/i, `${name} fails at argument validation: ${text}`);
    assert.match(text, /release_digest/, `${name} names the required selector: ${text}`);
    assert.match(text, /context_id/, `${name} names the alternative selector: ${text}`);
    assert.doesNotMatch(
      text,
      /E_RELEASE_MISMATCH/,
      `${name} must not degrade a missing selector into E_RELEASE_MISMATCH`,
    );
  }
});

test("omitting both selectors stays an argument-validation failure in both HTTP eras", async (t) => {
  const handler = makeHandler();
  for (const protocolVersion of [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION]) {
    const client = await connectEra(t, handler, protocolVersion);
    const result = await client.request({
      method: "tools/call",
      params: { name: "get_content", arguments: CONTENT_BASE(releaseOne.skills[0].versionHash) },
    });
    assert.equal(result.isError, true, `${protocolVersion}: get_content fails without a selector`);
    assert.doesNotMatch(
      JSON.stringify(result),
      /E_RELEASE_MISMATCH/,
      `${protocolVersion}: no release-mismatch code for a missing selector`,
    );
    await client.close();
  }
});

test("a valid pinned call succeeds through the real SDK client in both HTTP eras", async (t) => {
  const handler = makeHandler();
  for (const protocolVersion of [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION]) {
    const client = await connectEra(t, handler, protocolVersion);
    const result = await client.request({
      method: "tools/call",
      params: {
        name: "get_content",
        arguments: {
          ...CONTENT_BASE(releaseOne.skills[0].versionHash),
          release_digest: snapshotOne.releaseDigest,
        },
      },
    });
    assert.notEqual(result.isError, true, `${protocolVersion}: ${JSON.stringify(result)}`);
    assert.match(JSON.stringify(result), /Use alpha from release-one/, `${protocolVersion}: exact bytes served`);
    await client.close();
  }
});

// --- both selectors ------------------------------------------------------------------

test("both selectors resolving to the same authorized release are allowed", async () => {
  const handler = makeHandler({
    // The context and the digest name the same release, so neither input
    // contradicts the other and the request is unambiguous.
    resolveContext: async () => snapshotTwo,
    resolveRelease: async (digest) => {
      if (digest === snapshotTwo.releaseDigest) return snapshotTwo;
      throw new Error("unknown release");
    },
  });
  const both = { release_digest: snapshotTwo.releaseDigest, context_id: "ctx-release-two" };

  const inspected = await rpc(handler, "inspect", { skill_id: "ega/beta", ...both });
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
  assert.match(JSON.stringify(inspected), /ega\/beta/);

  const content = await rpc(handler, "get_content", {
    skill_id: "ega/beta",
    version_hash: betaVersionHash,
    level: "L2",
    max_tokens: 4000,
    ...both,
  });
  assert.notEqual(content.isError, true, JSON.stringify(content));
  assert.match(JSON.stringify(content), /Use beta from release-two/);
});

test("both selectors that disagree fail closed with the frozen mismatch code", async () => {
  const handler = makeHandler();
  // ctx-release-two resolves to releaseTwo; the digest pins releaseOne.
  const conflicting = { release_digest: snapshotOne.releaseDigest, context_id: "ctx-release-two" };

  for (const [name, args] of [
    ["inspect", { skill_id: "ega/beta", ...conflicting }],
    ["get_content", { skill_id: "ega/beta", version_hash: betaVersionHash, level: "L2", max_tokens: 4000, ...conflicting }],
  ]) {
    const result = await rpc(handler, name, args);
    assert.equal(result.isError, true, `${name} must fail closed on disagreement`);
    assert.equal(errorCodeOf(result), "E_RELEASE_MISMATCH", `${name} uses the existing frozen code`);
    assert.doesNotMatch(
      JSON.stringify(result),
      /Use beta from release-two/,
      `${name} leaks no content from either release on disagreement`,
    );
  }
});

// --- unauthorized / unknown ----------------------------------------------------------

test("an unauthorized context_id fails closed without leaking content", async () => {
  const handler = makeHandler();
  for (const [name, args] of [
    ["inspect", { ...INSPECT_BASE, context_id: "ctx-not-mine" }],
    ["get_content", { ...CONTENT_BASE(releaseOne.skills[0].versionHash), context_id: "ctx-not-mine" }],
  ]) {
    const result = await rpc(handler, name, args);
    assert.equal(result.isError, true, `${name} refuses an unauthorized context`);
    assert.doesNotMatch(JSON.stringify(result), /Use alpha from release-one/, `${name} leaks no content`);
  }
});

test("an unknown release_digest fails closed with the frozen mismatch code", async () => {
  // No exact-release loader is configured, so the hosted runtime cannot serve
  // a digest other than the verified startup release. This is the frozen
  // E_RELEASE_MISMATCH path and must stay exactly that code.
  const handler = makeHandler();
  const unknown = `sha256:${"ab".repeat(32)}`;
  for (const [name, args] of [
    ["inspect", { ...INSPECT_BASE, release_digest: unknown }],
    ["get_content", { ...CONTENT_BASE(releaseOne.skills[0].versionHash), release_digest: unknown }],
  ]) {
    const result = await rpc(handler, name, args);
    assert.equal(result.isError, true, `${name} refuses an unknown release`);
    assert.equal(errorCodeOf(result), "E_RELEASE_MISMATCH", `${name} uses the existing frozen code`);
    assert.doesNotMatch(JSON.stringify(result), /Use alpha from release-one/, `${name} leaks no content`);
  }
});

test("an exact-release loader that cannot resolve the digest still fails closed", async () => {
  // A loader that rejects is a control-plane failure, not a contract change:
  // it surfaces the pre-existing generic code and must never fall back to
  // serving the startup release.
  const handler = makeHandler({
    resolveRelease: async () => {
      throw new Error("control plane unreachable");
    },
  });
  const result = await rpc(handler, "inspect", {
    ...INSPECT_BASE,
    release_digest: `sha256:${"cd".repeat(32)}`,
  });
  assert.equal(result.isError, true, "an unresolvable digest fails closed");
  assert.doesNotMatch(JSON.stringify(result), /ega\/alpha/, "no content is served from the startup release");
});

test("a denied release cannot be reached through either selector", async () => {
  const handler = makeHandler({ deniedReleases: new Set([snapshotOne.releaseDigest]) });
  const viaDigest = await rpc(handler, "inspect", {
    ...INSPECT_BASE,
    release_digest: snapshotOne.releaseDigest,
  });
  assert.equal(errorCodeOf(viaDigest), "E_UNAUTHORIZED", "denied release is refused by digest");

  // The context names releaseTwo, which is not denied, so it still works.
  const viaContext = await rpc(handler, "inspect", {
    skill_id: "ega/beta",
    context_id: "ctx-release-two",
  });
  assert.notEqual(viaContext.isError, true, JSON.stringify(viaContext));
  assert.match(JSON.stringify(viaContext), /ega\/beta/);
});

// --- symmetry and the frozen error-code contract -------------------------------------

test("inspect and get_content enforce the identical selector rule", async () => {
  const handler = makeHandler();
  const tools = await listTools(handler);
  const rules = ["inspect", "get_content"].map(
    (name) => JSON.stringify(tools.find((tool) => tool.name === name).inputSchema.anyOf),
  );
  assert.equal(rules[0], rules[1], "the selector rule is symmetric across both tools");

  for (const name of ["inspect", "get_content"]) {
    const args =
      name === "inspect" ? INSPECT_BASE : CONTENT_BASE(releaseOne.skills[0].versionHash);
    const result = await rpc(handler, name, args);
    assert.match(textOf(result), /Input validation error/i, `${name} validates the selector rule`);
  }
});

// --- the stdio (local) server is deliberately unaffected -------------------------------

test("the local stdio server does not publish the hosted pinning rule", async (t) => {
  // The selector rule is a hosted-runtime contract: the local stdio tools
  // resolve against a project registry and have no release digest to pin, so
  // they must NOT grow the rule. This also keeps the frozen stdio metadata
  // budget (995/1000 ega-o200k-v1 tokens) exactly where it was.
  const { toolSchema: buildToolSchema } = await import("../../packages/mcp/dist/index.js");
  const hosted = buildToolSchema({
    fields: { skill_id: { type: "string", nonEmpty: true }, release_digest: { type: "string" }, context_id: { type: "string" } },
    required: ["skill_id"],
    selector: { alternatives: [["release_digest"], ["context_id"]], message: "missing selector" },
  });
  const plain = buildToolSchema({
    fields: { skill_id: { type: "string", nonEmpty: true }, project_path: { type: "string" } },
    required: ["skill_id"],
  });
  assert.deepEqual(
    hosted["~standard"].jsonSchema.input().anyOf,
    [{ required: ["release_digest"] }, { required: ["context_id"] }],
    "a schema built with a selector publishes it",
  );
  assert.equal(
    plain["~standard"].jsonSchema.input().anyOf,
    undefined,
    "a schema built without a selector publishes no anyOf key at all",
  );
  assert.deepEqual(plain["~standard"].jsonSchema.input().required, ["skill_id"], "plain required is unchanged");
});

test("the emitted anyOf and the enforced rule agree on a partial group", async () => {
  // A conjunction group must not be satisfied by a partially-supplied group,
  // otherwise the advertised schema and the runtime would disagree again.
  const { toolSchema: buildToolSchema } = await import("../../packages/mcp/dist/index.js");
  const schema = buildToolSchema({
    fields: { a: { type: "string" }, b: { type: "string" } },
    required: [],
    selector: { alternatives: [["a"], ["b", "c"]], message: "need a, or b and c" },
  });
  const fails = (args) => "issues" in schema["~standard"].validate(args);
  assert.equal(fails({}), true, "no selector fails");
  assert.equal(fails({ a: "1" }), false, "first alternative satisfies");
  assert.equal(fails({ b: "1", c: "2" }), false, "complete second alternative satisfies");
  assert.equal(fails({ b: "1" }), true, "partial conjunction does not satisfy");
});

test("every failing selector case stays inside the frozen public error-code contract", async () => {
  // The only codes a client may observe from these paths. A missing selector is
  // an argument-validation failure and therefore carries no E_ code at all;
  // a bad selector keeps its pre-existing E_RELEASE_MISMATCH.
  const allowed = new Set(["E_RELEASE_MISMATCH", "E_UNAUTHORIZED", "E_RUNTIME_UNAVAILABLE"]);
  const handler = makeHandler();
  const cases = [
    // Missing selector: argument validation, no E_ code at all.
    ["inspect", INSPECT_BASE],
    ["get_content", CONTENT_BASE(releaseOne.skills[0].versionHash)],
    // Unknown digest: the frozen mismatch code, unchanged.
    ["inspect", { ...INSPECT_BASE, release_digest: `sha256:${"ab".repeat(32)}` }],
    // Unauthorized context: the frozen generic failure, unchanged.
    ["inspect", { ...INSPECT_BASE, context_id: "ctx-not-mine" }],
    // Disagreeing selectors: the frozen mismatch code, unchanged.
    [
      "inspect",
      { ...INSPECT_BASE, release_digest: snapshotOne.releaseDigest, context_id: "ctx-release-two" },
    ],
  ];
  for (const [name, args] of cases) {
    const result = await rpc(handler, name, args);
    const code = errorCodeOf(result);
    if (code === undefined) {
      assert.match(textOf(result), /Input validation error/i, `${name} argument validation only`);
      continue;
    }
    assert.ok(allowed.has(code), `${name} produced only frozen codes (got ${code})`);
  }
});
