// SDK-era MCP test client (EGA Skills 2.0 release factory, Agent B).
//
// This helper drives the REAL installed MCP SDK (`@modelcontextprotocol/server@2.0.0`,
// resolved through `packages/mcp/package.json`) as a CLIENT:
//
// - `EraClient extends Protocol` — the SDK's own protocol engine (JSON-RPC
//   correlation, era codecs, outbound `_meta` envelope seam, era gating).
//   The SDK ships the client role class in a separate package
//   (`@modelcontextprotocol/client`) that is not a dependency of this repo;
//   this helper supplies only the thin role glue the SDK documents as the
//   `Client`'s responsibility (`assertCapability*` no-ops and the
//   `_outboundMetaEnvelope` override) plus era negotiation:
//     * `negotiateModernOnly()` implements "require 2026-07-28 with NO
//       fallback": it sends exactly one `server/discover` probe carrying the
//       required 2026-07-28 `_meta` envelope, requires the server to
//       advertise 2026-07-28, then pins the negotiated version (the same
//       protected field the SDK's negotiation path sets). It NEVER falls back
//       to `initialize`.
//     * `initializeLegacy()` performs the 2025-era `initialize` handshake +
//       `notifications/initialized`.
//     * `negotiateAuto()` probes modern first and only then initializes
//       legacy — the client-side meaning of `versionNegotiation = auto` on a
//       dual-era server.
//
// Transports:
// - `createHttpTransport`: POST-per-request Streamable HTTP client transport
//   that adds the 2026-07-28 standard request headers (`MCP-Protocol-Version`,
//   `Mcp-Method`, `Mcp-Name`) whenever an outbound message carries the modern
//   envelope.
// - `createStdioTransport`: spawns a real stdio MCP server process.
// - `InMemoryTransport.createLinkedPair()` (SDK export) is used for
//   in-process negative tests.
//
// Every transport records the exact messages it sent (`sent`) so tests can
// prove, for example, that a modern-only session never emits `initialize`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const requireFromMcp = createRequire(new URL("../../../packages/mcp/package.json", import.meta.url));
const sdk = requireFromMcp("@modelcontextprotocol/server");

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/** The SDK's era predicate, applied to a wire revision string. */
export function isModernProtocolVersion(version) {
  return typeof version === "string" && version >= MODERN_PROTOCOL_VERSION;
}

/** SDK Protocol class, re-exported for tests that build raw linked pairs. */
export const SdkProtocol = sdk.Protocol;

/** SDK in-memory linked transport pair factory. */
export function linkedInMemoryTransports() {
  return sdk.InMemoryTransport.createLinkedPair();
}

function parseHttpBody(text) {
  const messages = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return messages;
  if (trimmed.startsWith("{")) {
    messages.push(JSON.parse(trimmed));
    return messages;
  }
  for (const block of trimmed.split(/\n\n/)) {
    const dataLines = block.split(/\n/).filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    messages.push(JSON.parse(dataLines.map((line) => line.slice(5).trim()).join("\n")));
  }
  return messages;
}

/**
 * POST-per-request Streamable HTTP client transport. The handler's responses
 * may be plain JSON (modern `responseMode: "json"`) or SSE-framed (legacy
 * stateless serving), so both encodings are decoded.
 */
export function createHttpTransport({ url, headers = {}, getProtocolVersion } = {}) {
  const transport = {
    sent: [],
    async start() {},
    async close() {
      transport.onclose?.();
    },
    async send(message) {
      transport.sent.push(message);
      const outboundHeaders = { ...headers };
      const envelope = message.params?.["_meta"];
      const envelopeVersion =
        envelope && typeof envelope[PROTOCOL_VERSION_META_KEY] === "string"
          ? envelope[PROTOCOL_VERSION_META_KEY]
          : undefined;
      const negotiatedVersion = envelopeVersion ?? (message.method === "initialize" ? undefined : getProtocolVersion?.());
      if (typeof negotiatedVersion === "string") {
        outboundHeaders["mcp-protocol-version"] = negotiatedVersion;
      }
      if (isModernProtocolVersion(envelopeVersion)) {
        if (typeof message.method === "string") outboundHeaders["mcp-method"] = message.method;
        if (message.method === "tools/call" && typeof message.params?.name === "string") {
          outboundHeaders["mcp-name"] = message.params.name;
        }
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...outboundHeaders,
        },
        body: JSON.stringify(message),
      });
      const text = await response.text();
      let parsedMessages;
      try {
        parsedMessages = parseHttpBody(text);
      } catch (error) {
        throw new Error(`HTTP transport could not decode response (status ${response.status}): ${text.slice(0, 200)}`, { cause: error });
      }
      for (const parsed of parsedMessages) {
        queueMicrotask(() => transport.onmessage?.(parsed));
      }
    },
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    hasPerRequestStream: true,
  };
  return transport;
}

/** Real child-process stdio client transport. */
export function createStdioTransport({ bin, args = [], env, cwd }) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  const transport = {
    child,
    sent: [],
    stderr: () => stderr,
    async start() {
      child.stdout.setEncoding("utf8");
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          transport.onmessage?.(JSON.parse(line));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("exit", () => transport.onclose?.());
    },
    async close() {
      child.stdin.end();
    },
    async send(message) {
      transport.sent.push(message);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitForExit: () => new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
  };
  return transport;
}

/**
 * A client-role SDK Protocol with era negotiation. See the module header for
 * the exact scope of the role glue.
 */
export class EraClient extends SdkProtocol {
  constructor({
    supportedProtocolVersions,
    clientInfo = { name: "ega-sdk-era-client", version: "1.0.0" },
    clientCapabilities = {},
  } = {}) {
    super({ supportedProtocolVersions });
    this.clientInfo = clientInfo;
    this.clientCapabilities = clientCapabilities;
  }

  // Client-role capability assertions: the SDK role classes implement these
  // against negotiated capabilities; this test client advertises none and
  // enforces none.
  assertCapabilityForMethod() {}
  assertNotificationCapability() {}
  assertRequestHandlerCapability() {}

  /**
   * The SDK's documented `Client` seam: attach the 2026-07-28 per-request
   * envelope to every outbound request/notification once the session has
   * negotiated a modern revision.
   */
  _outboundMetaEnvelope() {
    if (!isModernProtocolVersion(this._negotiatedProtocolVersion)) return undefined;
    return {
      [PROTOCOL_VERSION_META_KEY]: this._negotiatedProtocolVersion,
      [CLIENT_INFO_META_KEY]: this.clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: this.clientCapabilities,
    };
  }

  get protocolVersion() {
    return this._negotiatedProtocolVersion;
  }

  get protocolEra() {
    if (this._negotiatedProtocolVersion === undefined) return "unnegotiated";
    return isModernProtocolVersion(this._negotiatedProtocolVersion) ? "modern" : "legacy";
  }

  /** The envelope a modern request must carry (used verbatim on the probe). */
  modernEnvelope(version = MODERN_PROTOCOL_VERSION) {
    return {
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: this.clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: this.clientCapabilities,
    };
  }

  /** One 2026-07-28 `server/discover` probe with the required envelope. */
  async discover({ requireModern = false } = {}) {
    const result = await this.request({
      method: "server/discover",
      params: { _meta: this.modernEnvelope() },
    });
    if (requireModern && !result.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
      throw new Error(
        `server does not advertise ${MODERN_PROTOCOL_VERSION}: ${JSON.stringify(result.supportedVersions)}`,
      );
    }
    return result;
  }

  /**
   * Require 2026-07-28: discover with the modern envelope, require the
   * advertisement, then pin the negotiated revision. Never calls
   * `initialize`; a server without modern support fails here.
   */
  async negotiateModernOnly() {
    const result = await this.discover({ requireModern: true });
    this._negotiatedProtocolVersion = MODERN_PROTOCOL_VERSION;
    return result;
  }

  /** 2025-era handshake: initialize + notifications/initialized. */
  async initializeLegacy(protocolVersion = LEGACY_PROTOCOL_VERSION) {
    const result = await this.request({
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: this.clientInfo },
    });
    this._negotiatedProtocolVersion = result.protocolVersion;
    await this.notification({ method: "notifications/initialized" });
    return result;
  }

  /**
   * `versionNegotiation = auto` client behavior: prefer the 2026-07-28 probe
   * when the server supports it; otherwise fall back to the 2025-era
   * handshake. The fallback is only reachable when discovery did not produce
   * a modern session.
   */
  async negotiateAuto() {
    try {
      const result = await this.discover({ requireModern: true });
      this._negotiatedProtocolVersion = MODERN_PROTOCOL_VERSION;
      return { era: "modern", result };
    } catch {
      const result = await this.initializeLegacy();
      return { era: "legacy", result };
    }
  }

  /** Every method the client has emitted toward the server, in order. */
  methodsSent(transport) {
    return transport.sent.map((message) => message.method);
  }
}

/**
 * Wraps any SDK `Transport` (for example `InMemoryTransport.createLinkedPair()`)
 * with the same `sent` message log the built-in HTTP/stdio transports keep.
 */
export function withSentLog(transport) {
  const sent = [];
  const wrapper = {
    sent,
    async start() {
      await transport.start();
    },
    async close() {
      await transport.close();
    },
    async send(message, options) {
      sent.push(message);
      await transport.send(message, options);
    },
  };
  for (const key of ["onmessage", "onerror", "onclose"]) {
    Object.defineProperty(wrapper, key, {
      get: () => transport[key],
      set: (value) => {
        transport[key] = value;
      },
    });
  }
  return wrapper;
}

/** Sort tool names for stable catalog comparisons. */
export function toolNames(tools) {
  return tools.map((tool) => tool.name).sort();
}

/** The legacy-era codec nests `structuredContent` under `result`; unwrap both. */
export function productResult(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object" && "result" in structured) {
    return structured.result;
  }
  return structured;
}
