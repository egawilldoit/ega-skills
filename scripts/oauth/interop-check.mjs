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
 *   EGA_INTEROP_API_KEY      Supabase publishable/anon API key used by the
 *                            authenticated authorization-detail/consent APIs
 *   EGA_INTEROP_EXPECTED_SUBJECT optional independently known subject; when
 *                            absent, the subject claim in the user token is used
 * Optional:
 *   EGA_INTEROP_SUPABASE_URL default https://divriwexbijtojjulqtu.supabase.co
 *   EGA_INTEROP_RESOURCE     default https://ega-skills-mcp.vercel.app/mcp
 *   EGA_INTEROP_REDIRECT     default http://127.0.0.1:8976/callback
 *   EGA_INTEROP_SCOPES       default "openid offline_access"
 *
 * Never prints tokens or response bodies: only allowlisted status/error
 * summaries, redacted claim comparisons, and check results.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.EGA_INTEROP_SUPABASE_URL ?? "https://divriwexbijtojjulqtu.supabase.co";
const USER_TOKEN = process.env.EGA_INTEROP_USER_TOKEN;
const API_KEY = process.env.EGA_INTEROP_API_KEY;
const RESOURCE = process.env.EGA_INTEROP_RESOURCE ?? "https://ega-skills-mcp.vercel.app/mcp";
const REDIRECT = process.env.EGA_INTEROP_REDIRECT ?? "http://127.0.0.1:8976/callback";
const SCOPES = process.env.EGA_INTEROP_SCOPES ?? "openid offline_access";
const CLIENT_NAME = "EGA Skills interop check";

const ALLOWED_OAUTH_ERRORS = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "network_error",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
]);

if (!USER_TOKEN) {
  console.error("EGA_INTEROP_USER_TOKEN is required");
  process.exit(2);
}
if (!API_KEY) {
  console.error("EGA_INTEROP_API_KEY is required");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

function oauthErrorCode(body) {
  const value = body !== null && typeof body === "object" && !Array.isArray(body) ? body.error : undefined;
  if (typeof value !== "string") return undefined;
  return ALLOWED_OAUTH_ERRORS.has(value) ? value : "unrecognized";
}

function responseDetail(response) {
  const status = Number.isInteger(response.status) ? response.status : 0;
  const code = oauthErrorCode(response.body);
  return code === undefined ? `status=${status}` : `status=${status} error=${code}`;
}

function flowDetail(flow) {
  return flow.authorizationId ? "authorization_id=present" : `status=${flow.error?.status ?? 0}`;
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function fetchJson(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    return { status: 0, body: { error: "network_error" }, networkError: true };
  }
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

function audienceContains(claims, expected) {
  return claims?.aud === expected || (Array.isArray(claims?.aud) && claims.aud.includes(expected));
}

function claimSummary(token) {
  let claims;
  try {
    claims = decodeClaims(token);
  } catch {
    return null;
  }
  if (!claims) return null;
  return {
    iss: claims.iss,
    aud: claims.aud,
    subject: typeof claims.sub === "string" ? claims.sub : null,
    clientId: typeof claims.client_id === "string" ? claims.client_id : null,
    scope: claims.scope ?? null,
    role: claims.role ?? null,
    exp: claims.exp ?? null,
    audience_matches_resource: audienceContains(claims, RESOURCE),
  };
}

const EXPECTED_SUBJECT = process.env.EGA_INTEROP_EXPECTED_SUBJECT ?? claimSummary(USER_TOKEN ?? "")?.subject;

function claimDetail(summary) {
  return `subject=${summary?.subject === EXPECTED_SUBJECT && EXPECTED_SUBJECT ? "match" : "mismatch"} client_id=${summary?.clientId ? "present" : "missing"}`;
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
  let response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch {
    return { error: { status: 0 } };
  }
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    await response.text();
    return { error: { status: response.status } };
  }
  const authorizationId = new URL(location).searchParams.get("authorization_id");
  return { verifier, state, authorizationId, consentLocation: location };
}

async function authorizationDetails(authorizationId) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}`, {
    headers: {
      authorization: `Bearer ${USER_TOKEN}`,
      apikey: API_KEY,
    },
  });
}

async function consent(authorizationId, action) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${authorizationId}/consent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${USER_TOKEN}`,
      apikey: API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action }),
  });
}

// Supabase's OAuth consent store permits only one live authorization per
// (user, client) pair: once a client has an approved authorization, later
// consent attempts for the same client fail (400). Negative-path flows
// therefore register their own client so each authorization starts on a
// clean consent record. This changes the harness, never the asserted
// security property.
async function registerClient(label) {
  const registration = await fetchJson(
    `${SUPABASE_URL}/auth/v1/oauth/clients/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: label,
      }),
    },
  );
  return registration.status === 201 && registration.body?.client_id
    ? { client: registration.body, registration }
    : undefined;
}

async function exchange(fields) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(fields),
  });
}

function finish() {
  const failures = results.filter((entry) => !entry.ok);
  console.log(JSON.stringify({ results, failures: failures.map((entry) => entry.name) }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

function failRemaining(reason) {
  for (const name of [
    "authorize redirects to consent",
    "authorization details 200",
    "consent approve returns redirect_url",
    "redirect carries code and state",
    "token exchange 200",
    "refresh token issued",
    "authorization code replay rejected",
    "wrong verifier authorization setup",
    "wrong PKCE verifier rejected",
    "wrong redirect authorization setup",
    "wrong redirect_uri rejected",
    "deny authorization setup",
    "deny returns access_denied redirect",
  ]) {
    if (!results.some((entry) => entry.name === name)) check(name, false, `status=0 error=${reason}`);
  }
}

async function main() {
  // 1. discovery
  const discoveryResponse = await fetchJson(`${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`);
  const discovery = discoveryResponse.body;
  check("oauth discovery 200", discoveryResponse.status === 200, responseDetail(discoveryResponse));
  check("discovery issuer", discovery?.issuer === `${SUPABASE_URL}/auth/v1`, responseDetail(discoveryResponse));
  check("discovery has token endpoint", typeof discovery?.token_endpoint === "string", responseDetail(discoveryResponse));
  check("discovery has registration endpoint", typeof discovery?.registration_endpoint === "string", responseDetail(discoveryResponse));
  check("discovery supports S256", Array.isArray(discovery?.code_challenge_methods_supported) && discovery.code_challenge_methods_supported.includes("S256"), responseDetail(discoveryResponse));

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
  check("dynamic client registration 201", registration.status === 201, responseDetail(registration));
  const client = registration.body;
  if (!client?.client_id) {
    check("dynamic client registration returns client_id", false, responseDetail(registration));
    failRemaining("setup_failure");
    return finish();
  }

  // 3. happy path: authorize -> details -> approve -> exchange -> refresh
  const flow = await startAuthorization(client);
  check("authorize redirects to consent", Boolean(flow.authorizationId), flowDetail(flow));
  if (flow.authorizationId) {
    const details = await authorizationDetails(flow.authorizationId);
    check("authorization details 200", details.status === 200, responseDetail(details));
    check(
      "authorization details expose client and redirect",
      typeof details.body?.client?.id === "string" && typeof details.body?.redirect_uri === "string",
    );
    const approved = await consent(flow.authorizationId, "approve");
    check("consent approve returns redirect_url", approved.status === 200 && typeof approved.body?.redirect_url === "string", responseDetail(approved));
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
      check("token exchange 200", tokenResponse.status === 200, responseDetail(tokenResponse));
      const tokens = tokenResponse.body;
      if (tokens?.access_token) {
        const summary = claimSummary(tokens.access_token);
        check("access token subject preserved", summary?.subject === EXPECTED_SUBJECT && Boolean(EXPECTED_SUBJECT), claimDetail(summary));
        check("access token client_id matches registered client", summary?.clientId === client.client_id, claimDetail(summary));
        check(
          "access token audience is the canonical MCP resource",
          summary?.audience_matches_resource === true,
          summary?.audience_matches_resource ? "audience=match" : "audience=mismatch",
        );
        if (tokens.refresh_token) {
          const refreshed = await exchange({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: client.client_id,
          });
          check("refresh exchange 200", refreshed.status === 200, responseDetail(refreshed));
          if (refreshed.body?.access_token) {
            check("refreshed access token differs", refreshed.body.access_token !== tokens.access_token);
            check("refreshed subject preserved", claimSummary(refreshed.body.access_token)?.subject === EXPECTED_SUBJECT && Boolean(EXPECTED_SUBJECT), claimDetail(claimSummary(refreshed.body.access_token)));
            check(
              "refreshed audience is the canonical MCP resource",
              claimSummary(refreshed.body.access_token)?.audience_matches_resource === true,
              claimSummary(refreshed.body.access_token)?.audience_matches_resource ? "audience=match" : "audience=mismatch",
            );
          }
        } else {
          check("refresh token issued", false);
        }
      } else {
        check("access token returned", false, responseDetail(tokenResponse));
        check("refresh token issued", false, responseDetail(tokenResponse));
      }

      // code replay
      const replay = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: flow.verifier,
      });
      check("authorization code replay rejected", replay.status === 400 && oauthErrorCode(replay.body) === "invalid_grant", responseDetail(replay));
    } else {
      check("token exchange 200", false, "status=0 error=missing_code");
      check("refresh token issued", false, "status=0 error=missing_code");
      check("authorization code replay rejected", false, "status=0 error=missing_code");
    }
  } else {
    check("authorization details 200", false, "status=0 error=missing_authorization_id");
    check("consent approve returns redirect_url", false, "status=0 error=missing_authorization_id");
    check("redirect carries code and state", false, "status=0 error=missing_authorization_id");
    check("token exchange 200", false, "status=0 error=missing_authorization_id");
    check("refresh token issued", false, "status=0 error=missing_authorization_id");
    check("authorization code replay rejected", false, "status=0 error=missing_authorization_id");
  }

  // 4. wrong verifier (fresh client: see registerClient comment)
  const wrongVerifierClient = (await registerClient(`${CLIENT_NAME} (wrong verifier)`))?.client;
  const wrongFlow = await startAuthorization(wrongVerifierClient ?? client);
  check("wrong verifier authorization setup", Boolean(wrongFlow.authorizationId), flowDetail(wrongFlow));
  if (wrongFlow.authorizationId) {
    const wrongDetails = await authorizationDetails(wrongFlow.authorizationId);
    check("wrong verifier authorization details", wrongDetails.status === 200, responseDetail(wrongDetails));
    const approved = await consent(wrongFlow.authorizationId, "approve");
    check("wrong verifier consent setup", approved.status === 200 && typeof approved.body?.redirect_url === "string", responseDetail(approved));
    const code = approved.body?.redirect_url ? new URL(approved.body.redirect_url).searchParams.get("code") : null;
    check("wrong verifier code available", Boolean(code), responseDetail(approved));
    if (code) {
      const wrong = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: (wrongVerifierClient ?? client).client_id,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      });
      check("wrong PKCE verifier rejected", wrong.status === 400 && oauthErrorCode(wrong.body) === "invalid_grant", responseDetail(wrong));
    } else {
      check("wrong PKCE verifier rejected", false, "status=0 error=missing_code");
    }
  } else {
    check("wrong verifier authorization details", false, "status=0 error=missing_authorization_id");
    check("wrong verifier consent setup", false, "status=0 error=missing_authorization_id");
    check("wrong verifier code available", false, "status=0 error=missing_authorization_id");
    check("wrong PKCE verifier rejected", false, "status=0 error=missing_authorization_id");
  }

  // 5. wrong redirect URI (fresh client: see registerClient comment)
  const wrongRedirectClient = (await registerClient(`${CLIENT_NAME} (wrong redirect)`))?.client;
  const redirectFlow = await startAuthorization(wrongRedirectClient ?? client);
  check("wrong redirect authorization setup", Boolean(redirectFlow.authorizationId), flowDetail(redirectFlow));
  if (redirectFlow.authorizationId) {
    const redirectDetails = await authorizationDetails(redirectFlow.authorizationId);
    check("wrong redirect authorization details", redirectDetails.status === 200, responseDetail(redirectDetails));
    const approved = await consent(redirectFlow.authorizationId, "approve");
    check("wrong redirect consent setup", approved.status === 200 && typeof approved.body?.redirect_url === "string", responseDetail(approved));
    const code = approved.body?.redirect_url ? new URL(approved.body.redirect_url).searchParams.get("code") : null;
    check("wrong redirect code available", Boolean(code), responseDetail(approved));
    if (code) {
      const wrongRedirect = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: (wrongRedirectClient ?? client).client_id,
        redirect_uri: "http://127.0.0.1:9999/callback",
        code_verifier: redirectFlow.verifier,
      });
      check("wrong redirect_uri rejected", wrongRedirect.status === 400 && oauthErrorCode(wrongRedirect.body) === "invalid_grant", responseDetail(wrongRedirect));
    } else {
      check("wrong redirect_uri rejected", false, "status=0 error=missing_code");
    }
  } else {
    check("wrong redirect authorization details", false, "status=0 error=missing_authorization_id");
    check("wrong redirect consent setup", false, "status=0 error=missing_authorization_id");
    check("wrong redirect code available", false, "status=0 error=missing_authorization_id");
    check("wrong redirect_uri rejected", false, "status=0 error=missing_authorization_id");
  }

  // 6. deny (fresh client: see registerClient comment)
  const denyClient = (await registerClient(`${CLIENT_NAME} (deny)`))?.client;
  const denyFlow = await startAuthorization(denyClient ?? client);
  check("deny authorization setup", Boolean(denyFlow.authorizationId), flowDetail(denyFlow));
  if (denyFlow.authorizationId) {
    const denyDetails = await authorizationDetails(denyFlow.authorizationId);
    check("deny authorization details", denyDetails.status === 200, responseDetail(denyDetails));
    const denied = await consent(denyFlow.authorizationId, "deny");
    const redirectUrl = denied.body?.redirect_url;
    const error = redirectUrl ? new URL(redirectUrl).searchParams.get("error") : null;
    check("deny returns access_denied redirect", denied.status === 200 && error === "access_denied", responseDetail(denied));
  } else {
    check("deny authorization details", false, "status=0 error=missing_authorization_id");
    check("deny returns access_denied redirect", false, "status=0 error=missing_authorization_id");
  }

  finish();
}

main().catch((error) => {
  void error;
  console.error("OAuth interop harness failed before completing its checks");
  process.exitCode = 1;
});
