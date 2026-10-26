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

import { handleAnalyticsUsage, utcDateBucket, MAX_DAILY_BUCKETS } from "../../apps/web/server/governance.ts";
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
function readerWith({ telemetry, quotaUsage = [], policy = [], failures = {}, maxRows = Infinity }) {
  let served = 0;
  return {
    resolveCaller: async () => CALLER,
    describeAvailability: () => "fixture",
    async readAsCaller(_caller, table, options = {}) {
      if (failures[table]) throw failures[table];
      if (table === "mcp_tool_executions") {
        // Honour limit AND offset so the aggregate's pagination is genuinely
        // exercised. `maxRows` models a gateway that caps pages BELOW the
        // requested size — the case where a short page does not mean "end of
        // range" and the scan must keep going.
        const requested = options.limit ?? 50;
        const effective = Math.min(requested, maxRows);
        const offset = options.offset ?? 0;
        served += 1;
        return telemetry.slice(offset, offset + effective);
      }
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

describe("pagination is complete and honestly reported", () => {
  test("more than one page aggregates to the true total", async () => {
    const telemetry = Array.from({ length: 250 }, (_, i) => telemetryRow({ execution_id: `e${i}` }));
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));
    assert.equal(summary.telemetry?.total_executions, 250);
    assert.equal(summary.telemetry?.partial, false, "a fully drained scan is complete");
    assert.equal(summary.telemetry?.rows_scanned, 250);
  });

  test("a gateway capping pages below the requested size is still enumerated", async () => {
    // PostgREST deployments set max-rows; a page can come back shorter than
    // asked for WITHOUT that meaning "end of range". Enumerating until a page
    // is genuinely empty is what makes the total correct here.
    const telemetry = Array.from({ length: 300 }, (_, i) => telemetryRow({ execution_id: `e${i}` }));
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry, maxRows: 50 }));
    assert.equal(summary.telemetry?.total_executions, 300, "a short page is not the end of the window");
    assert.equal(summary.telemetry?.partial, false);
  });

  test("reaching the scan ceiling reports partial coverage rather than a total", async () => {
    const telemetry = Array.from({ length: 60_000 }, (_, i) => telemetryRow({ execution_id: `e${i}` }));
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));
    assert.equal(summary.telemetry?.partial, true, "an exhausted scan must not claim completeness");
    assert.ok(
      summary.telemetry?.rows_scanned <= 50_000,
      "the safety ceiling must hold",
    );
  });

  test("cross-workspace rows are excluded by the query scope", async () => {
    const telemetry = [
      telemetryRow({ execution_id: "mine" }),
      telemetryRow({ execution_id: "theirs", observed_at: new Date(NOW - 1000).toISOString() }),
    ];
    // The workspace filter is part of the query, so a compliant reader returns
    // only this workspace's rows; the handler must not widen it client-side.
    const seen = [];
    const reader = {
      resolveCaller: async () => CALLER,
      describeAvailability: () => "fixture",
      async readAsCaller(_c, table, options) {
        if (table === "mcp_tool_executions") {
          seen.push(options.filters);
          const mine = telemetry.filter((row) => row.execution_id === "mine");
          const offset = options.offset ?? 0;
          return mine.slice(offset, offset + (options.limit ?? 50));
        }
        return [];
      },
    };
    const summary = await handleAnalyticsUsage(context(), CALLER, reader);
    assert.equal(summary.telemetry?.total_executions, 1);
    assert.equal(seen.every((f) => f.some((x) => x.column === "workspace_id")), true);
  });

  test("a failure on a LATER page propagates rather than looking like the end", async () => {
    // The dangerous case: if a mid-scan failure were folded into a short page it
    // would be indistinguishable from exhaustion, turning an outage into a zero.
    const telemetry = Array.from({ length: 400 }, (_, i) => telemetryRow({ execution_id: `e${i}` }));
    let served = 0;
    const reader = {
      resolveCaller: async () => CALLER,
      describeAvailability: () => "fixture",
      async readAsCaller(_c, table, options = {}) {
        if (table !== "mcp_tool_executions") return [];
        const limit = options.limit ?? 200;
        if (served >= 200) throw new ConsoleApiError(503, "E_WEB_UPSTREAM_UNAVAILABLE", "gateway died");
        const page = telemetry.slice(served, served + limit);
        served += page.length;
        return page;
      },
    };
    await assert.rejects(handleAnalyticsUsage(context(), CALLER, reader), (error) => {
      assert.equal(error.status, 503);
      return true;
    });
  });

  test("boundary timestamps at the window edges are included", async () => {
    // Rows are built from the window the QUERY ITSELF carries (`ranges.gte` /
    // `lte`), so the boundaries are always exactly the bounds under test.
    //
    // This replaced a version that pinned `Date.now` and derived rows from the
    // FIRST call's response. Pinning was ineffective: the handler builds its
    // window with `new Date()`, which Node does not route through `Date.now`, so
    // the second call's window had genuinely advanced and a row on the first
    // window's start sat just outside it. That failure was intermittent, which
    // is exactly the kind that must not be papered over.
    let served = false;
    const reader = {
      resolveCaller: async () => CALLER,
      describeAvailability: () => "fixture",
      async readAsCaller(_caller, table, options = {}) {
        if (table !== "mcp_tool_executions") return [];
        const range = (options.ranges ?? []).find((r) => r.column === "observed_at");
        if (!range?.gte || !range.lte) return [];
        const gte = Date.parse(range.gte);
        const lte = Date.parse(range.lte);
        // One page only. A stub that returns the same rows on every request makes
        // the paginating scan count them repeatedly — 33334 here, not 2.
        if (served) return [];
        served = true;
        return [
          telemetryRow({ execution_id: "at-start", observed_at: new Date(gte).toISOString() }),
          telemetryRow({ execution_id: "at-end", observed_at: new Date(lte).toISOString() }),
          telemetryRow({
            execution_id: "just-before",
            observed_at: new Date(gte - 1).toISOString(),
          }),
        ];
      },
    };

    const summary = await handleAnalyticsUsage(context(), CALLER, reader);

    assert.equal(
      summary.telemetry?.total_executions,
      2,
      "both bounds are inclusive, one ms earlier is out",
    );
    assert.equal(
      summary.window_started,
      new Date(Date.parse(summary.window_started)).toISOString(),
      "the reported start must be an exact instant",
    );
    const days = (Date.parse(summary.window_ends_at) - Date.parse(summary.window_started)) / 86_400_000;
    assert.ok(Math.abs(days - 90) < 0.01, `expected a 90-day window, got ${days}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Daily execution counts (EGA-727)                                            */
/* -------------------------------------------------------------------------- */

describe("daily MCP execution counts (EGA-727)", () => {
  const DAY = 86_400_000;
  const atDaysAgo = (days) => new Date(NOW - days * DAY).toISOString();

  test("the response always carries a daily array, and it sums to total_executions", async () => {
    const telemetry = [
      telemetryRow({ execution_id: "a", observed_at: atDaysAgo(2) }),
      telemetryRow({ execution_id: "b", observed_at: atDaysAgo(2) }),
      telemetryRow({ execution_id: "c", observed_at: atDaysAgo(1) }),
      telemetryRow({ execution_id: "d", observed_at: atDaysAgo(0) }),
      telemetryRow({ execution_id: "e", observed_at: atDaysAgo(0) }),
      telemetryRow({ execution_id: "f", observed_at: atDaysAgo(0) }),
    ];
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));
    const daily = summary.telemetry.daily;

    assert.ok(Array.isArray(daily), "the daily series must always be an array");
    // Ascending by date, one bucket per UTC day, correct per-day sums.
    assert.deepEqual(
      daily.map((bucket) => bucket.date),
      [utcDateBucket(atDaysAgo(2)), utcDateBucket(atDaysAgo(1)), utcDateBucket(atDaysAgo(0))],
    );
    assert.deepEqual(
      daily.map((bucket) => bucket.executions),
      [2, 1, 3],
    );
    // The chart's points are the authorized daily sums: they must reconcile with
    // the headline total rather than being a second, drifting computation.
    assert.equal(
      daily.reduce((sum, bucket) => sum + bucket.executions, 0),
      summary.telemetry.total_executions,
    );
  });

  test("two instants on the same UTC date collapse into one bucket", async () => {
    // Anchored to a fixed UTC midnight two days back so the times are always in
    // the past and inside the window, and always on the same calendar day.
    const anchor = new Date(NOW - 2 * DAY);
    anchor.setUTCHours(0, 0, 0, 0);
    const telemetry = [
      telemetryRow({
        execution_id: "am",
        observed_at: new Date(anchor.getTime() + 3_600_000).toISOString(),
      }),
      telemetryRow({
        execution_id: "pm",
        observed_at: new Date(anchor.getTime() + 20 * 3_600_000).toISOString(),
      }),
    ];
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));

    assert.equal(summary.telemetry.daily.length, 1, "same UTC date must be one bucket");
    assert.equal(summary.telemetry.daily[0].date, utcDateBucket(anchor.toISOString()));
    assert.equal(summary.telemetry.daily[0].executions, 2);
  });

  test("a row older than the window creates no bucket, so it cannot inflate a day", async () => {
    const telemetry = [
      telemetryRow({ execution_id: "recent" }),
      telemetryRow({ execution_id: "ancient", observed_at: atDaysAgo(200) }),
    ];
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));

    assert.equal(summary.telemetry.daily.length, 1);
    assert.equal(summary.telemetry.daily[0].date, utcDateBucket(atDaysAgo(0)));
    assert.ok(
      !summary.telemetry.daily.some((bucket) => bucket.date === utcDateBucket(atDaysAgo(200))),
      "an out-of-window execution must not appear as a day",
    );
  });

  test("an unrelated workspace's event is excluded by the query scope", async () => {
    // RLS filters rows by the caller's workspace. The fixture models that by
    // returning only this workspace's rows, and the assertion below pins the
    // workspace filter so a handler that dropped it would fail here.
    const seenFilters = [];
    const reader = {
      resolveCaller: async () => CALLER,
      describeAvailability: () => "fixture",
      async readAsCaller(_caller, table, options = {}) {
        if (table !== "mcp_tool_executions") return [];
        seenFilters.push(options.filters);
        const mine = [telemetryRow({ execution_id: "mine", observed_at: atDaysAgo(1) })];
        const offset = options.offset ?? 0;
        return mine.slice(offset, offset + (options.limit ?? 50));
      },
    };
    const summary = await handleAnalyticsUsage(context(), CALLER, reader);
    const otherDay = utcDateBucket(atDaysAgo(2));

    assert.equal(summary.telemetry.daily.length, 1);
    assert.equal(summary.telemetry.daily[0].date, utcDateBucket(atDaysAgo(1)));
    assert.ok(
      !summary.telemetry.daily.some((bucket) => bucket.date === otherDay),
      "a foreign workspace's day must not appear in the series",
    );
    assert.ok(
      seenFilters.every((filters) =>
        filters.some(
          (filter) => filter.column === "workspace_id" && filter.values.includes(WORKSPACE),
        ),
      ),
      "every daily read must be scoped to the workspace",
    );
  });

  test("an empty window is a labeled absence, never a zero bucket", async () => {
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry: [] }));

    assert.deepEqual([...summary.telemetry.daily], []);
    assert.match(summary.telemetry.telemetry_unavailable_reason ?? "", /genuine zero/i);
    assert.equal(
      summary.telemetry.daily.some((bucket) => bucket.executions === 0),
      false,
      "a zero-valued bucket would render as a measured zero",
    );
  });

  test("the series is bounded by the window's day span", async () => {
    // Every day of the window, two rows each: the series cannot exceed the
    // number of distinct UTC days the 90-day window can touch.
    const telemetry = [];
    for (let day = 0; day < 90; day += 1) {
      telemetry.push(telemetryRow({ execution_id: `d${day}-a`, observed_at: atDaysAgo(day) }));
      telemetry.push(telemetryRow({ execution_id: `d${day}-b`, observed_at: atDaysAgo(day) }));
    }
    const summary = await handleAnalyticsUsage(context(), CALLER, readerWith({ telemetry }));

    assert.ok(
      summary.telemetry.daily.length <= MAX_DAILY_BUCKETS,
      `expected at most ${MAX_DAILY_BUCKETS} buckets, got ${summary.telemetry.daily.length}`,
    );
    assert.ok(summary.telemetry.daily.length <= 91, "a 90-day window spans at most 91 UTC days");
    assert.equal(
      summary.telemetry.daily.reduce((sum, bucket) => sum + bucket.executions, 0),
      summary.telemetry.total_executions,
    );
  });

  test("an unparseable instant contributes to no bucket", () => {
    assert.equal(utcDateBucket("not-an-instant"), null);
    assert.equal(utcDateBucket(""), null);
  });
});

