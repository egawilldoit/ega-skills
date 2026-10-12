import {
  TELEMETRY_FAILURE_CLASSES,
  type McpTelemetrySink,
  type McpToolExecutionRecord,
  type TelemetryFailureClass,
  type TelemetryReporter,
} from "./telemetry.js";

/**
 * CONTRACT-T1 §5 storage writer.
 *
 * A telemetry event asserts that the SERVER observed an execution, so the
 * writer is a server-side component holding a dedicated privileged credential.
 * It is deliberately NOT reachable from the browser: there is no endpoint, tool
 * or RPC that accepts a caller-supplied row, and the table grants exclude every
 * client role.
 *
 * The credential is the same Supabase privileged key the hosted runtime already
 * uses for control-plane reads, scoped by role rather than by a separate secret.
 * It is never logged, never returned, and never reaches a browser bundle: it
 * lives only in this closure, and only as a request header.
 */

export interface SupabaseRestResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type SupabaseRestFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
) => Promise<SupabaseRestResponse>;

export interface SupabaseTelemetryWriterOptions {
  readonly supabaseUrl: string;
  /** Dedicated privileged key. Never logged, never returned, never serialized. */
  readonly secretKey: string;
  readonly fetch?: SupabaseRestFetch;
  readonly reporter?: TelemetryReporter;
  /** Table name; overridable so a test can point at a disposable schema. */
  readonly table?: string;
}

const TOOLS: ReadonlySet<string> = new Set(["search", "resolve", "inspect", "get_content"]);
const RESULT_CLASSES: ReadonlySet<string> = new Set(["success", "error", "denied", "rate_limited"]);
const CONTENT_LEVELS: ReadonlySet<string> = new Set(["L1", "L2", "companion"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Runtime validation of a record before persistence.
 *
 * CONTRACT-T1 §3 permits a closed field set and §3.2 says telemetry has NO
 * default-permitted set: anything not listed is forbidden. Validating here
 * means a future caller cannot widen what is stored by adding a field, and an
 * out-of-contract value is refused rather than silently persisted.
 *
 * A forbidden free-text field is not "stripped" — the record is rejected. A
 * silent strip would let a caller believe a prompt was recorded when it was
 * not, which is the opposite of an honest telemetry system.
 */
export function validateTelemetryRecord(record: McpToolExecutionRecord): TelemetryFailureClass | undefined {
  if (typeof record !== "object" || record === null) return "invalid_record";
  if (!UUID.test(record.workspace_id)) return "invalid_record";
  // A zero UUID is the old fallback value; a writer that accepted it would
  // attribute every unattributed execution to a workspace that may not exist.
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(record.workspace_id)) return "invalid_record";
  if (typeof record.subject !== "string" || record.subject.length === 0 || record.subject.length > 512) {
    return "invalid_record";
  }
  if (!TOOLS.has(record.tool)) return "invalid_record";
  if (!RESULT_CLASSES.has(record.result_class)) return "invalid_record";
  if (typeof record.execution_id !== "string" || record.execution_id.length === 0) return "invalid_record";
  if (typeof record.idempotency_key !== "string" || record.idempotency_key.length === 0) return "invalid_record";
  if (typeof record.latency_ms !== "number" || !Number.isFinite(record.latency_ms) || record.latency_ms < 0) {
    return "invalid_record";
  }
  if (record.release_digest !== undefined && record.release_digest !== null && !DIGEST.test(record.release_digest)) {
    return "invalid_record";
  }
  if (record.content_level !== undefined && record.content_level !== null && !CONTENT_LEVELS.has(record.content_level)) {
    return "invalid_record";
  }
  if (
    record.telemetry_failure_class !== undefined &&
    !(TELEMETRY_FAILURE_CLASSES as readonly string[]).includes(record.telemetry_failure_class)
  ) {
    return "invalid_record";
  }
  return undefined;
}

/**
 * Only the permitted columns, in a fixed order, as PostgREST values.
 *
 * An explicit projection rather than spreading the record: a new field on the
 * record type must be added HERE, deliberately, or not at all. That is the
 * mechanical form of CONTRACT-T1 §4's "a field name that merely sounds safe is
 * not permission".
 */
function toRow(record: McpToolExecutionRecord): Record<string, string | number> {
  const row: Record<string, string | number> = {
    workspace_id: record.workspace_id,
    subject: record.subject,
    execution_id: record.execution_id,
    idempotency_key: record.idempotency_key,
    tool: record.tool,
    latency_ms: Math.round(record.latency_ms),
    result_class: record.result_class,
    schema_version: record.schema_version,
    observed_at: record.observed_at,
  };
  if (record.request_id !== undefined) row["request_id"] = record.request_id;
  if (record.release_digest !== undefined) row["release_digest"] = record.release_digest;
  if (record.error_class !== undefined) row["error_class"] = record.error_class;
  if (record.rate_limit_result !== undefined) row["rate_limit_result"] = record.rate_limit_result;
  if (record.auth_decision !== undefined) row["auth_decision"] = record.auth_decision;
  if (record.request_bytes !== undefined) row["request_bytes"] = record.request_bytes;
  if (record.response_bytes !== undefined) row["response_bytes"] = record.response_bytes;
  if (record.result_count !== undefined) row["result_count"] = record.result_count;
  if (record.content_level !== undefined) row["content_level"] = record.content_level;
  if (record.telemetry_failure_class !== undefined) {
    row["telemetry_failure_class"] = record.telemetry_failure_class;
  }
  return row;
}

export interface SupabaseTelemetryWriter extends McpTelemetrySink {
  /** Present for diagnostics; counts only, never payload. */
  readonly stats: Readonly<{ written: number; duplicate: number; rejected: number; failed: number }>;
}

/**
 * Build the storage writer.
 *
 * Uses `Prefer: resolution=ignore-duplicates` so a retried write for one
 * logical execution is absorbed by the unique `idempotency_key` constraint
 * rather than raising: the retry must not inflate any count, and must not
 * surface an error into the runtime either.
 */
export function createSupabaseTelemetryWriter(options: SupabaseTelemetryWriterOptions): SupabaseTelemetryWriter {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.supabaseUrl);
  } catch {
    throw new Error("supabaseUrl must be a valid URL");
  }
  if (baseUrl.protocol !== "https:") throw new Error("supabaseUrl must use HTTPS");
  if (!options.secretKey) throw new Error("secretKey is required");
  const fetcher = options.fetch ?? (globalThis["fetch"] as unknown as SupabaseRestFetch | undefined);
  if (!fetcher) throw new Error("fetch is unavailable");
  const table = options.table ?? "mcp_tool_executions";
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("table must be a plain identifier");

  let written = 0;
  let duplicate = 0;
  let rejected = 0;
  let failed = 0;

  const report = (failureClass: TelemetryFailureClass): void => {
    try {
      options.reporter?.(failureClass);
    } catch {
      // A failing reporter must never escape into tool execution.
    }
  };

  return {
    get stats() {
      return Object.freeze({ written, duplicate, rejected, failed });
    },
    async writeExecution(record: McpToolExecutionRecord): Promise<void> {
      const invalid = validateTelemetryRecord(record);
      if (invalid !== undefined) {
        rejected += 1;
        report(invalid);
        return;
      }

      const url = new URL(`/rest/v1/${table}`, baseUrl);
      const headers: Record<string, string> = {
        accept: "application/json",
        apikey: options.secretKey,
        "content-type": "application/json",
        // Absorb a duplicate idempotency_key instead of raising: a retried
        // persistence attempt for one logical execution is not an error.
        prefer: "resolution=ignore-duplicates,return=minimal",
      };
      // Only JWT-shaped keys go on Authorization; see the credential-header
      // note in hosted-supabase.ts. The key is never parsed or logged.
      if (options.secretKey.split(".").length === 3) {
        headers["authorization"] = `Bearer ${options.secretKey}`;
      }

      try {
        const response = await fetcher(url.toString(), {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(250),
        });
        if (response.ok) {
          written += 1;
          return;
        }
        // 409 is the unique-violation signal; anything else is a real failure.
        if (response.status === 409) {
          duplicate += 1;
          return;
        }
        failed += 1;
        report("write_failed");
      } catch {
        // Includes the deadline: a write that exceeds 250ms aborts here and is
        // reported as a closed class. The raw error never leaves this function.
        failed += 1;
        report("write_failed");
      }
    },
  };
}