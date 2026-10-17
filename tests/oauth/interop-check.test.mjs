import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";

const SENTINEL = "oauth-sentinel-token-must-not-appear";
const USER_SUBJECT = "known-user-subject";
const API_KEY = "publishable-api-key-sentinel";
const HARNESS = "scripts/oauth/interop-check.mjs";

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(claims) {
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.signature`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function startStub(mode) {
  const codes = new Map();
  let authorizationNumber = 0;
  let clientNumber = 0;
  let refreshNumber = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await readBody(request);
    if (mode === "provider-500") {
      send(response, 500, { error: "server_error", error_description: SENTINEL });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/auth/v1") {
      send(response, 200, {
        issuer: `${base}/auth/v1`,
        token_endpoint: `${base}/auth/v1/oauth/token`,
        registration_endpoint: `${base}/auth/v1/oauth/clients/register`,
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/auth/v1/oauth/clients/register" && request.method === "POST") {
      clientNumber += 1;
      if (mode === "setup-failure") {
        send(response, 201, { error: "registration_failed", detail: SENTINEL });
        return;
      }
      send(response, 201, { client_id: `client-${clientNumber}` });
      return;
    }
    if (url.pathname === "/auth/v1/oauth/authorize" && request.method === "GET") {
      const query = url.searchParams;
      authorizationNumber += 1;
      const authorizationId = `authorization-${authorizationNumber}`;
      codes.set(authorizationId, {
        clientId: query.get("client_id"),
        redirectUri: query.get("redirect_uri"),
        state: query.get("state"),
        challenge: query.get("code_challenge"),
        approved: false,
        used: false,
      });
      response.writeHead(302, { location: `${base}/consent?authorization_id=${authorizationId}` });
      response.end();
      return;
    }
    const detailsMatch = url.pathname.match(/^\/auth\/v1\/oauth\/authorizations\/(.+)$/);
    if (detailsMatch && request.method === "GET") {
      if (request.headers.authorization !== "Bearer user-token" || request.headers.apikey !== API_KEY) {
        send(response, 401, { error: "invalid_client" });
        return;
      }
      const state = codes.get(detailsMatch[1]);
      if (!state) {
        send(response, 404, { error: "invalid_request" });
        return;
      }
      send(response, 200, { client: { id: state.clientId }, redirect_uri: state.redirectUri });
      return;
    }
    const consentMatch = url.pathname.match(/^\/auth\/v1\/oauth\/authorizations\/(.+)\/consent$/);
    if (consentMatch && request.method === "POST") {
      if (request.headers.authorization !== "Bearer user-token" || request.headers.apikey !== API_KEY) {
        send(response, 401, { error: "invalid_client" });
        return;
      }
      const state = codes.get(consentMatch[1]);
      const action = JSON.parse(body).action;
      if (!state) {
        send(response, 404, { error: "invalid_request" });
        return;
      }
      if (action === "deny") {
        send(response, 200, { redirect_url: `${state.redirectUri}?error=access_denied&state=${encodeURIComponent(state.state)}` });
        return;
      }
      state.approved = true;
      const code = `code-${consentMatch[1]}`;
      state.code = code;
      codes.set(code, state);
      const query = new URLSearchParams({ state: state.state });
      if (mode !== "missing-code") query.set("code", code);
      send(response, 200, { redirect_url: `${state.redirectUri}?${query}` });
      return;
    }
    if (url.pathname === "/auth/v1/oauth/token" && request.method === "POST") {
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");
      if (grantType === "refresh_token") {
        if (params.get("refresh_token") !== "refresh-token") {
          send(response, 400, { error: "invalid_grant" });
          return;
        }
        refreshNumber += 1;
        const accessToken = mode === "sentinel" ? SENTINEL : jwt({ sub: USER_SUBJECT, client_id: "client-1", aud: "https://mcp.example.test", refresh: refreshNumber });
        send(response, 200, { access_token: accessToken, token_type: "bearer" });
        return;
      }
      const state = codes.get(params.get("code"));
      if (!state || state.used || params.get("code_verifier") === "wrong") {
        send(response, 400, { error: "invalid_grant" });
        return;
      }
      const verifier = params.get("code_verifier");
      const actualChallenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : null;
      if (params.get("redirect_uri") !== state.redirectUri || params.get("client_id") !== state.clientId || actualChallenge !== state.challenge) {
        send(response, 400, { error: "invalid_grant" });
        return;
      }
      state.used = true;
      const subject = mode === "changed-subject" ? "unexpected-subject" : USER_SUBJECT;
      const clientId = mode === "changed-client" ? "unexpected-client" : state.clientId;
      const accessToken = mode === "sentinel" ? SENTINEL : jwt({ sub: subject, client_id: clientId, aud: "https://mcp.example.test" });
      send(response, 200, { access_token: accessToken, token_type: "bearer", ...(mode === "missing-refresh" ? {} : { refresh_token: "refresh-token" }) });
      return;
    }
    send(response, 404, { error: "invalid_request" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { server, base };
}

function runHarness(base, mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HARNESS], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EGA_INTEROP_SUPABASE_URL: base,
        EGA_INTEROP_RESOURCE: "https://mcp.example.test",
        EGA_INTEROP_USER_TOKEN: "user-token",
        EGA_INTEROP_API_KEY: API_KEY,
        EGA_INTEROP_EXPECTED_SUBJECT: USER_SUBJECT,
        EGA_INTEROP_MODE: mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("OAuth interop harness exercises the real orchestration offline and redacts response bodies", async (t) => {
  for (const mode of ["happy", "changed-subject", "changed-client", "missing-code", "missing-refresh", "setup-failure", "provider-500", "sentinel"]) {
    await t.test(mode, async () => {
      const stub = await startStub(mode);
      try {
        const result = await runHarness(stub.base, mode);
        const output = `${result.stdout}\n${result.stderr}`;
        assert.doesNotMatch(output, new RegExp(SENTINEL));
        if (mode === "happy") {
          assert.equal(result.status, 0, output);
          assert.match(output, /PASS authorization code replay rejected/);
          assert.match(output, /PASS wrong PKCE verifier rejected/);
          assert.match(output, /PASS wrong redirect_uri rejected/);
        } else {
          assert.notEqual(result.status, 0, `${mode} unexpectedly passed\n${output}`);
        }
        assert.match(output, /results/);
      } finally {
        await new Promise((resolve, reject) => stub.server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }
});
