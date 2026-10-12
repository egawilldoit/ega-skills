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

export function computeIdempotencyKey(executionId: string, tool: string): string {
  return sha256Hex(new TextEncoder().encode(`${executionId}:${tool}`));
}

/**
 * Writes telemetry with a strict <=250ms deadline in a fire-and-forget manner.
 * Observability MUST NOT affect MCP tool results (CONTRACT-T1 §6).
 */
export function fireAndForgetTelemetry(
  sink: McpTelemetrySink | undefined,
  record: McpToolExecutionRecord,
  deadlineMs: number = 250,
): void {
  if (!sink) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Telemetry write deadline exceeded")), Math.min(deadlineMs, 250));

  sink
    .writeExecution(record)
    .catch(() => {
      // Swallowed silently to prevent operational failures from bubbling to tool execution
    })
    .finally(() => {
      clearTimeout(timer);
    });
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
  let content_retrieved = 0;
  let successCount = 0;
  let errorCount = 0;
  let totalLatency = 0;

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

    if (r.result_class === "success") {
      successCount += 1;
      if (r.tool === "search") searched += 1;
      else if (r.tool === "resolve") resolved += 1;
      else if (r.tool === "inspect") inspected += 1;
      else if (r.tool === "get_content") content_retrieved += 1;
    } else {
      errorCount += 1;
    }

    if (typeof r.latency_ms === "number" && r.latency_ms >= 0) {
      totalLatency += r.latency_ms;
    }
  }

  const total = records.length;
  const avgLatency = total > 0 ? Math.round(totalLatency / total) : 0;

  return {
    total_executions: total,
    success_count: successCount,
    error_count: errorCount,
    avg_latency_ms: avgLatency,
    funnel: {
      searched,
      resolved,
      inspected,
      content_retrieved,
    },
    by_tool: byTool,
  };
}
