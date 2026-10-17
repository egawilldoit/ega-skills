/**
 * Pinned synthetic-intent inspection (EGA-728): BFF endpoint + consolidation.
 *
 * Consolidation: `DiscoveryPage.tsx` is the single implementation. The
 * `IntentInspectionPage.tsx` duplicate and its `/intent-inspection` route were
 * removed because both pages fetched the same BFF endpoint (`/discovery`) with
 * byte-identical rendering. No nav entry or other consumer referenced the alias
 * (verified by grep: only `routes.tsx` imported it), so no redirect is kept.
 *
 * BFF: exercises the real HTTP server (`apps/web/server.mts`) against temp-dir
 * artifact copies so the committed artifact is never mutated. Covers:
 *  (a) matching release served verbatim with `served_release_digest`;
 *  (b) mismatched evaluated digest -> 409 `E_WEB_DISCOVERY_RELEASE_MISMATCH`;
 *  (c) missing report -> 404;
 *  (d) unreadable / non-object JSON -> 503 `E_WEB_DISCOVERY_REPORT_UNAVAILABLE`;
 *  (e) missing/mismatched release identity -> 503/409 BEFORE any file read;
 *  (f) malformed shape refused by `decodeDiscoveryInspection`;
 *  (g) authorized (public 200) vs denied (private anonymous 401) delivery.
 *
 * Sidecar note: `discovery-report.json` is a sidecar file. Its FILE byte hash
 * (`sha256` of the file bytes) is independent of the release digest it names.
 * Staging (`scripts/web/stage-artifact.mjs`) copies it byte-for-byte; the
 * immutable release/blob/SQLite bytes are preserved (asserted in
 * `stage-artifact.test.mjs` and re-checked here for the sidecar).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

import { COMMITTED_RELEASE_DIGEST } from "../helpers/committed-artifact.mjs";
import { getDiscoveryInspection } from "../../apps/web/server/discovery.ts";
import { parseServerConfig } from "../../apps/web/server/env.ts";
import { resetReleaseIdentityCache } from "../../apps/web/server/release-identity.ts";
import { decodeDiscoveryInspection, ResponseContractError } from "../../apps/web/src/api/decode.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(REPO_ROOT, "apps", "web", "server.mts");
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");
const COMMITTED_REPORT = JSON.parse(readFileSync(join(ARTIFACT, "discovery-report.json"), "utf8"));
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

const BASE_PORT = 34710;
let portCursor = 0;
const cleanups = [];
let workdir;
let artifactCopy;

function sha256Bytes(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function startServer(env = {}) {
  const port = BASE_PORT + (portCursor += 1);
  const child = spawn(process.execPath, [SERVER], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      EGA_WEB_ARTIFACT_DIR: "",
      EGA_WEB_RETAINED_MANIFEST: "",
      EGA_WEB_EXPECTED_RELEASE_DIGEST: "",
      EGA_WEB_PUBLIC_POLICY: "public",
      EGA_SUPABASE_URL: "",
      EGA_SUPABASE_PUBLISHABLE_KEY: "",
      EGA_SUPABASE_ANON_KEY: "",
      EGA_SUPABASE_SECRET_KEY: "",
      ...env,
    },
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  cleanups.push(() => child.kill("SIGKILL"));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) {
    child.kill("SIGKILL");
    throw new Error(`test server on port ${port} never became healthy: ${stderr.join("").slice(0, 400)}`);
  }
  return { port, base, child };
}

async function get(server, path, init) {
  const res = await fetch(`${server.base}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function freshArtifactCopy() {
  const dir = mkdtempSync(join(tmpdir(), "ega-discovery-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ARTIFACT, dir, { recursive: true });
  return dir;
}

function configFor(dir, extra = {}) {
  resetReleaseIdentityCache();
  return parseServerConfig({
    EGA_WEB_ARTIFACT_DIR: dir,
    EGA_WEB_RETAINED_MANIFEST: "",
    EGA_WEB_EXPECTED_RELEASE_DIGEST: "",
    ...extra,
  });
}

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "ega-web-discovery-"));
  cleanups.push(() => rmSync(workdir, { recursive: true, force: true }));
  artifactCopy = freshArtifactCopy();
});

after(() => {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // Never mask a test result.
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 1. Single implementation                                                    */
/* -------------------------------------------------------------------------- */

describe("discovery UI is one implementation on one route", () => {
  test("no IntentInspectionPage duplicate remains", () => {
    assert.equal(
      existsSync(join(REPO_ROOT, "apps", "web", "src", "pages", "IntentInspectionPage.tsx")),
      false,
      "IntentInspectionPage.tsx must not exist: it duplicated DiscoveryPage.tsx byte-for-byte",
    );
  });

  test("routes.tsx serves /discovery once and no /intent-inspection alias", () => {
    const routes = readFileSync(join(REPO_ROOT, "apps", "web", "src", "pages", "routes.tsx"), "utf8");
    assert.match(routes, /path="\/discovery"/);
    assert.doesNotMatch(routes, /intent-inspection/);
    assert.doesNotMatch(routes, /IntentInspectionPage/);
    assert.ok(existsSync(join(REPO_ROOT, "apps", "web", "src", "pages", "DiscoveryPage.tsx")));
  });

  test("client has one discovery endpoint and no alias", () => {
    const client = readFileSync(join(REPO_ROOT, "apps", "web", "src", "api", "client.ts"), "utf8");
    assert.match(client, /discovery:\s*"\/discovery"/);
    assert.doesNotMatch(client, /intentInspection/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2a. Matching release served verbatim (HTTP)                                 */
/* -------------------------------------------------------------------------- */

describe("matching release is served verbatim", () => {
  test("GET /api/discovery returns the committed report plus served_release_digest", async () => {
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: artifactCopy });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 200);
    assert.equal(body.served_release_digest, COMMITTED_RELEASE_DIGEST);
    for (const key of Object.keys(COMMITTED_REPORT)) {
      assert.deepEqual(body[key], COMMITTED_REPORT[key], `field ${key} must be served verbatim`);
    }
    assert.equal(body.release_digest, COMMITTED_RELEASE_DIGEST);
  });

  test("sidecar file hash is independent of the release digest and preserved by staging", () => {
    const fileHash = sha256Bytes(join(ARTIFACT, "discovery-report.json"));
    assert.equal(fileHash.length, 64);
    // The file hash must NOT equal the release digest's hex payload: they are
    // different facts (bytes on disk vs semantic release identity).
    assert.doesNotMatch(COMMITTED_RELEASE_DIGEST, new RegExp(fileHash));
    const staged = readFileSync(join(ARTIFACT, "discovery-report.json"));
    assert.deepEqual(
      createHash("sha256").update(staged).digest("hex"),
      fileHash,
      "committed sidecar bytes are stable",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2b. Mismatched evaluated digest -> 409 (HTTP)                                */
/* -------------------------------------------------------------------------- */

describe("mismatched report is refused as a conflict", () => {
  test("mutated evaluated digests answer 409 E_WEB_DISCOVERY_RELEASE_MISMATCH", async () => {
    const dir = freshArtifactCopy();
    const reportPath = join(dir, "discovery-report.json");
    const mutated = JSON.parse(readFileSync(reportPath, "utf8"));
    mutated.release_digest = OTHER_DIGEST;
    mutated.evaluated_release_digest = OTHER_DIGEST;
    mutated.evaluated_catalog_digest = OTHER_DIGEST;
    mutated.artifact_digest = OTHER_DIGEST;
    writeFileSync(reportPath, JSON.stringify(mutated));
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: dir });
    const { status, body, text } = await get(server, "/api/discovery");
    assert.equal(status, 409);
    assert.equal(body.error.code, "E_WEB_DISCOVERY_RELEASE_MISMATCH");
    assert.doesNotMatch(text, /"case"/, "a refused report must not leak its case");
  });

  test("getDiscoveryInspection throws 409 for a mismatched digest (unit)", () => {
    const dir = freshArtifactCopy();
    const reportPath = join(dir, "discovery-report.json");
    const mutated = JSON.parse(readFileSync(reportPath, "utf8"));
    mutated.release_digest = OTHER_DIGEST;
    mutated.evaluated_release_digest = OTHER_DIGEST;
    mutated.evaluated_catalog_digest = OTHER_DIGEST;
    mutated.artifact_digest = OTHER_DIGEST;
    writeFileSync(reportPath, JSON.stringify(mutated));
    assert.throws(() => getDiscoveryInspection(configFor(dir)), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "E_WEB_DISCOVERY_RELEASE_MISMATCH");
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2c. Missing report -> 404                                                   */
/* -------------------------------------------------------------------------- */

describe("missing report is a controlled 404", () => {
  test("deleted discovery-report.json answers 404 over HTTP", async () => {
    const dir = freshArtifactCopy();
    rmSync(join(dir, "discovery-report.json"));
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: dir });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 404);
    assert.equal(body.error.code, "E_WEB_DISCOVERY_REPORT_UNAVAILABLE");
  });

  test("getDiscoveryInspection throws 404 when the sidecar is absent (unit)", () => {
    const dir = freshArtifactCopy();
    rmSync(join(dir, "discovery-report.json"));
    assert.throws(() => getDiscoveryInspection(configFor(dir)), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, "E_WEB_DISCOVERY_REPORT_UNAVAILABLE");
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2d. Unreadable / non-object JSON -> 503                                     */
/* -------------------------------------------------------------------------- */

describe("unreadable reports fail closed with 503", () => {
  test("corrupt JSON answers 503 E_WEB_DISCOVERY_REPORT_UNAVAILABLE", async () => {
    const dir = freshArtifactCopy();
    writeFileSync(join(dir, "discovery-report.json"), "{ not json{{{");
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: dir });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 503);
    assert.equal(body.error.code, "E_WEB_DISCOVERY_REPORT_UNAVAILABLE");
  });

  test("non-object JSON (array) answers 503", () => {
    const dir = freshArtifactCopy();
    writeFileSync(join(dir, "discovery-report.json"), JSON.stringify([1, 2, 3]));
    assert.throws(() => getDiscoveryInspection(configFor(dir)), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "E_WEB_DISCOVERY_REPORT_UNAVAILABLE");
      return true;
    });
  });

  test("null JSON answers 503", () => {
    const dir = freshArtifactCopy();
    writeFileSync(join(dir, "discovery-report.json"), "null");
    assert.throws(() => getDiscoveryInspection(configFor(dir)), (error) => {
      assert.equal(error.status, 503);
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2e. Release identity gates before any file read                             */
/* -------------------------------------------------------------------------- */

describe("release identity is checked before the report is read", () => {
  test("mismatched expected digest wins over a missing report (409, not 404)", async () => {
    const dir = freshArtifactCopy();
    rmSync(join(dir, "discovery-report.json"));
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: dir,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST,
    });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 409);
    assert.equal(body.error.code, "E_WEB_DISCOVERY_RELEASE_MISMATCH");
  });

  test("unverifiable artifact wins over a tampered report (503, not 409/404)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ega-discovery-broken-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: dir });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 503);
    assert.match(body.error.code, /E_WEB_DISCOVERY_RELEASE_UNAVAILABLE|E_WEB_RELEASE_UNVERIFIED/);
  });

  test("malformed expected digest is a 503 before any report read", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: "sha256:not-a-digest",
    });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 503);
    assert.equal(body.error.code, "E_WEB_ENV_INVALID");
    assert.doesNotMatch(body.error.message, /not-a-digest/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2f. Malformed shape refused by decodeDiscoveryInspection                    */
/* -------------------------------------------------------------------------- */

describe("decodeDiscoveryInspection refuses malformed shapes", () => {
  test("a report with no digest at all is refused", () => {
    assert.throws(
      () => decodeDiscoveryInspection({ report_kind: "pinned-synthetic-intent-inspection", case: {} }),
      ResponseContractError,
    );
  });

  test("a non-object case is refused", () => {
    assert.throws(
      () =>
        decodeDiscoveryInspection({
          release_digest: COMMITTED_RELEASE_DIGEST,
          case: "not-an-object",
        }),
      ResponseContractError,
    );
  });

  test("a non-object payload is refused", () => {
    assert.throws(() => decodeDiscoveryInspection([1, 2]), ResponseContractError);
    assert.throws(() => decodeDiscoveryInspection(null), ResponseContractError);
    assert.throws(() => decodeDiscoveryInspection("x"), ResponseContractError);
  });

  test("an unknown digest variant alone is refused (no broad compatibility)", () => {
    assert.throws(
      () => decodeDiscoveryInspection({ catalog_release_digest: COMMITTED_RELEASE_DIGEST }),
      ResponseContractError,
      "catalog_release_digest has no producer and must not pass the gate",
    );
  });

  test("the committed report and the BFF output both decode", () => {
    decodeDiscoveryInspection(COMMITTED_REPORT);
    decodeDiscoveryInspection({ ...COMMITTED_REPORT, served_release_digest: COMMITTED_RELEASE_DIGEST });
  });
});

/* -------------------------------------------------------------------------- */
/* 2g. Authorized vs denied delivery                                           */
/* -------------------------------------------------------------------------- */

describe("discovery delivery is authorized", () => {
  test("public policy serves anonymously (200)", async () => {
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: artifactCopy });
    const { status } = await get(server, "/api/discovery");
    assert.equal(status, 200);
  });

  test("private policy refuses an unauthenticated read (401)", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_PUBLIC_POLICY: "",
      EGA_WEB_ALLOW_ANONYMOUS: "",
      EGA_SUPABASE_URL: "https://example.supabase.co",
      EGA_SUPABASE_PUBLISHABLE_KEY: "b4-fixture-publishable-key",
    });
    const { status, body } = await get(server, "/api/discovery");
    assert.equal(status, 401);
    assert.equal(body.error.code, "E_WEB_UNAUTHENTICATED");
  });
});
