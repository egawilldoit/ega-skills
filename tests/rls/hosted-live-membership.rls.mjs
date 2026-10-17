// EGA-718 regression — unscoped hosted `search` must authorize against the
// LIVE workspace membership store, not only the static authorization document.
//
// This suite runs only against a disposable PostgreSQL database whose URL is
// provided via EGA_RLS_DATABASE_URL (same contract as Contract F). It creates
// a uniquely named database, applies supabase/migrations in order, seeds one
// workspace with two active members, and drops the database afterwards. It
// never touches a remote or production instance.
//
// The Supabase REST transport is adapted to the isolated database: the hosted
// runtime still performs its real authorization decision and its real
// `workspace_memberships` read (shape-identical row), while the bytes travel
// through `psql` instead of a network connection. A membership revocation is a
// real SQL update of `public.workspace_memberships`.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createSign } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import { createHostedRuntimeFromEnv } from "../../packages/mcp/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) {
  throw new Error("EGA_RLS_DATABASE_URL is required to run the EGA-718 live membership suite");
}
const DB_NAME = `ega_718_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const DB_URL = withDatabase(BASE_URL, DB_NAME);
const ADMIN_URL = withDatabase(BASE_URL, "postgres");

const WORKSPACE = "00000000-0000-4000-8000-0000000000c1";
const AS = "https://ega718.supabase.co/auth/v1";
const RESOURCE = "https://mcp.ega718.test/mcp";
const SUPABASE = "https://ega718.supabase.co";

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function psql(url, sql) {
  return execFileSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", url],
    { encoding: "utf8", input: sql, stdio: ["pipe", "pipe", "pipe"] },
  );
}

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-718-hub-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha live-membership skill.\n---\n\nUse alpha for EGA-718.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: ega-718\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "ega718-k1", kty: "EC", alg: "ES256", use: "sig", key_ops: ["verify"] };

function es256Mint(subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", kid: "ega718-k1", typ: "JWT" });
  const body = encode({ iss: AS, aud: RESOURCE, sub: subject, scope: "openid", exp: now + 300, nbf: now - 5 });
  const signer = createSign("SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** Shape-identical read of the live membership row for one subject. */
function queryMemberships(url) {
  assert.equal(url.pathname, "/rest/v1/workspace_memberships");
  assert.equal(url.searchParams.get("select"), "workspace_id,subject,role,active");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(url.searchParams.get("active"), "eq.true");
  const workspace = url.searchParams.get("workspace_id")?.replace(/^eq\./, "");
  const subject = url.searchParams.get("subject")?.replace(/^eq\./, "");
  assert.ok(workspace && subject, "live membership read must be scoped to workspace and subject");
  const quote = (value) => value.replaceAll("'", "''");
  const sql = `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
    select workspace_id, subject, role, active from public.workspace_memberships
    where workspace_id = '${quote(workspace)}'::uuid and subject = '${quote(subject)}' and active = true
    limit 1
  ) t;`;
  return JSON.parse(psql(DB_URL, sql));
}

const fetchState = { membershipQueries: 0, membershipFailure: false, unexpected: [] };

function installFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      return new Response(JSON.stringify({ keys: [JWK] }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/rest/v1/workspace_memberships") {
      fetchState.membershipQueries += 1;
      if (fetchState.membershipFailure) {
        return new Response(JSON.stringify({ message: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(queryMemberships(url)), { headers: { "content-type": "application/json" } });
    }
    fetchState.unexpected.push(url.toString());
    throw new Error(`unexpected live store request: ${url.pathname}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

const BUILD = await buildHubRelease(makeHub());

function policy(overrides = {}) {
  return JSON.stringify({
    workspace_id: WORKSPACE,
    visibility: "workspace",
    owner_subject: "owner-1",
    memberships: [
      { subject: "owner-1", role: "owner", active: true },
      { subject: "user-a", role: "member", active: true },
      { subject: "user-b", role: "member", active: true },
    ],
    denies: [],
    ...overrides,
  });
}

function env(overrides = {}) {
  return {
    EGA_HOSTED_ARTIFACT_DIR: BUILD.registryHome,
    EGA_HOSTED_AUTHZ_JSON: policy(),
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    EGA_HOSTED_ISSUER: AS,
    EGA_HOSTED_AUDIENCE: RESOURCE,
    EGA_HOSTED_JWKS_URL: `${AS}/.well-known/jwks.json`,
    EGA_HOSTED_RESOURCE_URL: RESOURCE,
    EGA_HOSTED_AUTHORIZATION_SERVERS: AS,
    EGA_HOSTED_SUPABASE_URL: SUPABASE,
    EGA_HOSTED_SUPABASE_SECRET_KEY: "sb_secret_ega718_live_membership_fixture",
    ...overrides,
  };
}

async function search(runtime, subject, id = 1) {
  const response = await runtime.handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${es256Mint(subject)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "http://localhost",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search", arguments: { query: "alpha", limit: 5 } },
    }),
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text);
}

function allowed(result) {
  assert.doesNotMatch(JSON.stringify(result), /"isError":true/);
  assert.match(JSON.stringify(result), /ega\/alpha/);
}

function denied(result) {
  assert.match(JSON.stringify(result), /E_UNAUTHORIZED/);
}

before(() => {
  psql(ADMIN_URL, `create database "${DB_NAME}"`);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));
  const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    psql(DB_URL, readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"));
  }
  psql(DB_URL, `
    insert into public.personal_workspaces (id, owner_subject) values ('${WORKSPACE}', 'owner-1');
    insert into public.workspace_memberships (workspace_id, subject, role, active) values
      ('${WORKSPACE}', 'owner-1', 'owner', true),
      ('${WORKSPACE}', 'user-a', 'member', true),
      ('${WORKSPACE}', 'user-b', 'member', true);
  `);
});

after(() => {
  psql(ADMIN_URL, `drop database if exists "${DB_NAME}" with (force)`);
});

test("EGA-718: a real membership revoke denies the identical still-valid token; a second member still searches", async (t) => {
  const restore = installFetch();
  t.after(restore);
  fetchState.membershipQueries = 0;
  fetchState.membershipFailure = false;
  fetchState.unexpected = [];

  const runtime = createHostedRuntimeFromEnv(env());

  // Baseline: the live member can search through the real hosted handler.
  allowed(await search(runtime, "user-a", 1));

  // REAL revocation: the DB row stays, but membership becomes inactive.
  psql(DB_URL, `update public.workspace_memberships set active = false where workspace_id = '${WORKSPACE}' and subject = 'user-a';`);
  assert.equal(
    psql(DB_URL, `select active from public.workspace_memberships where workspace_id = '${WORKSPACE}' and subject = 'user-a';`).trim(),
    "f",
    "revocation must be persisted in the isolated database",
  );

  // The identical still-valid token is denied without minting a new one.
  denied(await search(runtime, "user-a", 2));
  assert.ok(fetchState.membershipQueries > 0, "unscoped search must consult the live membership store");

  // A second legitimate member is unaffected.
  allowed(await search(runtime, "user-b", 3));
  assert.deepEqual(fetchState.unexpected, [], "no request may leave the configured live store surface");
});

test("EGA-718: unscoped search fails closed when the live membership lookup errors", async (t) => {
  const restore = installFetch();
  t.after(restore);
  fetchState.membershipQueries = 0;
  fetchState.membershipFailure = true;
  fetchState.unexpected = [];

  const runtime = createHostedRuntimeFromEnv(env());
  denied(await search(runtime, "user-b", 1));
  assert.ok(fetchState.membershipQueries > 0);
});

test("EGA-718: a public hub keeps policy-authorized reads without a live membership row", async (t) => {
  const restore = installFetch();
  t.after(restore);
  fetchState.membershipQueries = 0;
  fetchState.membershipFailure = false;
  fetchState.unexpected = [];

  const runtime = createHostedRuntimeFromEnv(env({
    EGA_HOSTED_AUTHZ_JSON: policy({ visibility: "public" }),
  }));
  allowed(await search(runtime, "passer-by", 1));
  assert.ok(fetchState.membershipQueries > 0);
});

test("EGA-718: without a live store the static policy remains authoritative", async (t) => {
  const restore = installFetch();
  t.after(restore);
  fetchState.membershipQueries = 0;
  fetchState.membershipFailure = false;
  fetchState.unexpected = [];

  const runtime = createHostedRuntimeFromEnv(env({
    EGA_HOSTED_SUPABASE_URL: undefined,
    EGA_HOSTED_SUPABASE_SECRET_KEY: undefined,
  }));
  allowed(await search(runtime, "user-a", 1));
  assert.equal(fetchState.membershipQueries, 0, "static mode must not consult a live store");
});
