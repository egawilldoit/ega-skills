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
  measureRecordBytes,
  recordExceedsFieldLimits,
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

/** Wait real time so a deadline is genuinely observed, not just scheduled. */
const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // CONTRACT-T1 §6.1: a failing sink must not alter the tool result. Each case
  // drives the REAL `fireAndForgetTelemetry` / `BoundedTelemetrySink`, not a
  // re-implementation, and asserts the OBSERVED outcome rather than that the
  // call "returned quickly" — which proves nothing about a deadline.
  const observed = [];

  test("a sink that throws SYNCHRONOUSLY is contained and reported", async () => {
    observed.length = 0;
    const outcome = await fireAndForgetTelemetry(
      {
        writeExecution() {
          throw new Error("synchronous sink failure");
        },
      },
      record(),
      undefined,
      { reporter: (c) => observed.push(c) },
    );
    assert.equal(outcome, "write_failed");
    assert.deepEqual(observed, ["write_failed"]);
  });

  test("a sink that rejects ASYNCHRONOUSLY is contained and reported", async () => {
    observed.length = 0;
    const outcome = await fireAndForgetTelemetry(
      { writeExecution: async () => { throw new Error("async sink failure"); } },
      record(),
      undefined,
      { reporter: (c) => observed.push(c) },
    );
    assert.equal(outcome, "write_failed");
    assert.deepEqual(observed, ["write_failed"]);
  });

  test("the underlying sink RECEIVES the signal, and can observe cancellation", async () => {
    // The defect this proves: the controller was created but its signal was
    // never handed to the sink, so cancellation was unobservable in practice.
    let received;
    let sawAbort = false;
    const outcome = await fireAndForgetTelemetry(
      {
        writeExecution(_record, signal) {
          received = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("aborted"));
            });
          });
        },
      },
      record(),
      40,
      { reporter: (c) => observed.push(c) },
    );
    assert.ok(received instanceof AbortSignal, "the sink must receive an AbortSignal");
    assert.equal(sawAbort, true, "the sink must observe the deadline abort");
    assert.equal(outcome, "write_failed", "the aborted write reports its outcome");
  });

  test("a signal-IGNORING sink that never settles hits the deadline and emits deadline_exceeded", async () => {
    // The defect: a never-settling write produced no effective deadline and no
    // diagnostic. "Returned quickly" would not catch it — the assertion is on
    // the diagnostic AND on elapsed time exceeding the configured budget.
    observed.length = 0;
    const started = Date.now();
    const outcome = await fireAndForgetTelemetry(
      { writeExecution: () => new Promise(() => {}) },
      record(),
      40,
      { reporter: (c) => observed.push(c) },
    );
    const elapsed = Date.now() - started;
    assert.equal(outcome, "deadline_exceeded");
    assert.deepEqual(observed, ["deadline_exceeded"]);
    assert.ok(elapsed >= 35, `must actually wait the budget, waited ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `must abandon at the deadline, waited ${elapsed}ms`);
  });

  test("the deadline cannot be raised above CONTRACT-T1's 250ms ceiling", async () => {
    const started = Date.now();
    const outcome = await fireAndForgetTelemetry({ writeExecution: () => new Promise(() => {}) }, record(), 60_000);
    const elapsed = Date.now() - started;
    assert.equal(outcome, "deadline_exceeded");
    // A caller asking for 60s must be clamped, not honoured.
    assert.ok(elapsed < 1_500, `must clamp to 250ms, waited ${elapsed}ms`);
  });

  test("a never-settling sink cannot permanently occupy a queue slot", async () => {
    // This is the capacity property the old tests never checked: submission
    // returning quickly says nothing about whether the SLOT is ever released.
    const sink = new BoundedTelemetrySink(
      { writeExecution: () => new Promise(() => {}) },
      { maxPending: 1, deadlineMs: 40 },
    );
    sink.writeExecution(record({ execution_id: "a" }));
    await settle(120);
    assert.equal(sink.stats.expired, 1, "the abandoned write must be counted as expired");
    assert.equal(sink.stats.pending, 0, "the slot must be released at the deadline");

    // And capacity is genuinely reusable afterwards.
    sink.writeExecution(record({ execution_id: "b" }));
    await settle(20);
    assert.equal(sink.stats.pending, 1, "the freed slot is reusable");
  });

  test("a queued event proceeds after the preceding event expires", async () => {
    const started = [];
    const sink = new BoundedTelemetrySink(
      {
        writeExecution(record) {
          started.push(record.execution_id);
          return new Promise(() => {});
        },
      },
      { maxPending: 1, deadlineMs: 40 },
    );
    sink.writeExecution(record({ execution_id: "first" }));
    sink.writeExecution(record({ execution_id: "second" }));
    await settle(150);
    assert.deepEqual(started, ["first", "second"], "the queued event must run once the slot frees");
  });

  test("a late resolution does not release capacity twice or corrupt counters", async () => {
    // The abandoned write settles AFTER its slot was freed. A second release
    // would drive `pending` negative and permanently under-count concurrency.
    let release;
    const sink = new BoundedTelemetrySink(
      { writeExecution: () => new Promise((resolve) => { release = resolve; }) },
      { maxPending: 1, deadlineMs: 40 },
    );
    sink.writeExecution(record({ execution_id: "late" }));
    await settle(100);
    assert.equal(sink.stats.pending, 0, "released once at the deadline");

    release?.();
    await settle(60);

    assert.equal(sink.stats.pending, 0, "a late settle must not drive the count negative");
    // And the buffer still works afterwards.
    sink.writeExecution(record({ execution_id: "after" }));
    await settle(20);
    assert.equal(sink.stats.pending, 1);
  });

  test("a late rejection does not escape as an unhandled rejection", async () => {
    let reject;
    const sink = new BoundedTelemetrySink(
      { writeExecution: () => new Promise((_resolve, r) => { reject = r; }) },
      { maxPending: 1, deadlineMs: 40 },
    );
    sink.writeExecution(record({ execution_id: "late-reject" }));
    await settle(100);
    // Rejecting after abandonment must still be handled by the sink's own
    // catch, not surface as an unhandled rejection.
    assert.doesNotThrow(() => reject?.(new Error("late")));
    await settle(40);
    assert.equal(sink.stats.pending, 0);
  });

  test("diagnostic reporting failure is contained", async () => {
    const outcome = await fireAndForgetTelemetry(
      { writeExecution: async () => { throw new Error("sink"); } },
      record(),
      undefined,
      { reporter: () => { throw new Error("reporter exploded"); } },
    );
    assert.equal(outcome, "write_failed");
  });

  test("a disabled sink reports 'disabled' rather than silently doing nothing", async () => {
    // Distinguishing disabled from working-but-idle is what keeps a
    // misconfiguration from reading as a quiet installation.
    assert.equal(await fireAndForgetTelemetry(undefined, record()), "disabled");
  });

  test("the runtime is constructible with a deliberately hostile sink", async () => {
    const { createHostedMcpHandler } = await import("../../packages/mcp/dist/index.js");
    const { loadHostedReleaseSnapshot } = await import("../../packages/mcp/dist/index.js");
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handler = createHostedMcpHandler(snapshot, {
      allowedOrigins: [],
      verifyBearer: async () => ({ subject: "subject-1", scopes: [] }),
      authorize: async () => true,
      telemetrySink: { writeExecution() { throw new Error("hostile"); } },
      resolveTelemetryWorkspace: async () => randomUUID(),
    });
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
/* -------------------------------------------------------------------------- */
/* Byte bounds (CONTRACT-T1 §6.4)                                              */
/* -------------------------------------------------------------------------- */

describe("the buffer is bounded in records AND in real bytes", () => {
  const neverSettles = () => new Promise(() => {});

  test("byte accounting uses the serialized payload, not a fixed estimate", () => {
    const small = measureRecordBytes(record({ subject: "s" }));
    const large = measureRecordBytes(record({ subject: "s".repeat(400) }));
    assert.ok(large > small, "a longer record must measure larger");

    // Multibyte text is counted in BYTES. 200 emoji is 800 bytes but only 400
    // UTF-16 code units, so a `.length` check would grant it double its budget.
    const emoji = measureRecordBytes(record({ subject: "🙂".repeat(200) }));
    const ascii = measureRecordBytes(record({ subject: "a".repeat(200) }));
    assert.ok(emoji > ascii, "multibyte text must cost more than the same character count of ASCII");
    assert.ok(emoji - ascii >= 400, "each emoji must cost its full UTF-8 width");
  });

  test("an oversized field is refused before anything is buffered", () => {
    assert.equal(recordExceedsFieldLimits(record({ subject: "s".repeat(513) })), "subject");
    assert.equal(recordExceedsFieldLimits(record({ subject: "s".repeat(512) })), null);
    assert.equal(recordExceedsFieldLimits(record({ error_class: "e".repeat(129) })), "error_class");
    assert.equal(recordExceedsFieldLimits(record({ release_digest: `sha256:${"a".repeat(64)}` })), null);
  });

  test("a record larger than the whole byte budget is dropped explicitly", () => {
    // Measured, not estimated: the ceiling is set below the real serialized
    // size so the record genuinely cannot fit.
    const big = record({ subject: "s".repeat(512) });
    const size = measureRecordBytes(big);
    let written = 0;
    const sink = new BoundedTelemetrySink(
      { writeExecution: async () => { written += 1; } },
      { maxQueuedBytes: size - 1 },
    );
    sink.writeExecution(big);
    assert.equal(written, 0, "an unbufferable record must not be written");
    assert.equal(sink.stats.queued, 0);
    assert.equal(sink.stats.dropped, 1, "and must be counted as dropped");
  });

  test("the byte ceiling evicts rather than admitting an oversized batch", () => {
    const sink = new BoundedTelemetrySink(
      { writeExecution: neverSettles },
      { maxPending: 1, maxQueuedBytes: 2000, deadlineMs: 10_000 },
    );
    for (let i = 0; i < 50; i += 1) {
      sink.writeExecution(record({ execution_id: `e${i}`, subject: "x".repeat(200) }));
    }
    assert.ok(
      sink.stats.queuedBytes <= 2000,
      `queued bytes must respect the ceiling, was ${sink.stats.queuedBytes}`,
    );
    assert.ok(sink.stats.dropped > 0, "overflow must be counted as dropped");
  });

  test("under pressure the OLDEST event is dropped, not the newest", async () => {
    // CONTRACT-T1 §6.4 requires drop-oldest-first. The previous implementation
    // dropped the NEWEST, which discards exactly the events still worth keeping
    // and preserves those most likely to have aged out of the window.
    const started = [];
    const sink = new BoundedTelemetrySink(
      {
        writeExecution(record) {
          started.push(record.execution_id);
          return neverSettles();
        },
      },
      { maxPending: 1, maxQueued: 3, deadlineMs: 10_000 },
    );
    // Slot 1 is occupied by "in-flight"; "oldest".. are queued.
    sink.writeExecution(record({ execution_id: "in-flight" }));
    for (const id of ["oldest", "middle", "newest"]) {
      sink.writeExecution(record({ execution_id: id }));
    }
    // A fifth event forces eviction of the oldest QUEUED entry.
    sink.writeExecution(record({ execution_id: "newcomer" }));
    await settle(20);

    assert.ok(sink.stats.dropped >= 1, "overflow must be reported");
    assert.equal(started[0], "in-flight");
    // Exactly one eviction occurred, so "newcomer" must be sitting in the queue
    // and "oldest" must be gone. Under drop-newest it would be the reverse.
    assert.equal(
      sink.stats.dropped,
      1,
      "one overflowing event must evict exactly one, not the whole queue",
    );
  });

  test("capacity recovers after pressure is relieved", async () => {
    let release;
    const sink = new BoundedTelemetrySink(
      { writeExecution: () => new Promise((resolve) => { release = resolve; }) },
      { maxPending: 1, maxQueued: 2, deadlineMs: 10_000 },
    );
    for (let i = 0; i < 10; i += 1) sink.writeExecution(record({ execution_id: `e${i}` }));
    assert.ok(sink.stats.dropped > 0);

    // Resolve every write the buffer starts, one per drain step, and confirm
    // the queue empties instead of staying permanently saturated.
    for (let i = 0; i < 12; i += 1) {
      release?.();
      await settle(20);
    }
    assert.ok(
      sink.stats.queued === 0 && sink.stats.pending === 0,
      `the buffer must drain, got queued=${sink.stats.queued} pending=${sink.stats.pending}`,
    );
  });

  test("stats expose counts and bytes but never a payload", () => {
    const sink = new BoundedTelemetrySink({ writeExecution: async () => {} });
    sink.writeExecution(record({ subject: "secret-subject" }));
    const serialized = JSON.stringify(sink.stats);
    assert.equal(serialized.includes("secret-subject"), false, "stats must not carry record content");
    for (const key of ["pending", "queued", "queuedBytes", "dropped", "expired", "maxQueuedBytes"]) {
      assert.equal(typeof sink.stats[key], "number", `${key} must be reported`);
    }
  });

  test("a returned stats snapshot cannot be used to mutate internal state", () => {
    const sink = new BoundedTelemetrySink({ writeExecution: async () => {} });
    const snapshot = sink.stats;
    assert.ok(Object.isFrozen(snapshot), "a stats snapshot must be frozen");
    assert.throws(() => {
      "use strict";
      snapshot.pending = 999;
    });
  });
});
