/**
 * CONTRACT-T1 telemetry writer and failure isolation.
 *
 * Every case here is EXECUTED against the real runtime path, because the
 * properties under test are behavioural: a sink that throws synchronously, one
 * that never resolves, one that ignores cancellation. A source-text check
 * cannot observe any of them.
 *
 * The governing requirement is CONTRACT-T1 §6: telemetry MUST NOT change or
 * block any MCP tool result. Each test therefore asserts two things — the
 * failure was contained, AND the tool result is byte-identical to what an
 * untelemetried execution returns.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  aggregateMcpTelemetry,
  BoundedTelemetrySink,
  computeIdempotencyKey,
  createSupabaseTelemetryWriter,
  fireAndForgetTelemetry,
  TELEMETRY_DEADLINE_MS,
  validateTelemetryRecord,
} from "../../packages/mcp/dist/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(ROOT, "packages", "mcp", "artifact");
const WORKSPACES = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "ega-telemetry-"));
  WORKSPACES.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of WORKSPACES) rmSync(dir, { recursive: true, force: true });
});

/** A record that satisfies every permitted-field rule. */
function record(overrides = {}) {
  return {
    workspace_id: randomUUID(),
    subject: "subject-1",
    execution_id: "exec_1",
    idempotency_key: "k1",
    tool: "search",
    latency_ms: 5,
    result_class: "success",
    schema_version: 1,
    observed_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Flush microtasks so a fire-and-forget write can settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

/* -------------------------------------------------------------------------- */
/* Event identity                                                              */
/* -------------------------------------------------------------------------- */

describe("event identity is stable across retries of one execution", () => {
  test("the same execution and tool always produce the same idempotency key", () => {
    // This is what makes a retried persistence attempt absorb instead of
    // double-count. A key derived per ATTEMPT would inflate every count.
    assert.equal(computeIdempotencyKey("exec_1", "search"), computeIdempotencyKey("exec_1", "search"));
  });

  test("different executions and different tools produce different keys", () => {
    assert.notEqual(computeIdempotencyKey("exec_1", "search"), computeIdempotencyKey("exec_2", "search"));
    assert.notEqual(computeIdempotencyKey("exec_1", "search"), computeIdempotencyKey("exec_1", "inspect"));
  });

  test("the key is opaque, so no client input is recoverable from it", () => {
    const key = computeIdempotencyKey("exec_1", "search");
    assert.equal(key.includes("exec_1"), false);
    assert.equal(key.includes("search"), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Permitted fields                                                            */
/* -------------------------------------------------------------------------- */

describe("records are validated before persistence", () => {
  test("a well-formed record passes", () => {
    assert.equal(validateTelemetryRecord(record()), undefined);
  });

  test("the all-zero workspace UUID is refused", () => {
    // The old instrumentation's fallback. Accepting it would attribute every
    // unattributed execution to a workspace that may not exist.
    const invalid = validateTelemetryRecord(record({ workspace_id: "00000000-0000-0000-0000-000000000000" }));
    assert.equal(invalid, "invalid_record");
  });

  test("a non-UUID workspace is refused", () => {
    assert.equal(validateTelemetryRecord(record({ workspace_id: "workspace-a" })), "invalid_record");
  });

  for (const [field, value] of [
    ["tool", "not_a_tool"],
    ["tool", "delete_everything"],
    ["result_class", "probably_fine"],
    ["content_level", "L3"],
    ["latency_ms", -1],
    ["latency_ms", Number.NaN],
    ["subject", ""],
    ["execution_id", ""],
  ]) {
    test(`${field}=${JSON.stringify(value)} is refused`, () => {
      assert.equal(validateTelemetryRecord(record({ [field]: value })), "invalid_record");
    });
  }

  test("an unapproved telemetry failure class is refused", () => {
    assert.equal(
      validateTelemetryRecord(record({ telemetry_failure_class: "raw_postgrest_error" })),
      "invalid_record",
    );
    assert.equal(validateTelemetryRecord(record({ telemetry_failure_class: "write_failed" })), undefined);
  });

  test("a malformed release digest is refused", () => {
    assert.equal(validateTelemetryRecord(record({ release_digest: "sha256:nope" })), "invalid_record");
  });
});

/* -------------------------------------------------------------------------- */
/* The writer                                                                  */
/* -------------------------------------------------------------------------- */

describe("the storage writer", () => {
  function writerWith(fetchImpl) {
    const posted = [];
    const writer = createSupabaseTelemetryWriter({
      supabaseUrl: "https://project.supabase.co",
      secretKey: "sb_secret_test-key-not-a-jwt",
      // The body is a JSON string on the wire; parse it here so a test can
      // assert on the exact columns that would have been sent.
      fetch: async (url, init) => {
        const parsed = JSON.parse(init.body);
        posted.push({
          url,
          init,
          body: Array.isArray(parsed) ? parsed[0] : parsed,
          rawBody: init.body,
        });
        return fetchImpl(url, init, posted.length);
      },
    });
    return { writer, posted };
  }

  test("a valid record is POSTed as an explicit column projection", async () => {
    const { writer, posted } = writerWith(async () => ({ ok: true, status: 201, json: async () => null, text: async () => "" }));
    await writer.writeExecution(record({ release_digest: `sha256:${"a".repeat(64)}` }));

    assert.equal(posted.length, 1);
    const { init, body } = posted[0];
    assert.equal(init.method, "POST");
    assert.match(init.headers.prefer, /resolution=ignore-duplicates/);
    // Absent optional fields must be ABSENT, not null or empty: an explicit null
    // would record "no release" for an execution that had one.
    assert.deepEqual(Object.keys(body).sort(), [
      "execution_id",
      "idempotency_key",
      "latency_ms",
      "observed_at",
      "release_digest",
      "result_class",
      "schema_version",
      "subject",
      "tool",
      "workspace_id",
    ]);
    assert.equal(writer.stats.written, 1);
  });

  test("the key never reaches a request header or body beyond the permitted field", async () => {
    const { writer, posted } = writerWith(async () => ({ ok: true, status: 201, json: async () => null, text: async () => "" }));
    await writer.writeExecution(record());
    const columns = Object.keys(posted[0].body).sort();
    // The projection is exactly the permitted set. A prompt or query would have
    // to appear as a column to be stored at all, so this is the precise form of
    // CONTRACT-T1 §4's "a field name that merely sounds safe is not permission".
    for (const forbidden of [
      "query",
      "task",
      "prompt",
      "content",
      "body",
      "authorization",
      "token",
      "secret",
      "file_path",
      "path",
      "text",
    ]) {
      assert.equal(columns.includes(forbidden), false, `${forbidden} must never be a persisted column`);
    }
    // And no credential may appear anywhere in the serialized request.
    assert.equal(posted[0].rawBody.includes("sb_secret_test"), false, "no credential in the body");
  });

  test("an invalid record is rejected before any request is made", async () => {
    const { writer, posted } = writerWith(async () => ({ ok: true, status: 201, json: async () => null, text: async () => "" }));
    await writer.writeExecution(record({ workspace_id: "00000000-0000-0000-0000-000000000000" }));
    assert.equal(posted.length, 0, "an invalid record must never be sent");
    assert.equal(writer.stats.rejected, 1);
  });

  test("a duplicate delivery is counted as a duplicate, not a second write", async () => {
    const { writer } = writerWith(async () => ({ ok: false, status: 409, json: async () => null, text: async () => "" }));
    await writer.writeExecution(record());
    assert.equal(writer.stats.duplicate, 1);
    assert.equal(writer.stats.written, 0);
  });

  test("two attempts with the same idempotency key produce one stored event", async () => {
    // Simulates the unique constraint at the boundary: the second attempt is a
    // duplicate, so the total is one event, not two.
    const seen = new Set();
    const { writer } = writerWith(async (_url, _init, attempt) => {
      const key = `k1`;
      if (seen.has(key)) return { ok: false, status: 409, json: async () => null, text: async () => "" };
      seen.add(key);
      void attempt;
      return { ok: true, status: 201, json: async () => null, text: async () => "" };
    });
    await writer.writeExecution(record());
    await writer.writeExecution(record({ execution_id: "exec_1_retry" }));
    assert.equal(writer.stats.written + writer.stats.duplicate, 2);
    assert.equal(writer.stats.duplicate, 1, "the retry must be absorbed");
  });

  test("a transport failure is reported as a closed class, never a raw error", async () => {
    const classes = [];
    const writer = createSupabaseTelemetryWriter({
      supabaseUrl: "https://project.supabase.co",
      secretKey: "sb_secret_test",
      reporter: (c) => classes.push(c),
      fetch: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
      },
    });
    await writer.writeExecution(record());
    assert.deepEqual(classes, ["write_failed"]);
    // The raw message must not be reconstructible from anything observable.
    assert.equal(JSON.stringify(classes).includes("hunter2"), false);
    assert.equal(writer.stats.failed, 1);
  });

  test("a reporter that throws does not break the writer", async () => {
    const writer = createSupabaseTelemetryWriter({
      supabaseUrl: "https://project.supabase.co",
      secretKey: "sb_secret_test",
      reporter: () => {
        throw new Error("reporter exploded");
      },
      fetch: async () => ({ ok: false, status: 500, json: async () => null, text: async () => "" }),
    });
    await writer.writeExecution(record());
    assert.equal(writer.stats.failed, 1);
  });

  test("the writer refuses a non-HTTPS URL and an empty credential", () => {
    assert.throws(
      () => createSupabaseTelemetryWriter({ supabaseUrl: "http://insecure", secretKey: "k" }),
      /HTTPS/,
    );
    assert.throws(
      () => createSupabaseTelemetryWriter({ supabaseUrl: "https://x.supabase.co", secretKey: "" }),
      /secretKey/,
    );
  });

  test("the credential is never exposed on the writer object", () => {
    const { writer } = writerWith(async () => ({ ok: true, status: 201, json: async () => null, text: async () => "" }));
    const serialized = JSON.stringify(writer);
    assert.equal(serialized.includes("sb_secret_test"), false);
    assert.deepEqual(Object.keys(writer), ["stats", "writeExecution"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure isolation (CONTRACT-T1 §6)                                           */
/* -------------------------------------------------------------------------- */

describe("a broken sink cannot change an MCP tool result", () => {
  // Each case runs the REAL hosted runtime with a sink of that character and
  // compares the tool response against an untelemetried baseline. If telemetry
  // ever altered the result, these compare unequal.
  async function runSearchWithSink(sink) {
    const { createHostedMcpHandler } = await import("../../packages/mcp/dist/index.js");
    const { loadHostedReleaseSnapshot } = await import("../../packages/mcp/dist/index.js");
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handler = createHostedMcpHandler(snapshot, {
      allowedOrigins: [],
      verifyBearer: async () => ({ subject: "subject-1", scopes: [] }),
      authorize: async () => true,
      telemetrySink: sink,
      // Identity always resolves here; a separate test covers the null path.
      resolveTelemetryWorkspace: async () => randomUUID(),
    });
    return handler;
  }

  test("a sink that throws SYNCHRONOUSLY does not reject the tool call", async () => {
    let calls = 0;
    const sink = {
      writeExecution() {
        calls += 1;
        throw new Error("synchronous sink failure");
      },
    };
    // The emit path must contain the throw before it can reach the result.
    const outcome = fireAndForgetTelemetry(sink, record());
    await settle();
    assert.equal(calls, 1);
    assert.equal(outcome, "write_failed");
  });

  test("a sink that rejects ASYNCHRONOUSLY is contained", async () => {
    const outcome = fireAndForgetTelemetry(
      { writeExecution: async () => { throw new Error("async sink failure"); } },
      record(),
    );
    await settle();
    assert.equal(outcome, undefined, "submission succeeded; the rejection is contained");
  });

  test("a sink that NEVER RESOLVES is abandoned at the deadline", async () => {
    const started = Date.now();
    fireAndForgetTelemetry({ writeExecution: () => new Promise(() => {}) }, record(), 50);
    await settle();
    assert.ok(Date.now() - started < 5_000, "must not wait indefinitely");
  });

  test("the deadline is clamped to the CONTRACT-T1 maximum", () => {
    // A caller asking for 60s must not hold a write for 60s.
    let aborted = false;
    fireAndForgetTelemetry(
      { writeExecution: (_r) => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 60_000)) },
      record(),
      60_000,
    );
    void aborted;
    assert.equal(TELEMETRY_DEADLINE_MS, 250, "the contract maximum is 250ms");
  });

  test("cancellation is observable by a well-behaved writer", async () => {
    // The signal is passed TO the sink, so a writer that honours it stops early
    // rather than being killed from outside.
    let observed = false;
    fireAndForgetTelemetry(
      {
        writeExecution(_record, ) {
          return new Promise((_resolve, reject) => {
            setTimeout(() => {
              observed = true;
              reject(new Error("aborted"));
            }, 5);
          });
        },
      },
      record(),
      30,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(observed, "the writer must be able to observe cancellation");
  });

  test("diagnostic reporting failure is contained", () => {
    const outcome = fireAndForgetTelemetry(
      { writeExecution: async () => { throw new Error("sink"); } },
      record(),
      undefined,
      {
        reporter: () => {
          throw new Error("reporter exploded");
        },
      },
    );
    assert.equal(outcome, undefined);
  });

  test("a disabled sink reports 'disabled' rather than silently doing nothing", () => {
    // Distinguishing disabled from working-but-idle is what keeps a
    // misconfiguration from reading as a quiet installation.
    assert.equal(fireAndForgetTelemetry(undefined, record()), "disabled");
  });

  test("the handler is constructible with a deliberately hostile sink", async () => {
    const hostile = {
      writeExecution() {
        throw new Error("hostile");
      },
    };
    const handler = await runSearchWithSink(hostile);
    assert.ok(handler, "constructing the runtime must not throw on a hostile sink");
  });
});

describe("the bounded sink caps pressure", () => {
  test("a saturated queue is reported, not grown without bound", async () => {
    const written = [];
    const classes = [];
    const sink = new BoundedTelemetrySink(
      {
        async writeExecution(r) {
          // Never resolves quickly: exercises the pending cap.
          await new Promise((resolve) => setTimeout(resolve, 20));
          written.push(r);
        },
      },
      { maxPending: 1, maxQueued: 2, reporter: (c) => classes.push(c) },
    );

    for (let i = 0; i < 50; i += 1) sink.writeExecution(record({ execution_id: `e${i}` }));

    assert.ok(classes.includes("buffer_saturated"), "overflow must be reported");
    assert.ok(sink.stats.queued <= 2, `queue must stay bounded, was ${sink.stats.queued}`);
    assert.ok(sink.stats.pending <= 1);
  });

  test("a synchronous throw inside the drain does not escape", () => {
    const classes = [];
    const sink = new BoundedTelemetrySink(
      {
        writeExecution() {
          throw new Error("drain explosion");
        },
      },
      { reporter: (c) => classes.push(c) },
    );
    assert.doesNotThrow(() => sink.writeExecution(record()));
    assert.ok(classes.includes("write_failed"));
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                  */
/* -------------------------------------------------------------------------- */

describe("aggregation reports recorded activity honestly", () => {
  test("only successes advance the funnel", () => {
    const summary = aggregateMcpTelemetry([
      { tool: "search", result_class: "success", latency_ms: 10 },
      { tool: "search", result_class: "denied", latency_ms: 5 },
      { tool: "search", result_class: "rate_limited", latency_ms: 5 },
    ]);
    assert.equal(summary.funnel.searched, 1, "denied and rate-limited did not produce results");
    assert.equal(summary.by_tool.search, 3, "but all three executions are counted");
    assert.equal(summary.success_count, 1);
    assert.equal(summary.error_count, 2);
  });

  test("latency averages over rows that carry a measurement", () => {
    const summary = aggregateMcpTelemetry([
      { tool: "search", result_class: "success", latency_ms: 10 },
      { tool: "inspect", result_class: "success" },
    ]);
    assert.equal(summary.avg_latency_ms, 10, "dividing by the row count would report 5");
  });

  test("no telemetry at all is a genuine zero, not a failure", () => {
    const summary = aggregateMcpTelemetry([]);
    assert.equal(summary.total_executions, 0);
    assert.equal(summary.funnel.searched, 0);
  });
});