/**
 * Analytics availability and window semantics (CONTRACT-T1 §8, and the brief's
 * "a failure must never become zero").
 *
 * Every case drives the REAL handler through the real `ControlPlaneReader`
 * seam. A source-text check cannot observe what the handler does with a rejected
 * read, and cannot prove that 250 events aggregate correctly rather than the
 * first 100 of them.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { handleAnalyticsUsage } from "../../apps/web/server/governance.ts";
import { ConsoleApiError } from "../../apps/web/server/api.ts";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const NOW = Date.now();

const CALLER = Object.freeze({ subject: "owner", workspaceIds: Object.freeze([WORKSPACE]) });

function query(extra = "") {
  return new URLSearchParams(`workspace_id=${WORKSPACE}${extra}`);
}

const context = (extra) => ({ query: query(extra) });

/**
 * A reader that serves the tables it is given and FAILS loudly for the rest.
 *
 * The failure modes are the point: a handler that swallows them into `[]` will
 * report zero, and that is exactly the defect under test.
 */
function readerWith({ telemetry, quotaUsage = [], policy = [], failures = {} }) {
  return {
    resolveCaller: async () => CALLER,
    describeAvailability: () => "fixture",
    async readAsCaller(_caller, table) {
      if (failures[table]) throw failures[table];
      if (table === "mcp_tool_executions") return telemetry;
      if (table === "quota_usage") return quotaUsage;
      if (table === "quota_policies") return policy;
      return [];
    },
  };
}

function telemetryRow(overrides = {}) {
  return {
    tool: "search",
    result_class: "success",
    latency_ms: 10,
    observed_at: new Date(NOW - 1000).toISOString(),
    ...overrides,
  };
}

describe("more than one page of executions aggregates completely", () => {
  test("250 executions produce 250, not the 100-row page ceiling", async () => {
    // The defect: `limit: 100` with no window, then a client-side sum. The
    // reported "total" described whichever rows sorted first.
    const telemetry = Array.from({ length: 250 }, (_, i) =>
      telemetryRow({ execution_id: `e${i}`, latency_ms: 20 }),
    );
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));

    assert.equal(summary.telemetry?.total_executions, 250, "every authorized execution must count");
    assert.equal(summary.telemetry?.funnel.searched, 250);
    assert.equal(summary.telemetry?.average_latency_ms, 20);
  });

  test("counts per tool and result class are separated", async () => {
    const telemetry = [
      ...Array.from({ length: 10 }, (_, i) => telemetryRow({ tool: "search", execution_id: `s${i}` })),
      ...Array.from({ length: 5 }, (_, i) => telemetryRow({ tool: "inspect", execution_id: `i${i}` })),
      telemetryRow({ tool: "search", result_class: "denied", execution_id: "d1" }),
      telemetryRow({ tool: "search", result_class: "rate_limited", execution_id: "r1" }),
    ];
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));
    const t = summary.telemetry;

    assert.equal(t?.by_tool_search, undefined);
    assert.equal(t?.tools.search, 12, "all search executions, including denied and rate-limited");
    assert.equal(t?.success_count, 15);
    assert.equal(t?.error_count, 2);
    // Denied and rate-limited ran the tool but produced no result, so they must
    // not advance a funnel whose steps never happened.
    assert.equal(t?.funnel.searched, 10, "only successful searches advance the funnel");
  });
});

describe("events outside the window do not contribute", () => {
  test("a row older than the window is excluded", async () => {
    const telemetry = [
      telemetryRow({ execution_id: "recent" }),
      telemetryRow({
        execution_id: "ancient",
        observed_at: new Date(NOW - 200 * 86_400_000).toISOString(),
      }),
    ];
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));
    assert.equal(summary.telemetry?.total_executions, 1, "the 200-day-old row is outside the window");
  });

  test("the window is stated in the response and is a real 90 days", async () => {
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry: [] }));
    const started = Date.parse(summary.window_started);
    const ends = Date.parse(summary.window_ends_at);
    assert.ok(Number.isFinite(started) && Number.isFinite(ends));
    const days = (ends - started) / 86_400_000;
    assert.ok(Math.abs(days - 90) < 0.01, `expected a 90-day window, got ${days}`);
    assert.equal(summary.telemetry?.window_started, summary.window_started);
  });
});

describe("a database failure is never reported as zero", () => {
  test("a missing telemetry table surfaces as an error, not an empty summary", async () => {
    const reader = readerWith({
      telemetry: [],
      failures: { mcp_tool_executions: new ConsoleApiError(503, "E_WEB_UPSTREAM_UNAVAILABLE", "relation does not exist") },
    });
    await assert.rejects(
      handleAnalyticsUsage(context(), CALLER, reader),
      (error) => {
        assert.ok(error instanceof ConsoleApiError);
        assert.equal(error.status, 503);
        // The message must name what failed; a bare "unavailable" would be
        // indistinguishable from telemetry being switched off.
        assert.match(error.message, /telemetry/i);
        return true;
      },
    );
  });

  test("a forbidden quota read is preserved as 403, not flattened", async () => {
    const reader = readerWith({
      telemetry: [],
      failures: { quota_usage: new ConsoleApiError(403, "E_WEB_CONTROL_PLANE_FORBIDDEN", "forbidden") },
    });
    await assert.rejects(handleAnalyticsUsage(context(), CALLER, reader), (error) => {
      assert.equal(error.status, 403, "a denied read must not become a 200 with zeros");
      return true;
    });
  });

  test("a non-typed upstream failure becomes 503", async () => {
    const reader = readerWith({
      telemetry: [],
      failures: { mcp_tool_executions: new TypeError("socket hang up") },
    });
    await assert.rejects(handleAnalyticsUsage(context(), CALLER, reader), (error) => {
      assert.equal(error.status, 503);
      // The raw transport message must not be echoed to the browser.
      assert.equal(error.message.includes("socket hang up"), false);
      return true;
    });
  });

  test("a genuinely empty window is a real zero with a stated reason", async () => {
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry: [] }));
    assert.equal(summary.telemetry?.total_executions, 0);
    assert.match(summary.telemetry?.telemetry_unavailable_reason ?? "", /genuine zero/i);
    assert.match(summary.windows_unavailable_reason ?? "", /quota_usage/);
  });
});

describe("the query is bounded", () => {
  test("a missing workspace_id is a 400", async () => {
    await assert.rejects(
      handleAnalyticsUsage({ query: new URLSearchParams("") }, CALLER, readerWith({ telemetry: [] })),
      (error) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
  });

  test("the telemetry read asks for a window and a bounded page", async () => {
    const calls = [];
    const reader = {
      resolveCaller: async () => CALLER,
      describeAvailability: () => "fixture",
      async readAsCaller(_c, table, options) {
        calls.push({ table, options });
        return table === "mcp_tool_executions" ? [telemetryRow()] : [];
      },
    };
    await handleAnalyticsUsage(context(), CALLER, reader);
    const telemetryCall = calls.find((c) => c.table === "mcp_tool_executions");
    assert.ok(telemetryCall?.options.ranges, "the window must be pushed into the query");
    assert.ok(telemetryCall.options.limit > 100, "the ceiling must exceed the old 100-row page");
    assert.ok((telemetryCall.options.columns ?? []).length < 20, "aggregate read must not fetch raw rows wholesale");
  });
});