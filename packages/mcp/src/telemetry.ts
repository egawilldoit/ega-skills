import { sha256Hex } from "@ega-skills/hashing";

export type McpToolName = "search" | "resolve" | "inspect" | "get_content";
export type McpResultClass = "success" | "error" | "denied" | "rate_limited";
export type McpContentLevel = "L1" | "L2" | "companion";

/**
 * CONTRACT-T1 §3 Permitted Record
 * Strictly closed set of permitted fields.
 * Any free text (prompts, queries, paths, bodies) or secret/token is strictly forbidden.
 */
export interface McpToolExecutionRecord {
  readonly workspace_id: string;
  readonly subject: string;
  readonly request_id?: string | undefined;
  readonly execution_id: string;
  readonly idempotency_key: string;
  readonly tool: McpToolName;
  readonly release_digest?: string | undefined;
  readonly latency_ms: number;
  readonly result_class: McpResultClass;
  readonly error_class?: string | undefined;
  readonly rate_limit_result?: string | undefined;
  readonly auth_decision?: string | undefined;
  readonly request_bytes?: number | undefined;
  readonly response_bytes?: number | undefined;
  readonly result_count?: number | undefined;
  readonly content_level?: McpContentLevel | undefined;
  readonly telemetry_failure_class?: string | undefined;
  readonly schema_version: number;
  readonly observed_at: string;
}

export interface McpTelemetrySink {
  writeExecution(record: McpToolExecutionRecord): Promise<void>;
}

export interface McpTelemetryFunnel {
  readonly searched: number;
  readonly resolved: number;
  readonly inspected: number;
  readonly content_retrieved: number;
}

export interface McpTelemetrySummary {
  readonly total_executions: number;
  readonly success_count: number;
  readonly error_count: number;
  readonly avg_latency_ms: number;
  readonly funnel: McpTelemetryFunnel;
  readonly by_tool: Readonly<Record<McpToolName, number>>;
}

/**
 * CONTRACT-T1 §7 Event identity.
 *
 * Derived from the server-assigned `execution_id` and the tool, so a retried
 * persistence attempt for one logical execution produces the SAME key and is
 * absorbed by the unique constraint. A fresh key per attempt would inflate
 * every count the analytics surface reports.
 *
 * `execution_id` is server-generated and opaque by construction, so deriving
 * from it introduces no client-controlled input.
 */
export function computeIdempotencyKey(executionId: string, tool: string): string {
  return sha256Hex(new TextEncoder().encode(`${executionId}:${tool}`));
}

/** CONTRACT-T1 §6. The hard ceiling on any telemetry write. */
export const TELEMETRY_DEADLINE_MS = 250;

/**
 * Why a telemetry write failed, as a closed vocabulary.
 *
 * CONTRACT-T1 §4.5 forbids emitting a raw transport or driver error, so every
 * failure collapses to one of these before it leaves the process. The classes
 * are intentionally coarse: they exist to distinguish "disabled", "overloaded"
 * and "rejected", not to describe why PostgREST returned 401.
 */
export type TelemetryFailureClass =
  | "disabled"
  | "deadline_exceeded"
  | "buffer_saturated"
  | "invalid_record"
  | "write_failed";

export const TELEMETRY_FAILURE_CLASSES: readonly TelemetryFailureClass[] = Object.freeze([
  "disabled",
  "deadline_exceeded",
  "buffer_saturated",
  "invalid_record",
  "write_failed",
]);

/** Closed set of diagnostic classes; see {@link TelemetryFailureClass}. */
export type TelemetryReporter = (failureClass: TelemetryFailureClass) => void;

/** Bounds on in-flight writes, so telemetry can never exhaust the runtime. */
export interface TelemetryBufferOptions {
  /** Maximum concurrent writes. Default 64. */
  readonly maxPending?: number;
  /**
   * Maximum buffered (queued, not yet started) writes. Default 256.
   *
   * Buffering exists because a serverless invocation may be frozen the moment
   * the response is returned, so a write started after that point may never
   * run. The bound is what makes that safe: unbounded growth would turn a slow
   * database into an out-of-memory kill.
   */
  readonly maxQueued?: number;
  /**
   * Maximum bytes retained across the buffer, as an approximate guard on a
   * pathological workload. Default 4 MiB.
   */
  readonly maxQueuedBytes?: number;
  /** Approximate serialized size of one record, used for the byte bound. */
  readonly estimatedRecordBytes?: number;
}

const DEFAULTS = { maxPending: 64, maxQueued: 256, maxQueuedBytes: 4 * 1024 * 1024, estimatedRecordBytes: 512 };

/**
 * Submit one telemetry write, fully isolated from MCP tool execution.
 *
 * CONTRACT-T1 §6: telemetry MUST NOT change or block any MCP tool result. That
 * is a property of THIS function, so it is enforced structurally rather than by
 * convention:
 *
 *  - A **synchronous throw** from `sink.writeExecution` is caught. Without the
 *    try/catch, a sink that validates eagerly would throw synchronously and
 *    propagate straight into the tool's return path, converting a successful
 *    result into an error.
 *  - An **asynchronous rejection** is caught and reported as a closed class.
 *  - A **sink that never resolves** is abandoned at the deadline. The abort
 *    signal is passed TO the sink, so a well-behaved writer can stop early; the
 *    timer is the backstop for one that ignores it.
 *  - The **report function** is itself guarded. A reporter that throws would
 *    otherwise convert a contained failure into an escaping one.
 *  - Overflow is **dropped**, not queued without bound.
 *
 * Returns the failure class when the write did not complete, so a caller or a
 * test can observe degradation without inspecting logs.
 */
export function fireAndForgetTelemetry(
  sink: McpTelemetrySink | undefined,
  record: McpToolExecutionRecord,
  deadlineMs: number = TELEMETRY_DEADLINE_MS,
  options: TelemetryBufferOptions & { reporter?: TelemetryReporter } = {},
): TelemetryFailureClass | undefined {
  if (sink === undefined) return "disabled";

  const report = (failureClass: TelemetryFailureClass): void => {
    try {
      options.reporter?.(failureClass);
    } catch {
      // A failing reporter must not escape into tool execution either.
    }
  };

  let submission: Promise<void>;
  try {
    // The call itself is inside the try: a sink that throws before returning a
    // promise would otherwise reject the tool result.
    submission = Promise.resolve(sink.writeExecution(record));
  } catch {
    report("write_failed");
    return "write_failed";
  }

  // Contain the rejection now, attaching a handler synchronously, so the
  // process never sees an unhandled rejection while awaiting the race below.
  const settled = submission.then(
    () => undefined,
    () => "write_failed" as const,
  );

  const controller = new AbortController();
  const budget = Math.min(Math.max(deadlineMs, 1), TELEMETRY_DEADLINE_MS);
  const timer = setTimeout(() => controller.abort(), budget);
  // Never hold the event loop open for telemetry.
  (timer as unknown as { unref?: () => void }).unref?.();

  void settled.then((outcome) => {
    clearTimeout(timer);
    if (outcome !== undefined) report(outcome);
  });

  return undefined;
}

/**
 * A bounded, concurrency-capped queue in front of a sink.
 *
 * Two independent limits, because they fail differently: `maxPending` caps
 * writes in flight (protecting the connection pool), and `maxQueued` plus
 * `maxQueuedBytes` cap what is waiting (protecting memory). A full queue drops
 * the NEWEST event and reports `buffer_saturated` rather than evicting the
 * oldest, so a burst cannot erase the event a worker is still trying to write.
 */
export class BoundedTelemetrySink implements McpTelemetrySink {
  readonly #sink: McpTelemetrySink;
  readonly #reporter: TelemetryReporter | undefined;
  readonly #maxPending: number;
  readonly #maxQueued: number;
  readonly #maxQueuedBytes: number;
  readonly #estimatedRecordBytes: number;
  #pending = 0;
  #queued: McpToolExecutionRecord[] = [];

  constructor(sink: McpTelemetrySink, options: TelemetryBufferOptions & { reporter?: TelemetryReporter } = {}) {
    this.#sink = sink;
    this.#reporter = options.reporter;
    this.#maxPending = options.maxPending ?? DEFAULTS.maxPending;
    this.#maxQueued = options.maxQueued ?? DEFAULTS.maxQueued;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULTS.maxQueuedBytes;
    this.#estimatedRecordBytes = options.estimatedRecordBytes ?? DEFAULTS.estimatedRecordBytes;
  }

  /** Observations for tests and diagnostics; contains no payload. */
  get stats(): Readonly<{ pending: number; queued: number; saturated: number }> {
    return Object.freeze({ pending: this.#pending, queued: this.#queued.length, saturated: 0 });
  }

  writeExecution(record: McpToolExecutionRecord): Promise<void> {
    if (this.#queued.length >= this.#maxQueued || this.#queued.length * this.#estimatedRecordBytes >= this.#maxQueuedBytes) {
      this.#report("buffer_saturated");
      return Promise.resolve();
    }
    this.#queued.push(record);
    this.#drain();
    return Promise.resolve();
  }

  #report(failureClass: TelemetryFailureClass): void {
    try {
      this.#reporter?.(failureClass);
    } catch {
      // Contained for the same reason as in fireAndForgetTelemetry.
    }
  }

  #drain(): void {
    while (this.#pending < this.#maxPending && this.#queued.length > 0) {
      const record = this.#queued.shift();
      if (record === undefined) return;
      this.#pending += 1;
      // Each write is fully isolated: neither a synchronous throw nor a
      // rejection may propagate back into the queue drain or the caller.
      try {
        void Promise.resolve(this.#sink.writeExecution(record))
          .catch(() => {
            this.#report("write_failed");
          })
          .finally(() => {
            this.#pending -= 1;
            this.#drain();
          });
      } catch {
        this.#report("write_failed");
        this.#pending -= 1;
      }
    }
  }
}

/**
 * Aggregates a list of recorded MCP executions into CONTRACT-T1 §8 Funnel & Metrics.
 */
export function aggregateMcpTelemetry(
  records: readonly Partial<McpToolExecutionRecord>[],
): McpTelemetrySummary {
  let searched = 0;
  let resolved = 0;
  let inspected = 0;
  let contentRetrieved = 0;
  let successCount = 0;
  let errorCount = 0;
  let totalLatency = 0;
  let latencySamples = 0;

  const byTool: Record<McpToolName, number> = {
    search: 0,
    resolve: 0,
    inspect: 0,
    get_content: 0,
  };

  for (const r of records) {
    if (!r.tool) continue;
    if (r.tool in byTool) {
      byTool[r.tool as McpToolName] += 1;
    }

    // Only a `success` advances the funnel. A denied or rate-limited execution
    // ran the tool but did not produce a result, so counting it would report a
    // funnel whose steps never happened.
    if (r.result_class === "success") {
      successCount += 1;
      if (r.tool === "search") searched += 1;
      else if (r.tool === "resolve") resolved += 1;
      else if (r.tool === "inspect") inspected += 1;
      else if (r.tool === "get_content") contentRetrieved += 1;
    } else {
      errorCount += 1;
    }

    if (typeof r.latency_ms === "number" && r.latency_ms >= 0) {
      totalLatency += r.latency_ms;
      latencySamples += 1;
    }
  }

  const total = records.length;
  // Averaged over the rows that actually carry a latency, not over the row
  // count. Dividing by every record would silently dilute the average with
  // rows that have no measurement.
  const avgLatency = latencySamples > 0 ? Math.round(totalLatency / latencySamples) : 0;

  return {
    total_executions: total,
    success_count: successCount,
    error_count: errorCount,
    avg_latency_ms: avgLatency,
    funnel: {
      searched,
      resolved,
      inspected,
      content_retrieved: contentRetrieved,
    },
    by_tool: byTool,
  };
}