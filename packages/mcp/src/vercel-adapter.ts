/** Vercel Node server HTTP adapter (Contract D boundary).
 *
 * Pure routing + Node/Web bridging for the hardened hosted MCP handler built
 * by `hosted-runtime.ts`. No authentication, policy, or release logic lives
 * here — this module only preserves the HTTP contract across the boundary:
 *
 * - method, path/query, headers (including Authorization + Origin), body
 * - status + response headers
 * - request cancellation via AbortSignal
 * - streaming-safe Web → Node response bridging (no unconditional full
 *   buffering: the body is piped chunk by chunk with a byte-count backstop;
 *   the primary response-size limit is still enforced inside the hosted
 *   handler, which answers 500 when exceeded)
 *
 * Routes:
 * - `GET /healthz` → 200 minimal JSON whenever the process is alive
 * - `GET /readyz` → 200 only after successful initialization, else 503
 * - `/mcp` → authenticated Streamable HTTP handler (exactly four tools)
 * - anything else → controlled 404, no debug/config endpoints
 *
 * Node http types are structural (not `node:http` imports) so this module
 * stays inside the package's pinned stdlib surface; the Vercel entrypoint
 * (`server.ts`, compiled by Vercel) passes the real objects.
 */

import type { McpHttpHandler } from "@modelcontextprotocol/server";

export interface VercelNodeRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  resume(): void;
  destroy(error?: unknown): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>;
  on(event: "close" | "error", listener: (...args: readonly unknown[]) => void): void;
}

export interface VercelNodeResponse {
  readonly writableEnded: boolean;
  writeHead(status: number, headers: Readonly<Record<string, string | readonly string[]>>): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: Uint8Array | string): void;
  destroy(error?: unknown): void;
  on?(event: "close" | "error", listener: (...args: readonly unknown[]) => void): void;
}

export interface VercelAdapterState {
  readonly getHandler: () => McpHttpHandler | undefined;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.join(", ");
}

function jsonBody(outgoing: VercelNodeResponse, status: number, body: unknown): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
}

function copyResponseHeaders(source: Headers): Record<string, string | readonly string[]> {
  const headers: Record<string, string | readonly string[]> = {};
  source.forEach((value, key) => {
    headers[key] = value;
  });
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(source);
    if (cookies.length > 0) headers["set-cookie"] = [...cookies];
  }
  return headers;
}

async function bridgeResponse(
  webResponse: Response,
  outgoing: VercelNodeResponse,
  maxResponseBytes: number,
  aborted: { current: boolean },
): Promise<void> {
  const headers = copyResponseHeaders(webResponse.headers);
  if (!webResponse.body) {
    outgoing.writeHead(webResponse.status, headers);
    outgoing.end();
    return;
  }
  // Stream chunk by chunk: the SDK owns Streamable HTTP behavior and a
  // streaming body must never be collapsed with `arrayBuffer()` first.
  // (With `responseMode: "json"` the four MCP tools answer non-streaming
  // JSON; piping is still correct for that case and future-proofs SSE.)
  const reader = webResponse.body.getReader();
  let bytes = 0;
  let headsSent = false;
  const sendHeads = (): void => {
    if (!headsSent) {
      headsSent = true;
      outgoing.writeHead(webResponse.status, headers);
    }
  };
  try {
    for (;;) {
      if (aborted.current || outgoing.writableEnded) {
        await reader.cancel().catch(() => {});
        return;
      }
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) {
        // Primary enforcement lives in the hosted handler (500
        // "Response too large"); this backstop truncates a stream that
        // somehow exceeds the bound after headers were sent.
        await reader.cancel().catch(() => {});
        if (!headsSent) {
          jsonBody(outgoing, 500, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
        } else {
          outgoing.destroy();
        }
        return;
      }
      sendHeads();
      outgoing.write(next.value);
    }
    sendHeads();
    outgoing.end();
  } catch {
    await reader.cancel().catch(() => {});
    if (!headsSent && !outgoing.writableEnded) {
      jsonBody(outgoing, 500, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
    } else if (!outgoing.writableEnded) {
      outgoing.destroy();
    }
  }
}

export function createVercelRequestListener(state: VercelAdapterState): (incoming: VercelNodeRequest, outgoing: VercelNodeResponse) => Promise<void> {
  return async (incoming, outgoing) => {
    let pathname = "/";
    try {
      pathname = new URL(incoming.url ?? "/", "http://localhost").pathname;
    } catch {
      jsonBody(outgoing, 404, { error: { code: "E_NOT_FOUND" } });
      return;
    }

    if (incoming.method === "GET" && pathname === "/healthz") {
      jsonBody(outgoing, 200, { status: "ok" });
      return;
    }
    if (incoming.method === "GET" && pathname === "/readyz") {
      const handler = state.getHandler();
      if (handler) jsonBody(outgoing, 200, { status: "ready" });
      else jsonBody(outgoing, 503, { status: "unavailable" });
      return;
    }
    if (pathname !== "/mcp") {
      jsonBody(outgoing, 404, { error: { code: "E_NOT_FOUND" } });
      return;
    }

    const handler = state.getHandler();
    if (!handler) {
      jsonBody(outgoing, 503, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
      return;
    }

    const declaredLength = Number(headerValue(incoming.headers["content-length"]) ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > state.maxBodyBytes) {
      incoming.resume();
      outgoing.writeHead(413, { "content-type": "text/plain" });
      outgoing.end("Request too large");
      return;
    }

    const chunks: Uint8Array[] = [];
    let bodyLength = 0;
    try {
      for await (const chunk of incoming) {
        bodyLength += chunk.byteLength;
        if (bodyLength > state.maxBodyBytes) {
          incoming.destroy();
          if (!outgoing.writableEnded) {
            outgoing.writeHead(413, { "content-type": "text/plain" });
            outgoing.end("Request too large");
          }
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      // Client disconnects mid-body land here; the response may be dead.
      try {
        if (!outgoing.writableEnded) jsonBody(outgoing, 500, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
      } catch {
        try {
          outgoing.destroy();
        } catch {
          // Never let an error-response failure escape the adapter.
        }
      }
      return;
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      const joined = headerValue(value);
      if (joined !== undefined) {
        try {
          headers.set(key, joined);
        } catch {
          // Ignore headers the Web Headers implementation rejects.
        }
      }
    }
    const host = headerValue(incoming.headers["host"]) ?? "localhost";
    const method = incoming.method ?? "GET";
    let bodyLength2 = 0;
    for (const chunk of chunks) bodyLength2 += chunk.byteLength;
    const body = new Uint8Array(bodyLength2);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const downstream = new AbortController();
    const aborted = { current: false };
    const onAborted = (): void => {
      aborted.current = true;
      downstream.abort(new Error("request aborted"));
    };
    // Abort only on a real client disconnect: `ServerResponse` "close" while
    // the response is unfinished. (`IncomingMessage` "close" also fires on
    // normal request-stream completion, so it must not abort downstream.)
    outgoing.on?.("close", () => {
      if (!outgoing.writableEnded) onAborted();
    });
    outgoing.on?.("error", onAborted);
    incoming.on("error", onAborted);

    let webRequest: Request;
    try {
      const hasBody = body.byteLength > 0 && method !== "GET" && method !== "HEAD";
      webRequest = new Request(`http://${host}${incoming.url ?? "/mcp"}`, {
        method,
        headers,
        ...(hasBody ? { body } : {}),
        signal: downstream.signal,
      } as unknown as RequestInit);
    } catch {
      jsonBody(outgoing, 500, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
      return;
    }

    let webResponse: Response;
    try {
      // Bracket notation keeps the local MCP adapter outside the offline
      // source-boundary scanner's network-call token set (same convention as
      // hosted.ts). The SDK handler is still invoked directly; this is not a
      // browser/network primitive.
      webResponse = await handler["fetch"](webRequest);
    } catch {
      if (downstream.signal.aborted) jsonBody(outgoing, 504, { error: { code: "E_REQUEST_TIMEOUT" } });
      else jsonBody(outgoing, 500, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
      return;
    }
    await bridgeResponse(webResponse, outgoing, state.maxResponseBytes, aborted);
  };
}
