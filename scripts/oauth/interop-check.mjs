#!/usr/bin/env node
/**
 * Controlled OAuth 2.1 interoperability check against the managed Supabase
 * project, without Codex. Exercises discovery, dynamic client registration,
 * authorization code + PKCE (S256), consent approve/deny, token exchange,
 * refresh, replay, wrong verifier, and wrong redirect URI.
 *
 * Required environment:
 *   EGA_INTEROP_USER_TOKEN   an existing Supabase user access token (for the
 *                            consent step; obtain with an admin magic link)
 * Optional:
 *   EGA_INTEROP_SUPABASE_URL default https://divriwexbijtojjulqtu.supabase.co
 *   EGA_INTEROP_RESOURCE     default https://ega-skills-mcp.vercel.app/mcp
 *   EGA_INTEROP_REDIRECT     default http://127.0.0.1:8976/callback
 *   EGA_INTEROP_SCOPES       default "openid offline_access"
 *
 * Never prints tokens: only claim summaries (iss/aud/sub presence/client_id/
 * scope/exp) and check results.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.EGA_INTEROP_SUPABASE_URL ?? "https://divriwexbijtojjulqtu.supabase.co";
const USER_TOKEN = process.env.EGA_INTEROP_USER_TOKEN;
const RESOURCE = process.env.EGA_INTEROP_RESOURCE ?? "https://ega-skills-mcp.vercel.app/mcp";
const REDIRECT = process.env.EGA_INTEROP_REDIRECT ?? "http://127.0.0.1:8976/callback";
const SCOPES = process.env.EGA_INTEROP_SCOPES ?? "openid offline_access";
const CLIENT_NAME = "EGA Skills interop check";

if (!USER_TOKEN) {
  console.error("EGA_INTEROP_USER_TOKEN is required");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

function decodeClaims(token) {
  const [, payload] = token.split(".");
  if (!payload) return null;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function claimSummary(token) {
  const claims = decodeClaims(token);
  if (!claims) return null;
  return {
    iss: claims.iss,
    aud: claims.aud,
    sub: typeof claims.sub === "string" ? "present" : "missing",
    client_id: typeof claims.client_id === "string" ? claims.client_id : null,
    scope: claims.scope ?? null,
    role: claims.role ?? null,
    exp: claims.exp ?? null,
    resource_claim: "resource" in claims ? claims.resource : null,
    has_resource_claim: "resource" in claims,
  };
}

async function startAuthorization(client, { scope = SCOPES } = {}) {
  const { verifier, challenge } = pkce();
  const state = randomUUID();
  const url = new URL(`${SUPABASE_URL}/auth/v1/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope);
  url.searchParams.set("resource", RESOURCE);
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    return { error: { status: response.status, body: await response.text() } };
  }
  const authorizationId = new URL(location).searchParams.get("authorization_id");
  return { verifier, state, authorizationId, consentLocation: location };
}

async function consent(authorizationId, action) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}/consent`, {
    method: "POST",
    headers: { authorization: `Bearer ${USER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

async function exchange(fields) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(fields),
  });
}

async function main() {
  // 1. discovery
  const discoveryResponse = await fetchJson(`${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`);
  const discovery = discoveryResponse.body;
  check("oauth discovery 200", discoveryResponse.status === 200, String(discoveryResponse.status));
  check("discovery issuer", discovery?.issuer === `${SUPABASE_URL}/auth/v1`, discovery?.issuer);
  check("discovery has token endpoint", typeof discovery?.token_endpoint === "string");
  check("discovery has registration endpoint", typeof discovery?.registration_endpoint === "string", discovery?.registration_endpoint);
  check("discovery supports S256", Array.isArray(discovery?.code_challenge_methods_supported) && discovery.code_challenge_methods_supported.includes("S256"));
  console.log("scopes_supported:", JSON.stringify(discovery?.scopes_supported));
  console.log("grant_types_supported:", JSON.stringify(discovery?.grant_types_supported));

  // 2. dynamic client registration (public client)
  const registration = await fetchJson(discovery?.registration_endpoint ?? `${SUPABASE_URL}/auth/v1/oauth/clients/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: CLIENT_NAME,
    }),
  });
  check("dynamic client registration 201", registration.status === 201, `${registration.status} ${JSON.stringify(registration.body).slice(0, 160)}`);
  const client = registration.body;
  if (!client?.client_id) {
    console.log(JSON.stringify({ results, fatal: "registration failed" }, null, 2));
    process.exit(1);
  }

  // 3. happy path: authorize -> details -> approve -> exchange -> refresh
  const flow = await startAuthorization(client);
  check("authorize redirects to consent", Boolean(flow.authorizationId), flow.consentLocation ?? JSON.stringify(flow.error));
  if (flow.authorizationId) {
    const details = await fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${flow.authorizationId}`, {
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    check("authorization details 200", details.status === 200, JSON.stringify(details.body).slice(0, 160));
    check(
      "authorization details expose client and redirect",
      typeof details.body?.client?.id === "string" && typeof details.body?.redirect_uri === "string",
    );
    const approved = await consent(flow.authorizationId, "approve");
    check("consent approve returns redirect_url", approved.status === 200 && typeof approved.body?.redirect_url === "string", `${approved.status}`);
    const redirectUrl = approved.body?.redirect_url;
    const code = redirectUrl ? new URL(redirectUrl).searchParams.get("code") : null;
    const returnedState = redirectUrl ? new URL(redirectUrl).searchParams.get("state") : null;
    check("redirect carries code and state", Boolean(code) && returnedState === flow.state);

    if (code) {
      const tokenResponse = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: flow.verifier,
        resource: RESOURCE,
      });
      check("token exchange 200", tokenResponse.status === 200, `${tokenResponse.status} ${JSON.stringify(tokenResponse.body).slice(0, 160)}`);
      const tokens = tokenResponse.body;
      if (tokens?.access_token) {
        const summary = claimSummary(tokens.access_token);
        console.log("access_token_claims:", JSON.stringify(summary));
        check("access token subject preserved", summary?.sub === "present");
        check("access token client_id present", typeof summary?.client_id === "string");
        check(
          "resource binding claim present in access token",
          summary?.has_resource_claim === true,
          summary?.has_resource_claim ? String(summary.resource_claim) : "no resource claim",
        );
        if (tokens.refresh_token) {
          const refreshed = await exchange({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: client.client_id,
          });
          check("refresh exchange 200", refreshed.status === 200, `${refreshed.status}`);
          if (refreshed.body?.access_token) {
            check("refreshed access token differs", refreshed.body.access_token !== tokens.access_token);
            check("refreshed subject preserved", claimSummary(refreshed.body.access_token)?.sub === "present");
          }
        } else {
          check("refresh token issued", false);
        }
      }

      // code replay
      const replay = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: flow.verifier,
      });
      check("authorization code replay rejected", replay.status >= 400, `${replay.status}`);
    }
  }

  // 4. wrong verifier
  const wrongFlow = await startAuthorization(client);
  if (wrongFlow.authorizationId) {
    const approved = await consent(wrongFlow.authorizationId, "approve");
    const code = approved.body?.redirect_url ? new URL(approved.body.redirect_url).searchParams.get("code") : null;
    if (code) {
      const wrong = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      });
      check("wrong PKCE verifier rejected", wrong.status >= 400, `${wrong.status}`);
    }
  }

  // 5. wrong redirect URI
  const redirectFlow = await startAuthorization(client);
  if (redirectFlow.authorizationId) {
    const approved = await consent(redirectFlow.authorizationId, "approve");
    const code = approved.body?.redirect_url ? new URL(approved.body.redirect_url).searchParams.get("code") : null;
    if (code) {
      const wrongRedirect = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:9999/callback",
        code_verifier: redirectFlow.verifier,
      });
      check("wrong redirect_uri rejected", wrongRedirect.status >= 400, `${wrongRedirect.status}`);
    }
  }

  // 6. deny
  const denyFlow = await startAuthorization(client);
  if (denyFlow.authorizationId) {
    const denied = await consent(denyFlow.authorizationId, "deny");
    const redirectUrl = denied.body?.redirect_url;
    const error = redirectUrl ? new URL(redirectUrl).searchParams.get("error") : null;
    check("deny returns access_denied redirect", denied.status === 200 && error === "access_denied", `${denied.status} error=${error}`);
  }

  const failures = results.filter((entry) => !entry.ok);
  console.log(JSON.stringify({ results, failures: failures.map((entry) => entry.name) }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
