#!/usr/bin/env node
/**
 * Real-client MCP probe for the hosted Streamable HTTP endpoint.
 *
 * Sends an authenticated `tools/list` and then explicitly invokes all four
 * V1 tools (resolve, search, inspect, get_content) instead of relying on
 * model-side tool selection. Prints a machine-readable summary with the
 * skill identity and a content digest; never prints the bearer token or any
 * response body verbatim.
 *
 * Required environment:
 *   EGA_MCP_TOKEN_FILE   file containing {"access_token": "...", ...}
 * Optional:
 *   EGA_MCP_URL              default https://ega-skills-mcp.vercel.app/mcp
 *   EGA_MCP_EXPECT_SKILL     default cursor/architect
 *   EGA_MCP_EXPECT_VERSION   assert the version hash returned by inspect
 *   EGA_MCP_EXPECT_DIGEST    assert the sha256 of get_content L2 bytes
 *   EGA_MCP_LABEL            label for the run
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const URL_ = process.env.EGA_MCP_URL ?? "https://ega-skills-mcp.vercel.app/mcp";
const TOKEN_FILE = process.env.EGA_MCP_TOKEN_FILE;
const BYPASS = process.env.EGA_MCP_PROTECTION_BYPASS;
const EXPECT_SKILL = process.env.EGA_MCP_EXPECT_SKILL ?? "cursor/architect";
const EXPECT_VERSION = process.env.EGA_MCP_EXPECT_VERSION;
const EXPECT_DIGEST = process.env.EGA_MCP_EXPECT_DIGEST;
const LABEL = process.env.EGA_MCP_LABEL ?? "mcp-probe";

if (!TOKEN_FILE) {
  console.error("EGA_MCP_TOKEN_FILE is required");
  process.exit(2);
}
const token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).access_token;
if (typeof token !== "string" || token.length === 0) {
  console.error("token file does not contain an access_token");
  process.exit(2);
}

let sequence = 0;
async function rpc(method, params) {
  sequence += 1;
  const response = await fetch(URL_, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: sequence, method, params }),
  });
  const text = await response.text();
  if (!response.ok) return { status: response.status, body: undefined };
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    const last = lines.at(-1)?.slice(5).trim();
    return { status: response.status, body: last ? JSON.parse(last) : undefined };
  }
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: undefined };
  }
}

function unwrap(callResult) {
  const structured = callResult?.result?.structuredContent;
  if (structured && typeof structured === "object") return structured.result ?? structured;
  const textPart = callResult?.result?.content?.find((part) => typeof part.text === "string");
  if (textPart) {
    try {
      return JSON.parse(textPart.text).result;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const summary = { label: LABEL, url: new URL(URL_).origin, checks: [], failures: [] };
function check(name, ok, detail) {
  summary.checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  if (!ok) summary.failures.push(name);
}

const list = await rpc("tools/list", {});
const tools = (list.body?.result?.tools ?? []).map((tool) => tool.name).sort();
check("tools/list 200", list.status === 200, `status=${list.status}`);
check("exactly four tools", JSON.stringify(tools) === JSON.stringify(["get_content", "inspect", "resolve", "search"]), `tools=${tools.join(",")}`);
summary.tools = tools;

const resolve = await rpc("tools/call", { name: "resolve", arguments: { task: "design the architecture for a new feature" } });
const resolveBody = unwrap(resolve.body);
const candidates = Array.isArray(resolveBody?.candidates) ? resolveBody.candidates : [];
check("resolve succeeds", resolve.status === 200 && resolve.body?.result?.isError !== true, `status=${resolve.status}`);
check("resolve returns the expected candidate", candidates.some((candidate) => candidate?.id === EXPECT_SKILL), `candidates=${candidates.length}`);

const search = await rpc("tools/call", { name: "search", arguments: { query: "architect" } });
const searchBody = unwrap(search.body);
const searchMatches = Array.isArray(searchBody?.results) ? searchBody.results : [];
check("search succeeds", search.status === 200 && search.body?.result?.isError !== true, `status=${search.status}`);
check("search finds the expected skill", searchMatches.some((match) => (match?.skill_id ?? match?.id) === EXPECT_SKILL), `matches=${searchMatches.length}`);

const releaseDigest = searchBody?.effective_release_digest ?? resolveBody?.effective_release_digest;
summary.release_digest = releaseDigest;
check("tools report an effective release digest", typeof releaseDigest === "string" && releaseDigest.startsWith("sha256:"), `digest=${releaseDigest ? "present" : "missing"}`);

const inspect = await rpc("tools/call", { name: "inspect", arguments: { skill_id: EXPECT_SKILL, ...(releaseDigest ? { release_digest: releaseDigest } : {}) } });
const inspectBody = unwrap(inspect.body);
const versionHash = inspectBody?.version_hash;
check("inspect succeeds", inspect.status === 200 && inspect.body?.result?.isError !== true, `status=${inspect.status}`);
check("inspect returns expected skill", inspectBody?.skill_id === EXPECT_SKILL, `skill_id=${inspectBody?.skill_id ?? "missing"}`);
summary.skill_id = inspectBody?.skill_id;
summary.version_hash = versionHash;
if (EXPECT_VERSION) {
  check("version hash matches expected identity", versionHash === EXPECT_VERSION, `version_hash=${versionHash ?? "missing"}`);
}

if (versionHash) {
  const content = await rpc("tools/call", {
    name: "get_content",
    arguments: { skill_id: EXPECT_SKILL, version_hash: versionHash, level: "L2", max_tokens: 100000, ...(releaseDigest ? { release_digest: releaseDigest } : {}) },
  });
  const contentBody = unwrap(content.body);
  const contentText = contentBody?.content;
  check("get_content succeeds", content.status === 200 && content.body?.result?.isError !== true, `status=${content.status}`);
  check("get_content returns text", typeof contentText === "string" && contentText.length > 0, `bytes=${typeof contentText === "string" ? Buffer.byteLength(contentText) : 0}`);
  if (typeof contentText === "string") {
    const digest = `sha256:${createHash("sha256").update(Buffer.from(contentText, "utf8")).digest("hex")}`;
    summary.content_digest = digest;
    summary.content_bytes = Buffer.byteLength(contentText);
    if (EXPECT_DIGEST) check("content digest matches expected bytes", digest === EXPECT_DIGEST, `digest=${digest}`);
  }
} else {
  check("get_content skipped without version hash", false, "inspect returned no version_hash");
}

console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failures.length === 0 ? 0 : 1;
