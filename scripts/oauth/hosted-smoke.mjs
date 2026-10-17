#!/usr/bin/env node
/**
 * Hosted deployment smoke for staging/preview deployments.
 *
 * Verifies the HTTP contract without printing any secret: liveness, readiness,
 * OAuth protected-resource metadata on both discovery paths, the anonymous
 * challenge, controlled 404/405 behavior, header-spoof resistance, and (when a
 * token file is provided) an authenticated four-tool catalog.
 *
 * Required:
 *   EGA_SMOKE_URL        deployment origin, e.g. https://ega-skills-<id>.vercel.app
 * Optional:
 *   EGA_SMOKE_BYPASS     Vercel protection-bypass value (never printed)
 *   EGA_SMOKE_TOKEN_FILE file containing {"access_token": "..."}
 *   EGA_SMOKE_EXPECT_RESOURCE  default https://ega-skills-mcp.vercel.app/mcp
 *   EGA_SMOKE_LABEL      label for the run
 *   EGA_SMOKE_EXPECT_READY     "1" (default) or "0" for fail-closed deployments
 */

import { readFileSync } from "node:fs";

const ORIGIN = process.env.EGA_SMOKE_URL;
const BYPASS = process.env.EGA_SMOKE_BYPASS;
const TOKEN_FILE = process.env.EGA_SMOKE_TOKEN_FILE;
const EXPECT_RESOURCE = process.env.EGA_SMOKE_EXPECT_RESOURCE ?? "https://ega-skills-mcp.vercel.app/mcp";
const LABEL = process.env.EGA_SMOKE_LABEL ?? "smoke";
const EXPECT_READY = (process.env.EGA_SMOKE_EXPECT_READY ?? "1") !== "0";

if (!ORIGIN) {
  console.error("EGA_SMOKE_URL is required");
  process.exit(2);
}
const base = new URL(ORIGIN).origin;
const token = TOKEN_FILE ? JSON.parse(readFileSync(TOKEN_FILE, "utf8")).access_token : undefined;

const summary = { label: LABEL, url: base, expect_ready: EXPECT_READY, checks: [], failures: [] };
function check(name, ok, detail) {
  summary.checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  if (!ok) summary.failures.push(name);
}

function headers(extra = {}) {
  return { ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}), ...extra };
}

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: headers(init.headers ?? {}), redirect: "manual" });
  const text = await response.text();
  return { status: response.status, text, wwwAuthenticate: response.headers.get("www-authenticate"), location: response.headers.get("location") };
}

const health = await request("/healthz");
check("healthz 200 ok", health.status === 200 && health.text.includes('"ok"'), `status=${health.status}`);

const ready = await request("/readyz");
if (EXPECT_READY) {
  check("readyz 200 ready", ready.status === 200 && ready.text.includes('"ready"'), `status=${ready.status}`);
} else {
  check("readyz not ready", ready.status !== 200, `status=${ready.status}`);
}

if (EXPECT_READY) {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const metadata = await request(path);
    let body;
    try {
      body = JSON.parse(metadata.text);
    } catch {
      body = undefined;
    }
    check(`metadata ${path} 200`, metadata.status === 200, `status=${metadata.status}`);
    check(`metadata ${path} canonical resource`, body?.resource === EXPECT_RESOURCE, `resource=${body?.resource ?? "missing"}`);
    check(`metadata ${path} authorization server`, Array.isArray(body?.authorization_servers) && body.authorization_servers.length === 1, `servers=${body?.authorization_servers?.length ?? 0}`);
    check(`metadata ${path} no secrets`, !/secret|token|key/i.test(metadata.text), undefined);
  }

  const spoofed = await request("/.well-known/oauth-protected-resource/mcp", { headers: { "x-forwarded-host": "attacker.example", forwarded: "host=attacker.example" } });
  check("metadata ignores forwarded host", spoofed.text.includes(EXPECT_RESOURCE) && !spoofed.text.includes("attacker.example"), `status=${spoofed.status}`);

  const metadataPost = await request("/.well-known/oauth-protected-resource", { method: "POST" });
  check("metadata POST 405", metadataPost.status === 405, `status=${metadataPost.status}`);

  const anonymous = await request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  check("anonymous /mcp 401", anonymous.status === 401, `status=${anonymous.status}`);
  check("anonymous /mcp challenge", /^Bearer /.test(anonymous.wwwAuthenticate ?? ""), anonymous.wwwAuthenticate ? "present" : "missing");
} else {
  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  check("fail-closed metadata is absent or canonical", metadata.status === 404 || metadata.text.includes(EXPECT_RESOURCE), `status=${metadata.status}`);
}

const unknown = await request("/definitely-not-a-route");
check("unknown route 404", unknown.status === 404 && unknown.text.includes("E_NOT_FOUND"), `status=${unknown.status}`);

if (EXPECT_READY) {
  if (token) {
    const authorized = await request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const dataLine = authorized.text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    const parsed = dataLine ? JSON.parse(dataLine.slice(5)) : undefined;
    const tools = (parsed?.result?.tools ?? []).map((tool) => tool.name).sort();
    check("authenticated /mcp 200", authorized.status === 200, `status=${authorized.status}`);
    check("authenticated tools are exactly four", JSON.stringify(tools) === JSON.stringify(["get_content", "inspect", "resolve", "search"]), `tools=${tools.join(",")}`);
  } else {
    const authorized = await request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer smoke-invalid", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    check("invalid token /mcp 401", authorized.status === 401, `status=${authorized.status}`);
  }
} else {
  const unavailable = await request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
  });
  check("fail-closed /mcp unavailable", unavailable.status === 503, `status=${unavailable.status}`);
  check("fail-closed /mcp exposes no tools", !unavailable.text.includes('"tools"'), undefined);
}

console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failures.length === 0 ? 0 : 1;
