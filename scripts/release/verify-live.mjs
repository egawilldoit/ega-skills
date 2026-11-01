#!/usr/bin/env node
/**
 * Verify one live EGA Skills production release.
 *
 * This is a verifier, not a publisher: it never mutates Vercel state. It
 * compares the release expected by the checked-out Git commit with the
 * deployment-specific runtime and the canonical production alias, then
 * exercises the authenticated MCP surface.
 *
 * Environment (all optional unless noted):
 *   EGA_VERIFY_ORIGIN               canonical origin (default https://ega-skills-mcp.vercel.app)
 *   EGA_VERIFY_DEPLOYMENT_URL       deployment-specific origin from the deployment event
 *   EGA_VERIFY_TARGET_DEPLOYMENT_ID expected Vercel deployment id (dpl_...)
 *   EGA_VERIFY_EXPECTED_MANIFEST    default packages/mcp/artifact/hub-release.json
 *   EGA_VERIFY_EXPECTED_PACKAGE     default packages/mcp/artifact/release-package.json
 *   EGA_VERIFY_TSTACK_PREFIX        default t3dotgg/
 *   EGA_VERIFY_TOKEN_FILE           required 0600 JSON file with {"access_token": "..."}
 *   EGA_VERIFY_BYPASS               optional Vercel protection-bypass header value
 *   EGA_VERIFY_TIMEOUT_MS           overall promotion wait (default 900000)
 *   EGA_VERIFY_POLL_MS              polling interval (default 10000)
 *   EGA_VERIFY_SOURCE_SHA           optional source commit for the summary
 *   VERCEL_TOKEN                    required Vercel API token
 *   VERCEL_TEAM_ID                  optional Vercel team id
 *   VERCEL_PROJECT_ID               required Vercel project id
 *   VERCEL_CANONICAL_ALIAS          required canonical production alias
 *   VERCEL_API_BASE                 default https://api.vercel.com (test seam)
 *
 * Exit codes:
 *   0 verified
 *   2 configuration or authentication failure
 *   3 not promoted / CI check failed or still pending at the bounded deadline
 *   4 live verification failed after promotion (recovery required)
 *
 * Never prints the bearer token or the protection-bypass value.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT_VERIFIED = 0;
export const EXIT_CONFIG = 2;
export const EXIT_NOT_PROMOTED = 3;
export const EXIT_LIVE_FAILED = 4;

const DEFAULT_ORIGIN = "https://ega-skills-mcp.vercel.app";
const DEFAULT_MANIFEST = "packages/mcp/artifact/hub-release.json";
const DEFAULT_PACKAGE = "packages/mcp/artifact/release-package.json";
const DEFAULT_TSTACK_PREFIX = "t3dotgg/";
// The production deployment check waits for the full main-branch CI run.
// Fifteen minutes covers a full Linux + Windows-capable run without turning a
// genuine failure into an early timeout.
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_POLL_MS = 10_000;
const REQUIRED_TOOLS = ["get_content", "inspect", "resolve", "search"];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const FAILED_CHECK_STATES = new Set(["failed", "failure", "canceled", "cancelled", "skipped"]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export class RpcError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RpcError";
    this.status = details.status;
    this.rpcCode = details.rpcCode;
  }
}

export class ToolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ToolError";
    this.code = details.code;
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return parsed;
}

function normalizeOrigin(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${name} is required`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.origin;
  } catch {
    throw new ConfigError(`${name} must be an http(s) origin`);
  }
}

function normalizeOptionalOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return normalizeOrigin(value, "EGA_VERIFY_DEPLOYMENT_URL");
}

/** Read the expected catalog from the files bound by the checked-out commit. */
export function loadExpectedCatalog({ manifestPath, packagePath }) {
  let manifest;
  let releasePackage;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    releasePackage = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot read expected release files: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest === null || typeof manifest !== "object") throw new ConfigError("hub-release.json must be an object");
  if (manifest.object_type !== "ega.hub-release") throw new ConfigError("hub-release.json is not an ega.hub-release");
  const digest = manifest.digest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) throw new ConfigError("hub-release.json has an invalid digest");
  const versions = manifest.payload?.skill_versions;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
    throw new ConfigError("hub-release.json has no skill_versions map");
  }
  const skills = Object.entries(versions).map(([skillId, versionHash]) => {
    if (typeof skillId !== "string" || skillId.length === 0 || !skillId.includes("/")) {
      throw new ConfigError("hub-release.json has a malformed skill id");
    }
    if (typeof versionHash !== "string" || !DIGEST_RE.test(versionHash)) {
      throw new ConfigError(`hub-release.json has an invalid version hash for ${skillId}`);
    }
    return [skillId, versionHash];
  });
  if (skills.length === 0) throw new ConfigError("hub-release.json has an empty catalog");
  if (new Set(skills.map(([skillId]) => skillId)).size !== skills.length) {
    throw new ConfigError("hub-release.json contains duplicate skill ids");
  }
  if (releasePackage === null || typeof releasePackage !== "object") {
    throw new ConfigError("release-package.json must be an object");
  }
  if (releasePackage.hub_release_digest !== digest) {
    throw new ConfigError("release-package.json digest does not match hub-release.json");
  }
  const snapshotRows = releasePackage.snapshot_rows;
  if (!Number.isSafeInteger(snapshotRows) || snapshotRows < 0) {
    throw new ConfigError("release-package.json has an invalid snapshot_rows");
  }
  if (skills.length !== snapshotRows) {
    throw new ConfigError(`catalog count ${skills.length} does not match snapshot_rows ${snapshotRows}`);
  }
  return { digest, snapshotRows, skillVersions: versions, skills };
}

export function readConfig(env = process.env, cwd = process.cwd()) {
  const tokenFile = env.EGA_VERIFY_TOKEN_FILE;
  if (typeof tokenFile !== "string" || tokenFile.trim() === "") {
    throw new ConfigError("EGA_VERIFY_TOKEN_FILE is required");
  }
  for (const name of ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_CANONICAL_ALIAS"]) {
    if (typeof env[name] !== "string" || env[name].trim() === "") throw new ConfigError(`${name} is required`);
  }
  return {
    origin: normalizeOrigin(env.EGA_VERIFY_ORIGIN ?? DEFAULT_ORIGIN, "EGA_VERIFY_ORIGIN"),
    deploymentUrl: normalizeOptionalOrigin(env.EGA_VERIFY_DEPLOYMENT_URL),
    targetDeploymentId: env.EGA_VERIFY_TARGET_DEPLOYMENT_ID?.trim() || null,
    manifestPath: resolve(cwd, env.EGA_VERIFY_EXPECTED_MANIFEST ?? DEFAULT_MANIFEST),
    packagePath: resolve(cwd, env.EGA_VERIFY_EXPECTED_PACKAGE ?? DEFAULT_PACKAGE),
    tstackPrefix: env.EGA_VERIFY_TSTACK_PREFIX ?? DEFAULT_TSTACK_PREFIX,
    tokenFile: resolve(cwd, tokenFile),
    bypass: env.EGA_VERIFY_BYPASS?.trim() || null,
    timeoutMs: positiveInteger(env.EGA_VERIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "EGA_VERIFY_TIMEOUT_MS"),
    pollMs: positiveInteger(env.EGA_VERIFY_POLL_MS, DEFAULT_POLL_MS, "EGA_VERIFY_POLL_MS"),
    sourceSha: env.EGA_VERIFY_SOURCE_SHA?.trim() || env.GITHUB_SHA?.trim() || null,
    vercel: {
      token: env.VERCEL_TOKEN.trim(),
      teamId: env.VERCEL_TEAM_ID?.trim() || null,
      projectId: env.VERCEL_PROJECT_ID.trim(),
      canonicalAlias: env.VERCEL_CANONICAL_ALIAS.trim().replace(/^https?:\/\//i, "").replace(/\/$/, ""),
      baseUrl: env.VERCEL_API_BASE?.trim() || "https://api.vercel.com",
    },
  };
}

/** Read the delegated MCP bearer token. Missing or malformed is a hard failure. */
export function readToken(tokenFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot read EGA_VERIFY_TOKEN_FILE: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.access_token !== "string" || parsed.access_token.trim() === "") {
    throw new ConfigError("EGA_VERIFY_TOKEN_FILE does not contain a non-empty access_token");
  }
  return parsed.access_token;
}

/**
 * Parse either a JSON or SSE Streamable HTTP response into the JSON-RPC body.
 * Returns the last complete JSON object (or the matching batch entry).
 */
export function parseJsonRpcBody(text, expectedId) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return undefined;
  const candidates = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // fall through to SSE parsing
    }
  }
  if (candidates.length === 0) {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // ignore malformed event frames and keep looking
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    const entries = Array.isArray(candidate) ? candidate : [candidate];
    if (expectedId === undefined) {
      const last = entries[entries.length - 1];
      if (last && typeof last === "object") return last;
      continue;
    }
    for (const entry of entries) {
      if (entry && typeof entry === "object" && entry.id === expectedId) return entry;
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
}

/**
 * Normalize an MCP CallToolResult. Reads `structuredContent` (including a
 * `result` wrapper) and falls back to the first JSON text content block.
 */
export function parseToolResult(value) {
  const result = value?.result ?? value;
  if (result === null || typeof result !== "object") return { isError: true, output: undefined, error: undefined, text: undefined };
  const isError = result.isError === true;
  let output;
  if (result.structuredContent !== null && typeof result.structuredContent === "object") {
    const structured = result.structuredContent;
    output = structured.result !== undefined && typeof structured.result === "object" ? structured.result : structured;
  }
  let text;
  if (Array.isArray(result.content)) {
    const block = result.content.find((entry) => entry?.type === "text" && typeof entry.text === "string");
    if (block) {
      text = block.text;
      if (output === undefined) {
        try {
          const parsed = JSON.parse(block.text);
          output = parsed?.result !== undefined ? parsed.result : parsed;
        } catch {
          // Compact inspect text is not JSON; structuredContent carries the output.
        }
      }
    }
  }
  let error;
  for (const candidate of [output, (() => { try { return JSON.parse(text ?? ""); } catch { return undefined; } })()]) {
    if (candidate !== null && typeof candidate === "object" && candidate.error !== undefined) {
      error = candidate.error;
      break;
    }
  }
  return { isError, output, error, text };
}

async function fetchText(url, { headers = {}, timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

/** One POST to /mcp. Returns the raw JSON-RPC envelope. */
export async function rpc({ origin, token, method, params, bypass, timeoutMs = 20_000, fetchImpl = fetch, id = 1 }) {
  if (typeof token !== "string" || token === "") throw new AuthError("MCP bearer token is missing");
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  let response;
  try {
    response = await fetchImpl(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch (error) {
    throw new RpcError(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new AuthError(`MCP authentication failed with status ${response.status}`);
  if (!response.ok) throw new RpcError(`MCP request failed with status ${response.status}`, { status: response.status });
  const body = parseJsonRpcBody(text, id);
  if (body === undefined) throw new RpcError("MCP response was empty or not JSON/SSE");
  if (body.error !== undefined) {
    const message = typeof body.error?.message === "string" ? body.error.message : "MCP JSON-RPC error";
    throw new RpcError(message, { rpcCode: body.error?.code });
  }
  return body.result;
}

async function callTool(options, name, args) {
  const result = await rpc({ ...options, method: "tools/call", params: { name, arguments: args } });
  const parsed = parseToolResult(result);
  if (parsed.isError) {
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : parsed.text ?? "tool call failed";
    throw new ToolError(message, { code: parsed.error?.code });
  }
  if (parsed.output === undefined) throw new ToolError(`tool ${name} returned no output`);
  return parsed.output;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export function createVercelClient({ token, teamId, baseUrl, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (typeof token !== "string" || token === "") throw new ConfigError("VERCEL_TOKEN is required");
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  async function request(path, { method = "GET", body } = {}) {
    const url = new URL(path, base);
    if (teamId) url.searchParams.set("teamId", teamId);
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch (error) {
      throw new RpcError(`Vercel API request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (response.status === 401 || response.status === 403) throw new AuthError(`Vercel API authentication failed with status ${response.status}`);
    if (!response.ok) {
      const error = new RpcError(`Vercel API ${path} failed with status ${response.status}`, { status: response.status });
      error.body = parsed;
      throw error;
    }
    return parsed;
  }
  return {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", ...(body === undefined ? {} : { body }) }),
    patch: (path, body) => request(path, { method: "PATCH", body }),
    async readAlias(alias) {
      const body = await request(`/v4/aliases/${encodeURIComponent(alias)}`);
      const deploymentId = body?.deploymentId ?? body?.deployment?.id ?? body?.uid ?? null;
      return { deploymentId: typeof deploymentId === "string" ? deploymentId : null, body };
    },
    readDeployment: (deploymentId) => request(`/v13/deployments/${encodeURIComponent(deploymentId)}`),
    // The live platform returns `{ runs: [...] }`; `checks` is accepted only
    // as a local-test fallback.
    readDeploymentChecks: (deploymentId) => request(`/v2/deployments/${encodeURIComponent(deploymentId)}/check-runs`),
  };
}

/**
 * A failed/canceled/skipped deployment check for the configured GitHub check.
 *
 * Vercel names the check run after the project check ("GitHub CI gate") and
 * carries the reusable external name in `source.externalCheckName`. Matching
 * only the external name is what keeps this correct on the real platform.
 */
export function ciGateState(checks, externalCheckName = "ci-gate") {
  if (!Array.isArray(checks)) return { name: externalCheckName, state: "pending", url: null };
  const runs = checks.filter((entry) =>
    entry?.source?.externalCheckName === externalCheckName ||
    entry?.name === externalCheckName ||
    entry?.name === "GitHub CI gate");
  if (runs.length === 0) return { name: externalCheckName, state: "pending", url: null };
  let pending = false;
  for (const check of runs) {
    const state = String(check.conclusion ?? check.status ?? "").toLowerCase();
    const url = check.url ?? check.details_url ?? check.externalUrl ?? null;
    if (FAILED_CHECK_STATES.has(state)) return { name: externalCheckName, state: "failed", detail: state, url };
    if (state !== "success" && state !== "neutral") pending = true;
  }
  return { name: externalCheckName, state: pending ? "pending" : "success", url: runs[0]?.url ?? null };
}

/** Compatibility helper: a failed gate, or null for pending/success. */
export function ciGateFailure(checks, externalCheckName = "ci-gate") {
  const state = ciGateState(checks, externalCheckName);
  return state.state === "failed" ? state : null;
}

async function readCiGateState(vercel, deploymentId) {
  if (!deploymentId) return { name: "ci-gate", state: "pending", url: null };
  try {
    const body = await vercel.readDeploymentChecks(deploymentId);
    return ciGateState(Array.isArray(body) ? body : body?.runs ?? body?.checks);
  } catch (error) {
    if (error?.status === 404) return { name: "ci-gate", state: "pending", url: null };
    // A transient checks API outage must not be confused with a live release
    // failure: alias/digest verification still decides the outcome.
    if (error instanceof AuthError) throw error;
    return { name: "ci-gate", state: "pending", url: null };
  }
}

function parseReadyBody(text) {
  try {
    const body = JSON.parse(text);
    return { body, digest: typeof body?.release_digest === "string" ? body.release_digest : null };
  } catch {
    return { body: undefined, digest: null };
  }
}

/** One liveness/readiness sample. */
export async function probeReadyOnce({ origin, bypass, timeoutMs = 10_000, fetchImpl = fetch }) {
  const headers = bypass ? { "x-vercel-protection-bypass": bypass } : {};
  let health;
  let ready;
  try {
    health = await fetchText(`${origin}/healthz`, { headers, timeoutMs, fetchImpl });
  } catch {
    health = undefined;
  }
  try {
    ready = await fetchText(`${origin}/readyz`, { headers, timeoutMs, fetchImpl });
  } catch {
    ready = undefined;
  }
  const parsed = ready ? parseReadyBody(ready.text) : { digest: null };
  return {
    healthStatus: health?.status ?? null,
    readyStatus: ready?.status ?? null,
    digest: parsed.digest,
    body: parsed.body,
  };
}

/** Poll a deployment-specific origin until ready with the expected digest. */
export async function probeDeployment({ origin, bypass, expectedDigest, timeoutMs, pollMs, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) }) {
  const deadline = now() + timeoutMs;
  let last = { healthStatus: null, readyStatus: null, digest: null };
  for (;;) {
    last = await probeReadyOnce({ origin, bypass, timeoutMs: Math.min(20_000, Math.max(1, deadline - now())), fetchImpl });
    if (last.healthStatus === 200 && last.readyStatus === 200 && last.digest === expectedDigest) {
      return { state: "ready", ...last };
    }
    if (now() >= deadline) {
      return { state: last.readyStatus === 200 ? "digest_mismatch" : "unready", ...last };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/**
 * Poll the canonical alias and /readyz until the alias points at the target
 * deployment and serves the expected digest.
 */
export async function waitForCanonical({
  expectedDigest,
  targetDeploymentId,
  timeoutMs,
  pollMs,
  readAlias,
  readReady,
  readCiGate,
  now = Date.now,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
}) {
  const deadline = now() + timeoutMs;
  let aliasTarget = null;
  let ready = { healthStatus: null, readyStatus: null, digest: null };
  let lastError = null;
  let lastCi = null;
  for (;;) {
    const ci = await readCiGate();
    lastCi = ci;
    if (ci?.state === "failed") return { state: "ci_failed", aliasTarget, ready, ci };
    try {
      aliasTarget = await readAlias();
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    try {
      ready = await readReady();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const targetReached = targetDeploymentId ? aliasTarget === targetDeploymentId : typeof aliasTarget === "string" && aliasTarget.length > 0;
    if (targetReached && ready.readyStatus === 200 && ready.digest === expectedDigest) {
      return { state: "ready", aliasTarget, ready, ci: lastCi };
    }
    if (now() >= deadline) {
      if (!targetReached) {
        // Pending is not a failure. Report that the bounded wait expired while
        // the gate was still pending, rather than inventing a CI failure.
        return { state: lastCi?.state === "pending" ? "ci_pending" : "not_promoted", aliasTarget, ready, ci: lastCi, error: lastError };
      }
      return { state: "digest_mismatch", aliasTarget, ready, ci: lastCi, error: lastError };
    }
    await sleep(pollMs);
  }
}

/**
 * Exercise the authenticated four-tool MCP surface against one exact release.
 * Returns a machine-readable result; throws ToolError/AuthError on mismatch.
 */
export async function verifyCatalog({
  origin,
  token,
  expected,
  tstackPrefix = DEFAULT_TSTACK_PREFIX,
  bypass,
  timeoutMs = 30_000,
  fetchImpl = fetch,
  concurrency = 6,
}) {
  const options = { origin, token, bypass, timeoutMs, fetchImpl };
  const list = await rpc({ ...options, id: 1, method: "tools/list", params: {} });
  const tools = Array.isArray(list?.tools) ? list.tools.map((tool) => tool?.name).filter((name) => typeof name === "string").sort() : [];
  if (JSON.stringify(tools) !== JSON.stringify(REQUIRED_TOOLS)) {
    throw new ToolError(`tools/list returned ${JSON.stringify(tools)}; expected exactly ${JSON.stringify(REQUIRED_TOOLS)}`);
  }
  const checks = [{ name: "tools/list", ok: true, tools }];

  const inspected = await mapLimit(expected.skills, concurrency, async ([skillId, versionHash], index) => {
    const output = await callTool({ ...options, id: 100 + index }, "inspect", {
      skill_id: skillId,
      version_hash: versionHash,
      release_digest: expected.digest,
    });
    if (output?.version_hash !== versionHash) {
      throw new ToolError(`inspect ${skillId} returned version_hash ${String(output?.version_hash)}; expected ${versionHash}`);
    }
    if (output?.skill_id !== undefined && output.skill_id !== skillId) {
      throw new ToolError(`inspect ${skillId} returned skill_id ${String(output.skill_id)}`);
    }
    for (const field of ["effective_release_digest", "release_digest"]) {
      if (output?.[field] !== undefined && output[field] !== expected.digest) {
        throw new ToolError(`inspect ${skillId} reported ${field} ${String(output[field])}`);
      }
    }
    return { skill_id: skillId, version_hash: versionHash };
  });
  checks.push({ name: "inspect_all", ok: true, count: inspected.length });

  const tstack = expected.skills.filter(([skillId]) => skillId.startsWith(tstackPrefix));
  if (tstack.length === 0) throw new ToolError(`no skills match EGA_VERIFY_TSTACK_PREFIX ${JSON.stringify(tstackPrefix)}`);
  const tstackChecked = [];
  for (let index = 0; index < tstack.length; index += 1) {
    const [skillId, versionHash] = tstack[index];
    const output = await callTool({ ...options, id: 10_000 + index }, "get_content", {
      skill_id: skillId,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 1_000_000,
      release_digest: expected.digest,
    });
    if (typeof output?.content !== "string" || output.content.trim() === "") {
      throw new ToolError(`get_content L2 returned empty content for ${skillId}`);
    }
    if (output?.version_hash !== versionHash) {
      throw new ToolError(`get_content ${skillId} returned version_hash ${String(output?.version_hash)}; expected ${versionHash}`);
    }
    for (const field of ["effective_release_digest", "release_digest"]) {
      if (output?.[field] !== undefined && output[field] !== expected.digest) {
        throw new ToolError(`get_content ${skillId} reported ${field} ${String(output[field])}`);
      }
    }
    tstackChecked.push({ skill_id: skillId, version_hash: versionHash, content_chars: output.content.length });
  }
  checks.push({ name: "tstack_get_content_l2", ok: true, count: tstackChecked.length });

  const search = await callTool({ ...options, id: 20_000 }, "search", {
    query: "skill",
    limit: 5,
    release_digest: expected.digest,
  });
  if (!Array.isArray(search?.results) || search.results.length === 0) {
    throw new ToolError("representative search returned no results");
  }
  if (search?.effective_release_digest !== undefined && search.effective_release_digest !== expected.digest) {
    throw new ToolError(`search reported release_digest ${String(search.effective_release_digest)}`);
  }
  checks.push({ name: "search", ok: true, result_count: search.results.length });

  return {
    tools,
    inspected: inspected.length,
    tstack: tstackChecked,
    search_result_count: search.results.length,
    checks,
  };
}

function sourceSha(configured) {
  if (configured) return configured;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function writeSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function failureSummary(summary, code, reason, extra = {}) {
  Object.assign(summary, extra, { ok: false, exit_code: code, reason });
  writeSummary(summary);
  return code;
}

export async function main(env = process.env, cwd = process.cwd(), fetchImpl = fetch) {
  const summary = {
    ok: false,
    source_sha: sourceSha(env.EGA_VERIFY_SOURCE_SHA?.trim() || env.GITHUB_SHA?.trim() || null),
    canonical_alias: env.VERCEL_CANONICAL_ALIAS ?? null,
    deployment_id: env.EGA_VERIFY_TARGET_DEPLOYMENT_ID ?? null,
    deployment_url: env.EGA_VERIFY_DEPLOYMENT_URL ?? null,
    canonical_origin: env.EGA_VERIFY_ORIGIN ?? DEFAULT_ORIGIN,
    release_digest: null,
    skill_count: null,
    snapshot_rows: null,
    canonical_alias_target: null,
    tstack: [],
    checks: [],
  };
  try {
    const config = readConfig(env, cwd);
    const expected = loadExpectedCatalog({ manifestPath: config.manifestPath, packagePath: config.packagePath });
    const token = readToken(config.tokenFile);
    summary.release_digest = expected.digest;
    summary.skill_count = expected.skills.length;
    summary.snapshot_rows = expected.snapshotRows;
    summary.canonical_alias = config.vercel.canonicalAlias;
    summary.deployment_id = config.targetDeploymentId;
    summary.deployment_url = config.deploymentUrl;
    summary.canonical_origin = config.origin;

    const vercel = createVercelClient({
      token: config.vercel.token,
      teamId: config.vercel.teamId,
      baseUrl: config.vercel.baseUrl,
      fetchImpl,
      timeoutMs: Math.min(30_000, config.timeoutMs),
    });

    // A GitHub deployment_status event exposes the deployment URL, not the
    // Vercel deployment id. Resolve the immutable id before checking the gate
    // or the alias, so a same-digest deployment elsewhere cannot satisfy the
    // verification.
    if (!config.targetDeploymentId && config.deploymentUrl) {
      try {
        const deployment = await vercel.readDeployment(config.deploymentUrl);
        if (typeof deployment?.id === "string" && /^dpl_/.test(deployment.id)) {
          config.targetDeploymentId = deployment.id;
          summary.deployment_id = deployment.id;
        }
      } catch (error) {
        if (error instanceof AuthError) throw error;
        // Leave the id unresolved; the caller will verify the canonical digest
        // without claiming provenance from an unmapped deployment URL.
      }
    }

    const gate = await readCiGateState(vercel, config.targetDeploymentId);
    if (gate.state === "failed") {
      summary.checks.push({ name: "ci-gate", ok: false, state: gate.state });
      return failureSummary(summary, EXIT_NOT_PROMOTED, `Vercel deployment check ci-gate is ${gate.detail ?? gate.state}`, { ci_gate: gate });
    }

    if (config.deploymentUrl) {
      const probe = await probeDeployment({
        origin: config.deploymentUrl,
        bypass: config.bypass,
        expectedDigest: expected.digest,
        timeoutMs: config.timeoutMs,
        pollMs: config.pollMs,
        fetchImpl,
      });
      summary.checks.push({
        name: "deployment_ready",
        ok: probe.state === "ready",
        state: probe.state,
        health_status: probe.healthStatus,
        ready_status: probe.readyStatus,
        digest: probe.digest,
      });
      if (probe.state !== "ready") {
        let aliasTarget = null;
        try {
          aliasTarget = (await vercel.readAlias(config.vercel.canonicalAlias)).deploymentId;
        } catch {
          // An unreadable alias is treated as not promoted: no recovery.
        }
        summary.canonical_alias_target = aliasTarget;
        const promoted = config.targetDeploymentId ? aliasTarget === config.targetDeploymentId : false;
        if (promoted) {
          return failureSummary(summary, EXIT_LIVE_FAILED, `deployment-specific runtime is ${probe.state} after promotion`);
        }
        return failureSummary(summary, EXIT_NOT_PROMOTED, `deployment-specific runtime is ${probe.state} before promotion`);
      }
    }

    const wait = await waitForCanonical({
      expectedDigest: expected.digest,
      targetDeploymentId: config.targetDeploymentId,
      timeoutMs: config.timeoutMs,
      pollMs: config.pollMs,
      readAlias: async () => (await vercel.readAlias(config.vercel.canonicalAlias)).deploymentId,
      readReady: () => probeReadyOnce({ origin: config.origin, bypass: config.bypass, timeoutMs: Math.min(20_000, config.timeoutMs), fetchImpl }),
      readCiGate: () => readCiGateState(vercel, config.targetDeploymentId),
    });
    summary.canonical_alias_target = wait.aliasTarget;
    summary.checks.push({
      name: "canonical_alias",
      ok: wait.state === "ready",
      state: wait.state,
      target: wait.aliasTarget,
      ready_status: wait.ready.readyStatus,
      digest: wait.ready.digest,
    });
    if (wait.state === "ci_failed") {
      return failureSummary(summary, EXIT_NOT_PROMOTED, `Vercel deployment check ci-gate is ${wait.ci.detail ?? wait.ci.state}`, { ci_gate: wait.ci });
    }
    if (wait.state === "ci_pending") {
      summary.checks.push({ name: "ci-gate", ok: false, state: "pending", url: wait.ci?.url ?? null });
      return failureSummary(summary, EXIT_NOT_PROMOTED, "Vercel deployment check ci-gate was still pending when the bounded wait expired", { ci_gate: wait.ci });
    }
    if (wait.state === "not_promoted") {
      return failureSummary(summary, EXIT_NOT_PROMOTED, "canonical alias was not promoted to the target deployment");
    }
    if (wait.state !== "ready") {
      return failureSummary(summary, EXIT_LIVE_FAILED, "canonical alias serves an unexpected release digest");
    }

    const catalog = await verifyCatalog({
      origin: config.origin,
      token,
      expected,
      tstackPrefix: config.tstackPrefix,
      bypass: config.bypass,
      timeoutMs: Math.min(60_000, config.timeoutMs),
      fetchImpl,
    });
    summary.tstack = catalog.tstack;
    summary.checks.push(...catalog.checks);
    summary.verified_at = new Date().toISOString();
    Object.assign(summary, {
      ok: true,
      exit_code: EXIT_VERIFIED,
      reason: "verified",
      tools: catalog.tools,
      inspected: catalog.inspected,
      search_result_count: catalog.search_result_count,
    });
    writeSummary(summary);
    return EXIT_VERIFIED;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.checks.push({ name: "verification", ok: false, error: message });
    if (error instanceof ConfigError || error instanceof AuthError) {
      return failureSummary(summary, EXIT_CONFIG, message);
    }
    return failureSummary(summary, EXIT_LIVE_FAILED, message);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const code = await main();
  process.exitCode = code;
}
