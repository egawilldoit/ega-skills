// Unit contract for the live membership authorizer used by unscoped hosted
// reads (EGA-718). The static authorization document still fixes the resource
// shape; membership comes from the live `workspace_memberships` read. Every
// failure mode fails closed.

import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseMembershipAuthorizer } from "../../packages/mcp/dist/index.js";

const serverSecret = "sb_secret_membership_fixture";
const WORKSPACE = "workspace-a";
const signal = new AbortController().signal;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiFetch(row = { workspace_id: WORKSPACE, subject: "user-a", role: "member", active: true }) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url);
    assert.equal(init.method, "GET");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("apikey"), serverSecret);
    assert.equal(headers.get("authorization"), null, "an opaque sb_secret_ key must not be sent as a bearer token");
    if (url.pathname.endsWith("/workspace_memberships")) {
      if (row === null) return json({ message: "unavailable" }, 503);
      if (row === "malformed") return json([{ nope: true }]);
      return json(Array.isArray(row) ? row : [row]);
    }
    return json([], 404);
  };
  return { fetchImpl, calls };
}

function authorizer(fetchImpl, overrides = {}) {
  return createSupabaseMembershipAuthorizer({
    supabaseUrl: "https://project.supabase.co",
    secretKey: serverSecret,
    fetch: fetchImpl,
    workspaceId: WORKSPACE,
    visibility: "workspace",
    ownerSubject: "owner-a",
    denied: false,
    ...overrides,
  });
}

test("live membership authorizer reads the active row and authorizes a member", async () => {
  const { fetchImpl, calls } = apiFetch();
  assert.equal(await authorizer(fetchImpl)("user-a", signal), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/rest/v1/workspace_memberships");
  assert.equal(calls[0].searchParams.get("select"), "workspace_id,subject,role,active");
  assert.equal(calls[0].searchParams.get("workspace_id"), `eq.${WORKSPACE}`);
  assert.equal(calls[0].searchParams.get("subject"), "eq.user-a");
  assert.equal(calls[0].searchParams.get("active"), "eq.true");
  assert.equal(calls[0].searchParams.get("limit"), "1");
});

test("live membership authorizer denies a revoked membership (no active row)", async () => {
  const { fetchImpl } = apiFetch([]);
  assert.equal(await authorizer(fetchImpl)("user-a", signal), false);
});

test("live membership authorizer denies an inactive row and for a mismatched workspace", async () => {
  assert.equal(await authorizer(apiFetch([{ workspace_id: WORKSPACE, subject: "user-a", role: "member", active: false }]).fetchImpl)("user-a", signal), false);
  assert.equal(await authorizer(apiFetch([{ workspace_id: "workspace-b", subject: "user-a", role: "member", active: true }]).fetchImpl)("user-a", signal), false);
  assert.equal(await authorizer(apiFetch([{ workspace_id: WORKSPACE, subject: "user-b", role: "member", active: true }]).fetchImpl)("user-a", signal), false);
});

test("live membership authorizer fails closed on unknown roles, malformed rows, duplicates, and lookup errors", async () => {
  assert.equal(await authorizer(apiFetch([{ workspace_id: WORKSPACE, subject: "user-a", role: "root", active: true }]).fetchImpl)("user-a", signal), false);
  assert.equal(await authorizer(apiFetch("malformed").fetchImpl)("user-a", signal), false);
  assert.equal(await authorizer(apiFetch([
    { workspace_id: WORKSPACE, subject: "user-a", role: "member", active: true },
    { workspace_id: WORKSPACE, subject: "user-a", role: "viewer", active: true },
  ]).fetchImpl)("user-a", signal), false);
  assert.equal(await authorizer(apiFetch(null).fetchImpl)("user-a", signal), false);
  assert.equal(await authorizer(apiFetch([]).fetchImpl)("", signal), false);
});

test("live membership authorizer honors public visibility, explicit private grants, and static denies", async () => {
  assert.equal(await authorizer(apiFetch([]).fetchImpl, { visibility: "public" })("passer-by", signal), true);
  const member = [{ workspace_id: WORKSPACE, subject: "user-a", role: "member", active: true }];
  assert.equal(await authorizer(apiFetch(member).fetchImpl, { visibility: "private" })("user-a", signal), false);
  assert.equal(
    await authorizer(apiFetch(member).fetchImpl, { visibility: "private", authorizedSubjects: ["user-a"] })("user-a", signal),
    true,
  );
  assert.equal(await authorizer(apiFetch([]).fetchImpl, { visibility: "private" })("outsider", signal), false);
  const denied = apiFetch([]);
  assert.equal(await authorizer(denied.fetchImpl, { denied: true })("owner-a", signal), false);
  assert.equal(denied.calls.length, 0, "a static deny must not reach the live store");
});
