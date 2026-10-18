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

/**
 * The storage seam.
 *
 * `signal` is part of the interface, not an implementation detail: CONTRACT-T1
 * §6.3 requires a per-event deadline, and a deadline a sink cannot observe is
 * not a deadline — it is only a timer that fires while a write keeps holding a
 * queue slot. A writer that honours the signal can stop early; the queue still
 * enforces the bound for one that does not.
 */
export interface McpTelemetrySink {
  writeExecution(record: McpToolExecutionRecord, signal?: AbortSignal): Promise<void>;
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
   * the response is committed, so a write started after that point may never
   * run. The bound is what makes that safe: unbounded growth would turn a slow
   * database into an out-of-memory kill.
   */
  readonly maxQueued?: number;
  /**
   * Maximum bytes retained across the buffer. Default 4 MiB.
   *
   * Measured from the SERIALIZED record, not an average. Several permitted
   * fields have no natural length limit (`subject`, `error_class`,
   * `auth_decision`, `request_id`), so a fixed per-record estimate is wrong in
   * both directions: it under-counts a batch of long subjects and over-counts a
   * batch of short ones.
   */
  readonly maxQueuedBytes?: number;
  /** Per-write deadline in ms. Clamped to CONTRACT-T1's 250 ms ceiling. */
  readonly deadlineMs?: number;
}

/**
 * Per-field byte ceilings, applied before a record is buffered or written.
 *
 * CONTRACT-T1 §3 permits a closed field set but not unbounded lengths, and a
 * bound that is only enforced at the queue lets one oversized record consume
 * the whole buffer. These are deliberately generous for identifiers and tight
 * for free-ish text, which is the only text telemetry permits at all.
 */
const MAX_FIELD_BYTES: Readonly<Record<string, number>> = Object.freeze({
  workspace_id: 36,
  subject: 512,
  request_id: 256,
  execution_id: 256,
  idempotency_key: 64,
  tool: 16,
  release_digest: 71,
  error_class: 128,
  rate_limit_result: 64,
  auth_decision: 64,
  content_level: 16,
  telemetry_failure_class: 32,
  schema_version: 4,
});

const DEFAULTS = { maxPending: 64, maxQueued: 256, maxQueuedBytes: 4 * 1024 * 1024 };

const encoder = new TextEncoder();

/** Serialized size of a record, in bytes. Multibyte text is counted as such. */
export function measureRecordBytes(record: McpToolExecutionRecord): number {
  return encoder.encode(JSON.stringify(record)).length;
}

/**
 * Reject a record whose fields exceed their byte ceiling.
 *
 * Length is checked in BYTES, not code units: a subject of 200 emoji is 800
 * bytes and would otherwise pass a `.length` check while consuming four times
 * the budget it was granted.
 */
export function recordExceedsFieldLimits(record: McpToolExecutionRecord): string | null {
  for (const [field, max] of Object.entries(MAX_FIELD_BYTES)) {
    const value = (record as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "number") {
      if (encoder.encode(String(value)).length > max) return field;
      continue;
    }
    if (typeof value !== "string") return field;
    if (encoder.encode(value).length > max) return field;
  }
  // `observed_at` is a formatted instant; reject anything that is not one
  // rather than letting an arbitrary string occupy the buffer.
  if (typeof record.observed_at !== "string" || !Number.isFinite(Date.parse(record.observed_at))) {
    return "observed_at";
  }
  return null;
}

/**
 * Submit one telemetry write, fully isolated from MCP tool execution.
 *
 * CONTRACT-T1 §6.1: a failing sink MUST NOT alter the tool result. Every failure
 * mode is therefore contained here, and the write is awaited only up to the
 * deadline — never past it, and never before the response is committed.
 *
 * The returned value is the OUTCOME of the deadline race, which is what lets a
 * caller observe degradation instead of inferring it from timing:
 * `undefined` means the write acknowledged, anything else is a closed failure
 * class.
 */
export function fireAndForgetTelemetry(
  sink: McpTelemetrySink | undefined,
  record: McpToolExecutionRecord,
  deadlineMs: number = TELEMETRY_DEADLINE_MS,
  options: { readonly reporter?: TelemetryReporter } = {},
): Promise<TelemetryFailureClass | undefined> {
  if (sink === undefined) {
    report(options.reporter, "disabled");
    return Promise.resolve("disabled");
  }

  const controller = new AbortController();
  // CONTRACT-T1 §6.3 caps added latency at 250ms. A caller may ask for LESS;
  // it may never obtain more.
  const budget = Math.min(Math.max(deadlineMs, 1), TELEMETRY_DEADLINE_MS);
  const timer = setTimeout(() => controller.abort(new Error("telemetry deadline exceeded")), budget);
  (timer as unknown as { unref?: () => void }).unref?.();

  let submission: Promise<void>;
  try {
    // The call is INSIDE the try: a sink that validates eagerly throws
    // synchronously, and that throw must not reach the tool result.
    submission = Promise.resolve(sink.writeExecution(record, controller.signal));
  } catch {
    clearTimeout(timer);
    report(options.reporter, "write_failed");
    return Promise.resolve("write_failed");
  }

  // Attached synchronously so the process never sees an unhandled rejection.
  const settled = submission.then(
    () => undefined,
    () => "write_failed" as const,
  );

  // A signal-ignoring sink that never settles loses this race, and the caller
  // stops awaiting it. The sink itself is abandoned; the BUFFER still releases
  // its slot on the same deadline, so an abandoned write cannot pin capacity.
  // The race timer is cleared on every path below, so it cannot outlive the
  // call and keep the event loop alive.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline_exceeded">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline_exceeded"), budget);
    (deadlineTimer as unknown as { unref?: () => void }).unref?.();
  });

  return Promise.race([settled, deadline]).then((outcome) => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    clearTimeout(timer);
    if (outcome !== undefined) report(options.reporter, outcome);
    return outcome;
  });
}

function report(reporter: TelemetryReporter | undefined, failureClass: TelemetryFailureClass): void {
  try {
    reporter?.(failureClass);
  } catch {
    // A failing reporter must not escape into tool execution either.
  }
}

/**
 * A bounded, deadline-enforcing queue in front of a sink.
 *
 * Three independent limits, because they fail differently:
 *
 *  - `maxPending` caps writes in flight;
 *  - `maxQueued` and `maxQueuedBytes` cap what is waiting, measured from real
 *    serialized bytes;
 *  - the per-write deadline releases a slot whether or not the sink
 *    acknowledges.
 *
 * ## Drop-oldest (CONTRACT-T1 §6.4)
 *
 * Under pressure the OLDEST queued event is discarded, not the newest. §6.4
 * requires drop-oldest-first, and it is also the better policy here: a fresh
 * event is the one most likely to still be inside the retention window when it
 * is eventually written, whereas the oldest is the likeliest to expire first.
 * Dropping the newest instead would discard exactly the events worth keeping
 * and preserve the ones about to fall out of the window.
 *
 * ## Capacity is released exactly once
 *
 * A slot is freed by whichever comes first: the write settling, or the deadline
 * firing. A write that settles AFTER its deadline has already been abandoned and
 * must not free a second slot — doing so would let `pending` drift below the
 * true count and eventually under-count concurrency forever. Each slot therefore
 * carries a one-shot guard.
 */
export class BoundedTelemetrySink implements McpTelemetrySink {
  readonly #sink: McpTelemetrySink;
  readonly #reporter: TelemetryReporter | undefined;
  readonly #maxPending: number;
  readonly #maxQueued: number;
  readonly #maxQueuedBytes: number;
  readonly #deadlineMs: number;
  readonly #queue: { readonly record: McpToolExecutionRecord; readonly bytes: number }[] = [];
  #pending = 0;
  #queuedBytes = 0;
  #dropped = 0;
  #expired = 0;

  constructor(
    sink: McpTelemetrySink,
    options: TelemetryBufferOptions & { reporter?: TelemetryReporter } = {},
  ) {
    this.#sink = sink;
    this.#reporter = options.reporter;
    this.#maxPending = options.maxPending ?? DEFAULTS.maxPending;
    this.#maxQueued = options.maxQueued ?? DEFAULTS.maxQueued;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULTS.maxQueuedBytes;
    // Never above the contract ceiling. A deployment may want a tighter bound,
    // never a looser one.
    this.#deadlineMs = Math.min(
      Math.max(options.deadlineMs ?? TELEMETRY_DEADLINE_MS, 1),
      TELEMETRY_DEADLINE_MS,
    );
  }

  /** Counts only. No payload, no credential, no record content. */
  get stats(): Readonly<{
    pending: number;
    queued: number;
    queuedBytes: number;
    dropped: number;
    expired: number;
    maxQueuedBytes: number;
  }> {
    return Object.freeze({
      pending: this.#pending,
      queued: this.#queue.length,
      queuedBytes: this.#queuedBytes,
      dropped: this.#dropped,
      expired: this.#expired,
      maxQueuedBytes: this.#maxQueuedBytes,
    });
  }

  writeExecution(record: McpToolExecutionRecord): Promise<void> {
    // Field limits are enforced BEFORE anything is buffered, so one oversized
    // record cannot occupy the queue it would not fit in anyway.
    const oversizedField = recordExceedsFieldLimits(record);
    if (oversizedField !== null) {
      this.#dropped += 1;
      report(this.#reporter, "invalid_record");
      return Promise.resolve();
    }

    const bytes = measureRecordBytes(record);

    // A single record larger than the whole byte budget can never be buffered.
    // It is dropped explicitly rather than evicting the entire queue to make
    // room for something that still would not fit.
    if (bytes > this.#maxQueuedBytes) {
      this.#dropped += 1;
      report(this.#reporter, "buffer_saturated");
      return Promise.resolve();
    }

    // Drop oldest-first until BOTH bounds are satisfied. One pass is not enough:
    // the byte bound may require several evictions for a run of large records.
    while (
      this.#queue.length >= this.#maxQueued ||
      this.#queuedBytes + bytes > this.#maxQueuedBytes
    ) {
      if (this.#queue.length === 0) break;
      this.#queuedBytes -= this.#queue.shift()?.bytes ?? 0;
      this.#dropped += 1;
      report(this.#reporter, "buffer_saturated");
    }

    this.#queue.push({ record, bytes });
    this.#queuedBytes += bytes;
    this.#drain();
    return Promise.resolve();
  }

  #drain(): void {
    while (this.#pending < this.#maxPending && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (entry === undefined) return;
      this.#queuedBytes -= entry.bytes;
      this.#pending += 1;
      this.#start(entry.record);
    }
  }

  #start(record: McpToolExecutionRecord): void {
    const controller = new AbortController();
    // One-shot guard. Set by whichever of {settle, deadline} fires first, so a
    // late resolution cannot release a slot that the deadline already freed.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#pending -= 1;
      this.#drain();
    };

    const deadlineTimer = setTimeout(() => {
      controller.abort(new Error("telemetry deadline exceeded"));
      this.#expired += 1;
      report(this.#reporter, "deadline_exceeded");
      // Released HERE, not when the abandoned write eventually settles. A sink
      // that ignores cancellation must not pin a slot forever.
      release();
    }, this.#deadlineMs);
    (deadlineTimer as unknown as { unref?: () => void }).unref?.();

    try {
      void Promise.resolve(this.#sink.writeExecution(record, controller.signal))
        .catch(() => {
          report(this.#reporter, "write_failed");
        })
        .finally(() => {
          clearTimeout(deadlineTimer);
          release();
        });
    } catch {
      // A synchronous throw is contained and still frees the slot.
      clearTimeout(deadlineTimer);
      report(this.#reporter, "write_failed");
      release();
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