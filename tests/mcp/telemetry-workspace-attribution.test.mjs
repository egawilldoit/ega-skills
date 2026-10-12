/**
 * Telemetry workspace attribution (CONTRACT-T1 §3.1, §5).
 *
 * Every case drives the real `createSupabaseWorkspaceResolver` against a fake
 * PostgREST transport that serves real rows, so the chain — and each refusal on
 * it — is exercised rather than described.
 *
 * The property under test is that a persisted event carries the workspace the
 * SERVER verified, and that it is never fabricated, never borrowed from another
 * member, and never derived from a caller-supplied value.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";

import { createSupabaseWorkspaceResolver } from "../../packages/mcp/dist/index.js";

const WS_A = "aaaaaaaa-0000-4000-8000-000000000001";
const WS_B = "bbbbbbbb-0000-4000-8000-000000000002";
const PROJECT_A = "cccccccc-0000-4000-8000-000000000003";
const CONTEXT_A = "dddddddd-0000-4000-8000-000000000004";
const HUB_A = "eeeeeeee-0000-4000-8000-000000000005";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

const principal = (subject) => ({ subject, scopes: [] });
const signal = () => new AbortController().signal;

/**
 * A PostgREST stand-in over a fixed table set.
 *
 * Understands only `select`, `limit`, and `eq.<value>` on one column, which is
 * everything the resolver issues. A filter on a table with no rows returns `[]`,
 * so "not found" and "not readable" are the same empty answer the real gateway
 * gives.
 */
function resolverOver(tables, { status = 200 } = {}) {
  const calls = [];
  const resolver = createSupabaseWorkspaceResolver({
    supabaseUrl: "https://project.supabase.co",
    secretKey: "sb_secret_test",
    fetch: async (url) => {
      const parsed = new URL(url);
      const table = parsed.pathname.replace("/rest/v1/", "");
      calls.push({ table, params: Object.fromEntries(parsed.searchParams) });

      if (status !== 200) throw new Error(`gateway ${status}`);
      const eqColumn = Object.keys(parsed.searchParams).find((k) => k !== "select" && k !== "limit");
      const wanted = eqColumn ? parsed.searchParams.get(eqColumn).replace(/^eq\./, "") : undefined;
      const rows = tables[table] ?? [];
      const filtered = eqColumn ? rows.filter((row) => String(row[eqColumn]) === wanted) : rows;
      const limit = Number(parsed.searchParams.get("limit") ?? "50");
      return {
        ok: true,
        status: 200,
        json: async () => filtered.slice(0, limit),
        text: async () => JSON.stringify(filtered.slice(0, limit)),
      };
    },
  });
  return { resolver, calls };
}

describe("context-bound attribution", () => {
  const tables = {
    project_contexts: [{ id: CONTEXT_A, project_id: PROJECT_A, revoked_at: null }],
    projects: [{ id: PROJECT_A, workspace_id: WS_A }],
    workspace_memberships: [{ workspace_id: WS_A, subject: "alice", active: true }],
  };

  test("resolves the workspace that owns an authorized context", async () => {
    const { resolver } = resolverOver(tables);
    const workspace = await resolver(
      principal("alice"),
      { contextId: CONTEXT_A },
      signal(),
    );
    assert.equal(workspace, WS_A, "the context's project's workspace is the attributable one");
  });

  test("a non-member gets no attribution even for an existing context", async () => {
    const { resolver } = resolverOver(tables);
    // Mallory can read the row but is not an active member of workspace A.
    const workspace = await resolver(principal("mallory"), { contextId: CONTEXT_A }, signal());
    assert.equal(workspace, null, "readability of the row is not membership");
  });

  test("a revoked context attributes nothing", async () => {
    const { resolver } = resolverOver({
      ...tables,
      project_contexts: [{ id: CONTEXT_A, project_id: PROJECT_A, revoked_at: "2026-01-01T00:00:00Z" }],
    });
    assert.equal(await resolver(principal("alice"), { contextId: CONTEXT_A }, signal()), null);
  });

  test("a missing context or project attributes nothing", async () => {
    const { resolver } = resolverOver({ ...tables, project_contexts: [] });
    assert.equal(await resolver(principal("alice"), { contextId: CONTEXT_A }, signal()), null);

    const orphan = resolverOver({ ...tables, projects: [] });
    assert.equal(await orphan.resolver(principal("alice"), { contextId: CONTEXT_A }, signal()), null);
  });

  test("an inactive membership attributes nothing", async () => {
    const { resolver } = resolverOver({
      ...tables,
      workspace_memberships: [{ workspace_id: WS_A, subject: "alice", active: false }],
    });
    assert.equal(await resolver(principal("alice"), { contextId: CONTEXT_A }, signal()), null);
  });
});

describe("context-free (release-bound) attribution", () => {
  // The defect this covers: a normal Hub/release call carries no context_id, and
  // the previous resolver returned null, so ordinary executions were never
  // attributed at all.
  const tables = {
    hub_releases: [{ hub_id: HUB_A, release_digest: DIGEST }],
    hubs: [{ id: HUB_A, workspace_id: WS_A }],
    workspace_memberships: [
      { workspace_id: WS_A, subject: "alice", active: true },
      { workspace_id: WS_B, subject: "bob", active: true },
    ],
  };

  test("a release-bound call resolves through hub -> workspace", async () => {
    const { resolver, calls } = resolverOver(tables);
    const workspace = await resolver(principal("alice"), { releaseDigest: DIGEST }, signal());
    assert.equal(workspace, WS_A, "the hub's workspace is the attributable one");
    assert.ok(calls.some((c) => c.table === "hub_releases"), "must resolve the release");
    assert.ok(calls.some((c) => c.table === "hubs"), "then the hub");
  });

  test("each member gets their OWN workspace, never another's", async () => {
    // Multiple memberships: the release names one hub, and only the member of
    // that hub's workspace may attribute to it.
    const multi = resolverOver({
      ...tables,
      hubs: [
        { id: HUB_A, workspace_id: WS_A },
        { id: "ffffffff-0000-4000-8000-000000000009", workspace_id: WS_B },
      ],
    });
    assert.equal(await multi.resolver(principal("alice"), { releaseDigest: DIGEST }, signal()), WS_A);
    assert.equal(
      await multi.resolver(principal("bob"), { releaseDigest: DIGEST }, signal()),
      null,
      "bob is not a member of workspace A, which owns that hub",
    );
  });

  test("a subject who is a member of a different workspace gets nothing", async () => {
    const { resolver } = resolverOver(tables);
    assert.equal(await resolver(principal("bob"), { releaseDigest: DIGEST }, signal()), null);
  });

  test("a release the caller cannot read attributes nothing", async () => {
    const { resolver } = resolverOver({ ...tables, hub_releases: [] });
    assert.equal(await resolver(principal("alice"), { releaseDigest: DIGEST }, signal()), null);
  });

  test("a malformed digest is never used as a filter value", async () => {
    const { resolver, calls } = resolverOver(tables);
    assert.equal(await resolver(principal("alice"), { releaseDigest: "not-a-digest" }, signal()), null);
    assert.equal(
      calls.some((c) => c.table === "hub_releases"),
      false,
      "a malformed digest must not reach the database at all",
    );
  });

  test("neither context nor digest attributes nothing rather than guessing", async () => {
    // The stable-pointer path names no hub, so there is nothing verified to
    // attribute to. Guessing here is how a zero-UUID gets invented.
    const { resolver } = resolverOver(tables);
    assert.equal(await resolver(principal("alice"), {}, signal()), null);
  });

  test("a public hub read by a non-member attributes nothing", async () => {
    // `hubs.visibility = 'public'` lets anyone READ the hub. Attributing such a
    // read to the OWNING workspace would disclose that ownership to someone who
    // is not a member, so it is deliberately unattributed.
    const { resolver } = resolverOver({
      ...tables,
      hubs: [{ id: HUB_A, workspace_id: WS_A, visibility: "public" }],
      workspace_memberships: [{ workspace_id: WS_A, subject: "owner", active: true }],
    });
    assert.equal(await resolver(principal("visitor"), { releaseDigest: DIGEST }, signal()), null);
    // The owner of a public hub is still attributed.
    assert.equal(await resolver(principal("owner"), { releaseDigest: DIGEST }, signal()), WS_A);
  });
});

describe("failures never leak or fabricate", () => {
  test("a gateway failure returns null rather than throwing", async () => {
    // The resolver runs AFTER the tool result is produced. Throwing here would
    // turn a successful tool call into an error.
    const { resolver } = resolverOver({}, { status: 500 });
    assert.equal(await resolver(principal("alice"), { releaseDigest: DIGEST }, signal()), null);
  });

  test("an already-aborted signal attributes nothing without querying", async () => {
    const { resolver, calls } = resolverOver({
      hub_releases: [{ hub_id: HUB_A, release_digest: DIGEST }],
      hubs: [{ id: HUB_A, workspace_id: WS_A }],
      workspace_memberships: [{ workspace_id: WS_A, subject: "alice", active: true }],
    });
    const controller = new AbortController();
    controller.abort();
    assert.equal(await resolver(principal("alice"), { releaseDigest: DIGEST }, controller.signal), null);
    assert.equal(calls.length, 0, "an aborted request must not issue queries");
  });

  test("an empty subject attributes nothing", async () => {
    const { resolver } = resolverOver({
      hub_releases: [{ hub_id: HUB_A, release_digest: DIGEST }],
      hubs: [{ id: HUB_A, workspace_id: WS_A }],
    });
    assert.equal(await resolver({ subject: "", scopes: [] }, { releaseDigest: DIGEST }, signal()), null);
  });

  test("no resolver ever returns a fabricated UUID", async () => {
    // Sweep every refusal path and assert none of them produced the zero UUID,
    // which the previous instrumentation used as a fallback.
    const zero = "00000000-0000-0000-0000-000000000000";
    const { resolver } = resolverOver({});
    for (const request of [
      {},
      { contextId: CONTEXT_A },
      { releaseDigest: DIGEST },
      { contextId: "", releaseDigest: "" },
      { contextId: "x", releaseDigest: "y" },
    ]) {
      const workspace = await resolver(principal("alice"), request, signal());
      assert.notEqual(workspace, zero, `request ${JSON.stringify(request)} must not fabricate a UUID`);
    }
    assert.equal(randomUUID() !== zero, true);
  });
});