/**
 * The real client must decode the real server's payloads.
 *
 * ## Why this exists
 *
 * The reported Overview failure had a shape that is very easy to misdiagnose:
 * the API answers `200`, the runtime logs stay clean, and the console still
 * shows an error — because the *client* rejected the body. That is exactly what
 * a drift between `apps/web/server/*.ts` and the decoders in
 * `apps/web/src/api/decode.ts` looks like, and before this file there was no
 * coverage of it: every decoder test fed a hand-written fixture, never the bytes
 * the deployed server actually produces, and every server test asserted status
 * codes without running the response through the client.
 *
 * Ruling that class out by hand is not enough, because the failure is silent and
 * reproducible only against a real release. So this suite boots the REAL server
 * against the REAL committed artifact and drives it with the REAL
 * `createApiClient` — the same client the SPA uses — asserting each console read
 * is delivered as a decoded value rather than a `malformed_response`.
 *
 * It is deliberately end-to-end rather than a schema check: a payload can satisfy
 * a structural assertion and still be rejected by the decoder the browser runs,
 * and the decoder is the thing whose rejection the user sees.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

import { createApiClient } from "../../apps/web/src/api/client.ts";
import { hasResponseDecoder } from "../../apps/web/src/api/decode.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(REPO_ROOT, "apps", "web", "server.mts");
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");
const COMMITTED_DIGEST = JSON.parse(
  readFileSync(join(ARTIFACT, "release-package.json"), "utf8"),
).hub_release_digest;

/** A real skill id from the committed release, percent-encoded as one segment. */
const SAMPLE_SKILL = encodeURIComponent("anthropic/claude-api");

let workdir;
let child;
let base;

async function findAvailablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("probe server did not receive an ephemeral TCP port");
  }
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function stopChild(proc, timeoutMs = 10_000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      proc.off("exit", done);
      resolve();
    };
    proc.once("exit", done);
    proc.once("error", done);
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    proc.kill("SIGKILL");
  });
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ega-web-payload-"));
  const distDir = join(workdir, "dist");
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<!doctype html><div id=root></div>");
  const artifactCopy = join(workdir, "artifact");
  cpSync(ARTIFACT, artifactCopy, { recursive: true });

  const port = await findAvailablePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_RETAINED_MANIFEST: "",
      EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST,
      // Public policy keeps this suite about the payload contract. The
      // authenticated authorization path is covered separately by
      // tests/web/artifact-access-policy.test.mjs and the EGA-719 suite.
      EGA_WEB_PUBLIC_POLICY: "public",
      EGA_SUPABASE_URL: "",
      EGA_SUPABASE_PUBLISHABLE_KEY: "",
    },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.resume();

  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) {
    await stopChild(child);
    throw new Error(`console payload probe never became ready on ${base}`);
  }
});

after(async () => {
  await stopChild(child);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/**
 * The endpoints the Overview, Skills and discovery surfaces actually read.
 *
 * Exactly the paths the SPA reaches through `API_ENDPOINTS`. `/release-identity`
 * is deliberately absent: the server exposes it, but the console does not call
 * it, and this suite asserts precisely that every path the console *does* call
 * has a decoder.
 */
const CONSOLE_READS = Object.freeze([
  ["/catalog", "/catalog", undefined],
  ["/skills", "/skills", undefined],
  ["/skills/:id", `/skills/${SAMPLE_SKILL}`, undefined],
  ["/skills/:id/content", `/skills/${SAMPLE_SKILL}/content`, { level: "L2" }],
  ["/releases", "/releases", undefined],
  ["/discovery", "/discovery", undefined],
  ["/releases/:digest", `/releases/${encodeURIComponent(COMMITTED_DIGEST)}`, undefined],
]);

describe("the real client decodes the real server payload", () => {
  for (const [label, path, query] of CONSOLE_READS) {
    test(`${label} is delivered as a decoded value`, async () => {
      assert.ok(
        hasResponseDecoder(path),
        `${label} has no declared response decoder, so the console would render whatever arrived`,
      );
      const client = createApiClient({ basePath: `${base}/api` });
      // A `malformed_response` is the exact shape of the silent failure this
      // suite exists to prevent, so it is named explicitly rather than being
      // allowed to fail as a generic assertion.
      const value = await client
        .get(path, query === undefined ? {} : { query })
        .catch((error) => {
          throw new Error(
            `${label} was rejected by the client: kind=${error.kind} status=${error.status} code=${error.code} message=${error.message}`,
          );
        });
      assert.ok(value !== null && typeof value === "object", `${label} decoded to ${typeof value}`);
    });
  }
});

describe("the catalog envelope the Overview renders", () => {
  test("carries the release identity and a complete skill page", async () => {
    const client = createApiClient({ basePath: `${base}/api` });
    const catalog = await client.get("/catalog");
    assert.equal(catalog.release.release_digest, COMMITTED_DIGEST);
    assert.equal(catalog.release.status, "stable");
    assert.ok(catalog.skill_total > 0);
    assert.ok(Array.isArray(catalog.skills) && catalog.skills.length > 0);
    assert.equal(typeof catalog.total, "number");
    // The Overview renders these without a fallback, so an absent field would be
    // rendered as `undefined` rather than reported.
    for (const field of ["sort", "sort_direction", "facets"]) {
      assert.ok(catalog[field] !== undefined, `catalog.${field} is missing`);
    }
  });
});

describe("a refusal is still a typed refusal, not a decode failure", () => {
  test("an unsupported query value is refused by the server, not mangled into malformed_response", async () => {
    const client = createApiClient({ basePath: `${base}/api` });
    const error = await client.get("/catalog", { query: { sort: "bogus" } }).then(
      () => null,
      (cause) => cause,
    );
    assert.ok(error !== null, "a bogus sort must be refused");
    assert.equal(error.kind, "server");
    assert.equal(error.status, 400);
    assert.equal(error.code, "E_WEB_CATALOG_INVALID_SORT");
  });
});
