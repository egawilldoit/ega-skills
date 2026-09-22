#!/usr/bin/env node
/**
 * Mint (or refresh) a real delegated OAuth 2.1 access token for the hosted
 * MCP resource, using the managed Supabase authorization server. This is the
 * live counterpart of scripts/oauth/interop-check.mjs: the checks there are
 * assertions; here the resulting token is written to a 0600 file so later
 * steps (MCP smoke, client interop) can exercise the real credential without
 * ever putting it in shell output.
 *
 * Required environment:
 *   EGA_INTEROP_USER_TOKEN   a Supabase user access token (consent step)
 *   EGA_INTEROP_API_KEY      Supabase publishable/secret API key (consent API)
 *   EGA_INTEROP_TOKEN_OUT    output path for {"access_token","refresh_token"}
 *
 * Optional:
 *   EGA_INTEROP_SUPABASE_URL default https://divriwexbijtojjulqtu.supabase.co
 *   EGA_INTEROP_RESOURCE     default https://ega-skills-mcp.vercel.app/mcp
 *   EGA_INTEROP_REDIRECT     default http://127.0.0.1:8976/callback
 *   EGA_INTEROP_SCOPES       default "openid offline_access"
 *   EGA_INTEROP_EXPECTED_SUBJECT  assert the token subject
 *   EGA_INTEROP_MODE         "authorize" (default) or "refresh"
 *
 * Never prints tokens or raw response bodies: claim summaries only.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.EGA_INTEROP_SUPABASE_URL ?? "https://divriwexbijtojjulqtu.supabase.co";
const USER_TOKEN = process.env.EGA_INTEROP_USER_TOKEN;
const API_KEY = process.env.EGA_INTEROP_API_KEY;
const RESOURCE = process.env.EGA_INTEROP_RESOURCE ?? "https://ega-skills-mcp.vercel.app/mcp";
const REDIRECT = process.env.EGA_INTEROP_REDIRECT ?? "http://127.0.0.1:8976/callback";
const SCOPES = process.env.EGA_INTEROP_SCOPES ?? "openid offline_access";
const OUT = process.env.EGA_INTEROP_TOKEN_OUT;
const MODE = process.env.EGA_INTEROP_MODE ?? "authorize";
const EXPECTED_SUBJECT = process.env.EGA_INTEROP_EXPECTED_SUBJECT;

if (!USER_TOKEN || !API_KEY || !OUT) {
  console.error("EGA_INTEROP_USER_TOKEN, EGA_INTEROP_API_KEY and EGA_INTEROP_TOKEN_OUT are required");
  process.exit(2);
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

function claimSummary(token) {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return {
    iss: claims.iss,
    aud: claims.aud,
    subject_present: typeof claims.sub === "string" && claims.sub.trim() !== "",
    client_id_present: typeof claims.client_id === "string" && claims.client_id.trim() !== "",
    scope: typeof claims.scope === "string" ? claims.scope : null,
    exp: claims.exp ?? null,
  };
}

function assertIdentity(summary, label) {
  if (!summary) throw new Error(`${label}: token claims unreadable`);
  const audienceMatches = summary.aud === RESOURCE || (Array.isArray(summary.aud) && summary.aud.includes(RESOURCE));
  if (summary.iss !== `${SUPABASE_URL}/auth/v1`) throw new Error(`${label}: issuer mismatch`);
  if (!audienceMatches) throw new Error(`${label}: audience is not the canonical MCP resource`);
  if (!summary.subject_present) throw new Error(`${label}: subject missing`);
  if (!summary.client_id_present) throw new Error(`${label}: client_id missing`);
  console.log(`${label}: iss=supabase aud=resource subject=present client_id=present scope=${summary.scope ?? "none"} exp=${summary.exp}`);
}

function writeTokens(body) {
  writeFileSync(OUT, JSON.stringify({ access_token: body.access_token, refresh_token: body.refresh_token }, null, 2), { mode: 0o600 });
}

async function refresh() {
  const stored = JSON.parse(readFileSync(OUT, "utf8"));
  const refreshed = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    }).toString(),
  });
  if (refreshed.status !== 200 || !refreshed.body?.access_token) {
    throw new Error(`refresh exchange failed status=${refreshed.status}`);
  }
  const summary = claimSummary(refreshed.body.access_token);
  assertIdentity(summary, "refresh");
  if (refreshed.body.access_token === stored.access_token) throw new Error("refresh returned the same access token");
  writeTokens(refreshed.body);
  console.log("refresh: rotated access token written");
}

async function authorize() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/clients/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "EGA delegated token minter",
    }),
  });
  if (registration.status !== 201 || !registration.body?.client_id) {
    throw new Error(`dynamic client registration failed status=${registration.status}`);
  }
  const clientId = registration.body.client_id;
  const authorizeUrl = new URL(`${SUPABASE_URL}/auth/v1/oauth/authorize`);
  const state = randomUUID();
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: SCOPES,
    resource: RESOURCE,
  })) {
    authorizeUrl.searchParams.set(key, value);
  }
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const location = authorizeResponse.headers.get("location");
  if (authorizeResponse.status !== 302 || !location) throw new Error(`authorize failed status=${authorizeResponse.status}`);
  const authorizationId = new URL(location).searchParams.get("authorization_id");
  if (!authorizationId) throw new Error("authorize did not start a consent authorization");

  const authHeaders = { authorization: `Bearer ${USER_TOKEN}`, apikey: API_KEY };
  const details = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}`, { headers: authHeaders });
  if (details.status !== 200) throw new Error(`authorization details failed status=${details.status}`);
  const consent = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}/consent`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  const code = consent.body?.redirect_url ? new URL(consent.body.redirect_url).searchParams.get("code") : undefined;
  if (consent.status !== 200 || !code) throw new Error(`consent failed status=${consent.status}`);

  const exchange = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    }).toString(),
  });
  if (exchange.status !== 200 || !exchange.body?.access_token) throw new Error(`token exchange failed status=${exchange.status}`);
  const summary = claimSummary(exchange.body.access_token);
  assertIdentity(summary, "mint");
  if (EXPECTED_SUBJECT) {
    const claims = JSON.parse(Buffer.from(exchange.body.access_token.split(".")[1], "base64url").toString("utf8"));
    if (claims.sub !== EXPECTED_SUBJECT) throw new Error("minted subject mismatch");
  }
  writeTokens(exchange.body);
  console.log(`mint: refresh_token=${exchange.body.refresh_token ? "issued" : "absent"} written=0600`);
}

try {
  if (MODE === "refresh") await refresh();
  else if (MODE === "authorize") await authorize();
  else throw new Error(`unknown EGA_INTEROP_MODE ${MODE}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
