#!/usr/bin/env node
/**
 * Headless completion of a real OpenCode `mcp auth` OAuth flow.
 *
 * Mirrors tests/integration/client-codex/remote-login.mjs for the OpenCode
 * client: OpenCode performs discovery, dynamic client registration, PKCE and
 * token exchange itself; this harness only performs the user-consent step via
 * the Supabase REST consent API and delivers the code to OpenCode's loopback
 * callback listener.
 *
 * Required environment:
 *   EGA_OPENCODE_CONFIG_HOME  isolated XDG_CONFIG_HOME
 *   EGA_OPENCODE_DATA_HOME    isolated XDG_DATA_HOME
 *   EGA_INTEROP_USER_TOKEN    Supabase user access token
 *   EGA_INTEROP_API_KEY       Supabase publishable/secret API key
 * Optional:
 *   EGA_OPENCODE_SERVER       default "ega-skills"
 *   EGA_OPENCODE_LOGIN_TIMEOUT_MS default 180000
 *   EGA_OPENCODE_LOGIN_LOG    raw output path (mode 0600)
 *
 * Never prints authorization codes, tokens, cookies, or full URLs.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CONFIG_HOME = process.env.EGA_OPENCODE_CONFIG_HOME;
const DATA_HOME = process.env.EGA_OPENCODE_DATA_HOME;
const USER_TOKEN = process.env.EGA_INTEROP_USER_TOKEN;
const API_KEY = process.env.EGA_INTEROP_API_KEY;
const SERVER = process.env.EGA_OPENCODE_SERVER ?? "ega-skills";
const TIMEOUT = Number(process.env.EGA_OPENCODE_LOGIN_TIMEOUT_MS ?? 180000);
const LOG_PATH = process.env.EGA_OPENCODE_LOGIN_LOG;
const SUPABASE_URL = process.env.EGA_INTEROP_SUPABASE_URL ?? "https://divriwexbijtojjulqtu.supabase.co";
const RESOURCE = process.env.EGA_INTEROP_RESOURCE ?? "https://ega-skills-mcp.vercel.app/mcp";

if (!CONFIG_HOME || !DATA_HOME || !USER_TOKEN || !API_KEY) {
  console.error("EGA_OPENCODE_CONFIG_HOME, EGA_OPENCODE_DATA_HOME, EGA_INTEROP_USER_TOKEN and EGA_INTEROP_API_KEY are required");
  process.exit(2);
}

const summary = { server: SERVER, checks: [], failures: [] };
function check(name, ok, detail) {
  summary.checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  if (!ok) summary.failures.push(name);
}

const stripAnsi = (value) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const child = spawn("opencode", ["mcp", "auth", SERVER], {
  env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME, XDG_DATA_HOME: DATA_HOME },
  stdio: ["ignore", "pipe", "pipe"],
});

let raw = "";
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    raw += chunk;
    output += stripAnsi(chunk);
  });
}
const exitPromise = new Promise((resolve) => child.on("close", (code) => resolve(code ?? -1)));

async function waitForAuthorizeUrl() {
  const deadline = Date.now() + TIMEOUT;
  for (;;) {
    const match = /https:\/\/[^\s"]+\/oauth\/authorize\?[^\s"]+/.exec(output);
    if (match) return match[0];
    if (Date.now() > deadline) throw new Error("opencode did not print an authorization URL in time");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

function sanitize(text) {
  return stripAnsi(text)
    .replace(/https?:\/\/[^\s"]+\/oauth\/authorize\?[^\s"]+/g, "<authorize-url>")
    .replace(/(code|state|code_challenge|code_verifier|refresh_token|access_token)=[^&\s"]+/g, "$1=<redacted>");
}

try {
  const authorizeUrl = await waitForAuthorizeUrl();
  const authorize = new URL(authorizeUrl);
  const clientId = authorize.searchParams.get("client_id") ?? "";
  const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
  const state = authorize.searchParams.get("state");
  check("opencode printed authorization URL", true);
  check("authorization request uses PKCE S256", authorize.searchParams.get("code_challenge_method") === "S256");
  check("authorization request pins the MCP resource", authorize.searchParams.get("resource") === RESOURCE);
  check(
    "client_id indicates DCR (UUID) rather than CIMD (URL)",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId),
    `client_id_kind=${/^https?:/.test(clientId) ? "url" : "opaque"}`,
  );
  const redirect = new URL(redirectUri);
  check("redirect_uri is loopback callback", redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost", `port=${redirect.port}`);
  summary.redirect_port = Number(redirect.port);
  summary.client_id_kind = /^https?:/.test(clientId) ? "url" : "opaque-uuid";

  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const location = authorizeResponse.headers.get("location");
  const authorizationId = location ? new URL(location).searchParams.get("authorization_id") : undefined;
  check("authorize redirects to consent", authorizeResponse.status === 302 && Boolean(authorizationId), `status=${authorizeResponse.status}`);

  const headers = { authorization: `Bearer ${USER_TOKEN}`, apikey: API_KEY };
  const details = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}`, { headers });
  check("authorization details readable", details.status === 200, `status=${details.status}`);
  const consent = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}/consent`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  const redirectUrl = consent.body?.redirect_url;
  check("consent approved", consent.status === 200 && typeof redirectUrl === "string", `status=${consent.status}`);
  if (typeof redirectUrl !== "string") throw new Error("consent did not return a redirect URL");

  {
    const callback = await fetch(redirectUrl, { redirect: "manual" });
    check("code delivered to opencode callback", callback.status < 500, `status=${callback.status}`);
    const callbackUrl = new URL(redirectUrl);
    check("callback carries state", callbackUrl.searchParams.get("state") === state && Boolean(state));
    check("callback carries a code", typeof callbackUrl.searchParams.get("code") === "string");
  }

  const exitCode = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT)),
  ]);
  check("opencode auth exited successfully", exitCode === 0, `exit=${exitCode}`);
  if (exitCode === "timeout") child.kill();
} catch (error) {
  check("login harness completed", false, error instanceof Error ? error.message : String(error));
  child.kill();
} finally {
  if (LOG_PATH) writeFileSync(LOG_PATH, sanitize(raw), { mode: 0o600 });
}

console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failures.length === 0 ? 0 : 1;
