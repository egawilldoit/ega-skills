/**
 * Hosted MCP release observation.
 *
 * The Console's own artifact is the real committed release. Every HTTP exchange
 * is injected, so this suite never touches the network and never depends on the
 * live canonical endpoint. The properties under test are the three honest
 * states, the strict readiness schema, bounded reads, short freshness, and the
 * fixed endpoint that no caller can replace.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach, describe } from "node:test";

import { parseServerConfig } from "../../apps/web/server/env.ts";
import {
  CANONICAL_HOSTED_MCP_READYZ_URL,
  HOSTED_READINESS_FRESHNESS_MS,
  HOSTED_READINESS_MAX_BODY_BYTES,
  getHostedReleaseStatus,
  resetHostedReleaseCache,
} from "../../apps/web/server/hosted-release.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");

const COMMITTED_PACKAGE = JSON.parse(
  readFileSync(join(ARTIFACT, "release-package.json"), "utf8"),
);
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;
const CONFIG = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT });

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function readyFetch(digest, calls) {
  return async (url, init) => {
    calls?.push({ url, init });
    return jsonResponse({ status: "ready", release_digest: digest });
  };
}

function bytes(value) {
  return new TextEncoder().encode(value);
}

/** A 200 response whose body arrives as explicit chunks, not a buffered string. */
function streamedResponse(chunks, init = {}, onCancel, close = true) {
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      if (close) controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

/** A valid ready body padded with JSON whitespace to an exact byte length. */
function readyBodyOfSize(targetBytes) {
  const base = bytes(JSON.stringify({ status: "ready", release_digest: COMMITTED_DIGEST }));
  if (targetBytes < base.byteLength) throw new Error("target is smaller than the ready body");
  const body = new Uint8Array(targetBytes);
  body.set(base, 0);
  body.fill(0x20, base.byteLength);
  return body;
}

function assertUnknown(view, reasonPattern) {
  assert.equal(view.state, "unknown");
  assert.equal(view.hosted_release_digest, null);
  assert.equal(view.observed_at, null);
  assert.equal(typeof view.checked_at, "string");
  assert.ok(!Number.isNaN(Date.parse(view.checked_at)));
  assert.equal(typeof view.reason, "string");
  assert.match(view.reason, reasonPattern);
}

beforeEach(() => {
  resetHostedReleaseCache();
});

describe("hosted MCP release comparison", () => {
  test("equal canonical digests report matches and the observation time", async () => {
    const calls = [];
    const observedAt = Date.parse("2026-11-04T12:00:00.000Z");
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: readyFetch(COMMITTED_DIGEST, calls),
      now: () => observedAt,
      timeoutMs: 100,
    });

    assert.equal(view.state, "matches");
    assert.equal(view.console_release_digest, COMMITTED_DIGEST);
    assert.equal(view.hosted_release_digest, COMMITTED_DIGEST);
    assert.equal(view.observed_at, "2026-11-04T12:00:00.000Z");
    assert.equal(view.checked_at, "2026-11-04T12:00:00.000Z");
    assert.equal(view.reason, null);
    assert.equal(view.endpoint, CANONICAL_HOSTED_MCP_READYZ_URL);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CANONICAL_HOSTED_MCP_READYZ_URL);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.cache, "no-store");
  });

  test("different canonical digests report different without authorizing anything", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: readyFetch(OTHER_DIGEST),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assert.equal(view.state, "different");
    assert.equal(view.console_release_digest, COMMITTED_DIGEST);
    assert.equal(view.hosted_release_digest, OTHER_DIGEST);
    assert.notEqual(view.console_release_digest, view.hosted_release_digest);
    assert.equal(view.observed_at, "2026-11-04T12:00:00.000Z");
    assert.equal(view.reason, null);
  });

  test("a timeout is unknown, with no successful observation", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: () => new Promise(() => {}),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 10,
    });

    assertUnknown(view, /timed out/i);
    assert.equal(view.console_release_digest, COMMITTED_DIGEST);
  });

  test("malformed JSON is unknown", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => new Response("{not-json", { status: 200 }),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /not valid JSON/i);
  });

  test("a non-ready status is unknown", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () =>
        jsonResponse({ status: "starting", release_digest: COMMITTED_DIGEST }),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /did not report ready/i);
  });

  test("a non-canonical digest is unknown", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => jsonResponse({ status: "ready", release_digest: "sha256:abc" }),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /invalid release digest/i);
  });

  test("a non-200 response is unknown", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () =>
        jsonResponse({ status: "ready", release_digest: COMMITTED_DIGEST }, { status: 503 }),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /HTTP 503/);
  });

  test("a valid streamed JSON body within the limit matches", async () => {
    const body = readyBodyOfSize(HOSTED_READINESS_MAX_BODY_BYTES - 100);
    const chunks = [body.slice(0, 100), body.slice(100, 400), body.slice(400)];
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => streamedResponse(chunks),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assert.equal(view.state, "matches");
    assert.equal(view.hosted_release_digest, COMMITTED_DIGEST);
  });

  test("exactly 2,048 streamed bytes are accepted", async () => {
    const body = readyBodyOfSize(HOSTED_READINESS_MAX_BODY_BYTES);
    assert.equal(body.byteLength, HOSTED_READINESS_MAX_BODY_BYTES);
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => streamedResponse([body]),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assert.equal(view.state, "matches");
  });

  test("an oversized streamed body without Content-Length is cancelled and refused", async () => {
    let cancelled = false;
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () =>
        streamedResponse(
          [bytes("x".repeat(1_500)), bytes("x".repeat(1_500))],
          {},
          () => {
            cancelled = true;
          },
          false,
        ),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /exceeded/i);
    assert.equal(cancelled, true);
  });

  test("an oversized body with a false undersized Content-Length is refused", async () => {
    let cancelled = false;
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () =>
        streamedResponse(
          [bytes("x".repeat(1_200)), bytes("x".repeat(1_200))],
          { headers: { "content-length": "10" } },
          () => {
            cancelled = true;
          },
          false,
        ),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /exceeded/i);
    assert.equal(cancelled, true);
  });

  test("multiple small chunks whose total exceeds the limit are refused", async () => {
    let cancelled = false;
    const chunks = Array.from({ length: 30 }, () => bytes("x".repeat(100)));
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () =>
        streamedResponse(chunks, {}, () => {
          cancelled = true;
        }, false),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /exceeded/i);
    assert.equal(cancelled, true);
  });

  test("a stream failure returns Unknown", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes('{"status":"ready"'));
        controller.error(new Error("stream broke"));
      },
    });
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => new Response(stream, { status: 200 }),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /could not be read completely/i);
  });

  test("a body that never finishes still respects the two-second-style timeout", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async (_url, init) => {
        const stream = new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
          },
          pull() {
            return new Promise(() => {});
          },
        });
        return new Response(stream, { status: 200 });
      },
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 10,
    });

    assertUnknown(view, /timed out/i);
  });

  test("a response with no body returns Unknown", async () => {
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => new Response(null, { status: 200 }),
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /no readable body/i);
  });

  test("an oversized declared body is refused before reading", async () => {
    let read = false;
    const responseStub = {
      status: 200,
      headers: new Headers({
        "content-length": String(HOSTED_READINESS_MAX_BODY_BYTES + 1),
      }),
      body: {
        getReader() {
          read = true;
          throw new Error("body must not be read");
        },
      },
    };
    const view = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => responseStub,
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /exceeded/i);
    assert.equal(read, false);
  });

  test("a missing Console identity is unknown without a network call", async () => {
    let calls = 0;
    const view = await getHostedReleaseStatus(parseServerConfig({}), {
      fetch: async () => {
        calls += 1;
        return jsonResponse({ status: "ready", release_digest: COMMITTED_DIGEST });
      },
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /no verified release identity/i);
    assert.equal(view.console_release_digest, null);
    assert.equal(calls, 0);
  });

  test("a mismatched Console release is unknown without a network call", async () => {
    let calls = 0;
    const config = parseServerConfig({
      EGA_WEB_ARTIFACT_DIR: ARTIFACT,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST,
    });
    const view = await getHostedReleaseStatus(config, {
      fetch: async () => {
        calls += 1;
        return jsonResponse({ status: "ready", release_digest: OTHER_DIGEST });
      },
      now: () => Date.parse("2026-11-04T12:00:00.000Z"),
      timeoutMs: 100,
    });

    assertUnknown(view, /does not match/i);
    assert.equal(view.console_release_digest, null);
    assert.equal(calls, 0);
  });

  test("a fresh observation is reused only inside the freshness window", async () => {
    let clock = Date.parse("2026-11-04T12:00:00.000Z");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ status: "ready", release_digest: COMMITTED_DIGEST });
    };

    const first = await getHostedReleaseStatus(CONFIG, {
      fetch: fetchImpl,
      now: () => clock,
      timeoutMs: 100,
    });
    clock += HOSTED_READINESS_FRESHNESS_MS - 1;
    const second = await getHostedReleaseStatus(CONFIG, {
      fetch: fetchImpl,
      now: () => clock,
      timeoutMs: 100,
    });

    assert.equal(calls, 1);
    assert.equal(first.state, "matches");
    assert.equal(second.state, "matches");
    assert.equal(second.observed_at, first.observed_at);
    assert.equal(second.checked_at, new Date(clock).toISOString());
  });

  test("a stale observation is never served when the refresh fails", async () => {
    let clock = Date.parse("2026-11-04T12:00:00.000Z");
    let calls = 0;

    const first = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => {
        calls += 1;
        return jsonResponse({ status: "ready", release_digest: COMMITTED_DIGEST });
      },
      now: () => clock,
      timeoutMs: 100,
    });
    assert.equal(first.state, "matches");

    clock += HOSTED_READINESS_FRESHNESS_MS + 1;
    const stale = await getHostedReleaseStatus(CONFIG, {
      fetch: async () => {
        calls += 1;
        throw new Error("upstream unavailable");
      },
      now: () => clock,
      timeoutMs: 100,
    });

    assert.equal(calls, 2);
    assertUnknown(stale, /could not be completed/i);
    assert.equal(stale.console_release_digest, COMMITTED_DIGEST);
  });
});
