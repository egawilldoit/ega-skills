#!/usr/bin/env node
/**
 * Supabase management helper for the EGA Skills OAuth 2.1 program.
 *
 * Uses only the Supabase Management API. Requires a personal access token in
 * SUPABASE_ACCESS_TOKEN (never commit or log it). Project ref defaults to the
 * production EGA SKILLS project and can be overridden with
 * EGA_SUPABASE_PROJECT_REF.
 *
 * Commands:
 *   inspect            Show the current auth configuration (OAuth fields, Site URL)
 *   discovery          Fetch the authorization-server discovery document
 *   keys               Print the public client keys (publishable + legacy anon)
 *   apply-migration    Apply supabase/migrations/202609180001_delegated_oauth_containment.sql
 *   apply-audience-hook Apply the dedicated MCP audience custom access-token hook
 *   containment-status Report the restrictive policy / grant state of the containment migration
 *   enable-oauth       Enable the OAuth 2.1 server, DCR, and set the authorization path
 *                      (--path=https://<auth-ui>/oauth/consent --hook-enabled=true)
 *   disable-oauth      Disable the OAuth 2.1 server (fail-closed gate)
 *
 * Example:
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/oauth/supabase-management.mjs inspect
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API = "https://api.supabase.com/v1";
const PROJECT_REF = process.env.EGA_SUPABASE_PROJECT_REF ?? "divriwexbijtojjulqtu";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

function requireToken() {
  if (!TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN is required");
}

async function api(path, init = {}) {
  requireToken();
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`Supabase Management API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function project() {
  return api(`/projects/${PROJECT_REF}`);
}

async function inspect() {
  const config = await api(`/projects/${PROJECT_REF}/config/auth`);
  const oauthFields = Object.fromEntries(
    Object.entries(config).filter(([key]) => key.startsWith("oauth_server") || key === "site_url" || key === "uri_allow_list"),
  );
  console.log(JSON.stringify({ project_ref: PROJECT_REF, auth: oauthFields }, null, 2));
}

async function discovery() {
  const url = `https://${PROJECT_REF}.supabase.co/.well-known/oauth-authorization-server/auth/v1`;
  const response = await fetch(url);
  console.log(JSON.stringify({ status: response.status, ...(await response.json()) }, null, 2));
}

async function keys() {
  const result = await api(`/projects/${PROJECT_REF}/api-keys?reveal=true`);
  const rows = Array.isArray(result) ? result : (result.api_keys ?? []);
  const publicKeys = rows
    .filter((key) => ["anon", "publishable"].includes(key.name) || key.type === "publishable")
    .map((key) => ({ name: key.name, type: key.type, api_key: key.api_key }));
  console.log(JSON.stringify(publicKeys, null, 2));
}

async function applyMigration() {
  const file = join(ROOT, "supabase", "migrations", "202609180001_delegated_oauth_containment.sql");
  const sql = readFileSync(file, "utf8");
  const result = await api(`/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql }),
  });
  console.log(JSON.stringify({ applied: "202609180001_delegated_oauth_containment", result }, null, 2));
}

async function applyAudienceHook() {
  const file = join(ROOT, "supabase", "migrations", "20260919090000_oauth_mcp_audience_hook.sql");
  const sql = readFileSync(file, "utf8");
  const result = await api(`/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql }),
  });
  console.log(JSON.stringify({ applied: "20260919090000_oauth_mcp_audience_hook", result }, null, 2));
}

async function containmentStatus() {
  const query = `
    select
      (select count(*) from pg_policies
        where schemaname = 'public' and policyname = 'delegated_oauth_containment' and permissive = 'RESTRICTIVE') as restrictive_policies,
      (select count(*) from pg_policies
        where schemaname = 'public' and policyname = 'delegated_oauth_containment') as total_policies,
      (select count(*) from information_schema.role_table_grants
        where grantee = 'authenticated' and table_schema = 'public'
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE')) as authenticated_write_grants
  `;
  const result = await api(`/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseFlag(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value === undefined ? undefined : value.slice(prefix.length);
}

async function enableOAuth() {
  const authorizationPath = parseFlag("path");
  if (!authorizationPath || !authorizationPath.startsWith("https://")) {
    throw new Error("--path=https://<auth-ui>/oauth/consent is required");
  }
  if (parseFlag("hook-enabled") !== "true") {
    throw new Error("--hook-enabled=true is required after the dedicated-resource hook is enabled and verified");
  }
  const config = await api(`/projects/${PROJECT_REF}/config/auth`);
  const result = await api(`/projects/${PROJECT_REF}/config/auth`, {
    method: "PATCH",
    body: JSON.stringify({
      oauth_server_enabled: true,
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: authorizationPath,
      site_url: config.site_url,
      uri_allow_list: config.uri_allow_list,
    }),
  });
  const fields = Object.fromEntries(
    Object.entries(result).filter(([key]) => key.startsWith("oauth_server") || key === "site_url"),
  );
  console.log(JSON.stringify({ project_ref: PROJECT_REF, auth: fields }, null, 2));
}

async function disableOAuth() {
  const result = await api(`/projects/${PROJECT_REF}/config/auth`, {
    method: "PATCH",
    body: JSON.stringify({ oauth_server_enabled: false }),
  });
  console.log(JSON.stringify({ oauth_server_enabled: result.oauth_server_enabled }, null, 2));
}

const COMMANDS = {
  inspect,
  discovery,
  keys,
  "apply-migration": applyMigration,
  "apply-audience-hook": applyAudienceHook,
  "containment-status": containmentStatus,
  "enable-oauth": enableOAuth,
  "disable-oauth": disableOAuth,
};

async function main() {
  const command = process.argv[2];
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Usage: node scripts/oauth/supabase-management.mjs <${Object.keys(COMMANDS).join("|")}>`);
    process.exit(2);
  }
  if (command !== "discovery" && command !== "inspect") {
    const info = await project();
    console.error(`# project ${info.id} (${info.name}) status=${info.status}`);
  }
  await handler();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
