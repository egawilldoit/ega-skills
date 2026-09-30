#!/usr/bin/env node
/**
 * Headless completion of a real Codex `mcp login` OAuth flow.
 *
 * Codex performs discovery, dynamic client registration (or CIMD), PKCE, and
 * its own token exchange; it only needs the user-consent step, which normally
 * happens in a browser. This harness plays that part with the Supabase REST
 * consent API (the same mechanism as scripts/oauth/interop-check.mjs):
 *
 *   1. spawn `codex mcp login <server>` and read the authorization URL it
 *      prints (never printed by this harness);
 *   2. fetch the authorization URL to obtain the pending authorization id;
 *   3. read authorization details, approve consent with the staging user;
 *   4. deliver the resulting code to Codex's local callback listener.
 *
 * Required environment:
 *   EGA_CODEX_HOME            isolated CODEX_HOME (never the operator's)
 *   EGA_INTEROP_USER_TOKEN    Supabase user access token
 *   EGA_INTEROP_API_KEY       Supabase publishable/secret API key
 * Optional:
 *   EGA_CODEX_SERVER          default "ega-skills"
 *   EGA_CODEX_REGISTRATION    default "auto" (auto|dcr|cimd)
 *   EGA_CODEX_LOGIN_TIMEOUT_MS default 180000
 *   EGA_CODEX_LOGIN_LOG       path for raw login output (mode 0600)
 *
 * Never prints authorization codes, tokens, cookies, or full URLs.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const HOME = process.env.EGA_CODEX_HOME;
const USER_TOKEN = process.env.EGA_INTEROP_USER_TOKEN;
const API_KEY = process.env.EGA_INTEROP_API_KEY;
const SERVER = process.env.EGA_CODEX_SERVER ?? "ega-skills";
const REGISTRATION = process.env.EGA_CODEX_REGISTRATION ?? "auto";
const TIMEOUT = Number(process.env.EGA_CODEX_LOGIN_TIMEOUT_MS ?? 180000);
const LOG_PATH = process.env.EGA_CODEX_LOGIN_LOG;
const SUPABASE_URL = process.env.EGA_INTEROP_SUPABASE_URL ?? "https://divriwexbijtojjulqtu.supabase.co";
const RESOURCE = process.env.EGA_INTEROP_RESOURCE ?? "https://ega-skills-mcp.vercel.app/mcp";

if (!HOME || !USER_TOKEN || !API_KEY) {
  console.error("EGA_CODEX_HOME, EGA_INTEROP_USER_TOKEN and EGA_INTEROP_API_KEY are required");
  process.exit(2);
}

const summary = { server: SERVER, registration: REGISTRATION, checks: [], failures: [] };
function check(name, ok, detail) {
  summary.checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  if (!ok) summary.failures.push(name);
}

const child = spawn("codex", ["mcp", "login", SERVER, "--oauth-client-registration", REGISTRATION], {
  env: { ...process.env, CODEX_HOME: HOME },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

const exitPromise = new Promise((resolve) => child.on("close", (code) => resolve(code ?? -1)));

async function waitForAuthorizeUrl() {
  const deadline = Date.now() + TIMEOUT;
  for (;;) {
    const match = /https:\/\/[^\s"]+\/oauth\/authorize\?[^\s"]+/.exec(output);
    if (match) return match[0];
    if (Date.now() > deadline) throw new Error("codex did not print an authorization URL in time");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function sanitize(text) {
  return text
    .replace(/https?:\/\/[^\s"]+\/oauth\/authorize\?[^\s"]+/g, "<authorize-url>")
    .replace(/(code|state|code_challenge|code_verifier|refresh_token|access_token)=[^&\s"]+/g, "$1=<redacted>");
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
  return { status: response.status, body, headers: response.headers };
}

try {
  const authorizeUrl = await waitForAuthorizeUrl();
  const authorize = new URL(authorizeUrl);
  const clientId = authorize.searchParams.get("client_id") ?? "";
  const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
  const state = authorize.searchParams.get("state");
  const challenge = authorize.searchParams.get("code_challenge");
  check("codex printed authorization URL", true);
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

  // 2. The authorization URL lands on the consent UI with a pending authorization id.
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const location = authorizeResponse.headers.get("location");
  const authorizationId = location ? new URL(location).searchParams.get("authorization_id") : undefined;
  check("authorize redirects to consent", authorizeResponse.status === 302 && Boolean(authorizationId), `status=${authorizeResponse.status}`);

  // 3. Approve consent with the staging user.
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

  // 4. Deliver the code to Codex's own callback listener.
  {
    const callback = await fetch(redirectUrl, { redirect: "manual" });
    check("code delivered to codex callback", callback.status < 500, `status=${callback.status}`);
    const callbackUrl = new URL(redirectUrl);
    check("callback carries state", callbackUrl.searchParams.get("state") === state && Boolean(state));
    check("callback carries a code", typeof callbackUrl.searchParams.get("code") === "string");
  }

  const exitCode = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT)),
  ]);
  check("codex login exited successfully", exitCode === 0, `exit=${exitCode}`);
  if (exitCode === "timeout") child.kill();
} catch (error) {
  check("login harness completed", false, error instanceof Error ? error.message : String(error));
  child.kill();
} finally {
  if (LOG_PATH) writeFileSync(LOG_PATH, sanitize(output), { mode: 0o600 });
}

console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failures.length === 0 ? 0 : 1;
