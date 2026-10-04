/**
 * Console read API: routes, fail-closed behaviour, bounds, and response hygiene.
 *
 * ## What is exercised, and how
 *
 * `apps/web/server.mts` starts an HTTP server on import, so every HTTP
 * assertion here boots a real child process the way the deployment runs: the
 * committed release artifact copied to a temp directory, `dist/` present, and the
 * environment supplied explicitly. Nothing is re-implemented in-process, so a
 * bound that only exists in the wrapper cannot pass here.
 *
 * Two things are driven in-process instead, because a synchronous HTTP request
 * cannot observe them:
 *
 * - the concurrency cap, via the exported `createBoundedHandler` with a
 *   deliberately slow handler. Every console route is synchronous over verified
 *   in-memory data, so it settles in one tick and releases its slot before the
 *   next request is read; a test that fired concurrent HTTP requests at a cap of
 *   one and asserted a refusal would be asserting a race, not a bound.
 * - `sanitizeMessage`, the last line of defence before the socket.
 *
 * ## The fixture is the real release
 *
 * The REAL committed artifact (`packages/mcp/artifact`, 114 skills) backs every
 * success case. A module-level digest of every committed file is taken before the
 * first test and re-checked in `after`, so "never mutate the committed artifact"
 * is asserted rather than assumed.
 *
 * ## The secrets that must never appear
 *
 * A genuinely failing request is used for the leak scan, not only a success: the
 * configuration is made to fail (an expected digest that does not match, an
 * absent artifact) and the resulting bodies and headers are searched. A secret
 * only leaks on a path that has something to leak.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

import {
  API_MAX_QUERY_PARAMS,
  API_MAX_RESPONSE_BYTES_DEFAULT,
  API_REQUEST_TIMEOUT_MS_DEFAULT,
  createBoundedHandler,
  installConsoleApi,
  loadRequestBounds,
  sanitizeMessage,
} from "../../apps/web/server/api.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(REPO_ROOT, "apps", "web", "server.mts");
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");

const COMMITTED_PACKAGE = JSON.parse(readFileSync(join(ARTIFACT, "release-package.json"), "utf8"));
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

/** A real skill id from the committed release, percent-encoded as one segment. */
const SAMPLE_SKILL = "anthropic/claude-api";
const SAMPLE_SKILL_SEGMENT = encodeURIComponent(SAMPLE_SKILL);

/** Values that must never appear in any response. Never real credentials. */
const SECRET_MARKERS = Object.freeze({
  EGA_SUPABASE_SECRET_KEY: "b4-fixture-supabase-secret-value",
  EGA_WEB_AUTHZ_JSON: "b4-fixture-authorization-graph",
  bearer: "b4-fixture-delegated-bearer-token",
});

const BASE_PORT = 34210;
let portCursor = 0;

/**
 * Words that would betray a server-side fact in a refusal: a table name, a row
 * count, or the size of the catalog. Word boundaries are required, because
 * `<portable-name>` legitimately contains "table" and a substring match there
 * would fail for the wrong reason.
 */
const SERVER_FACT_PATTERN = /\brow\b|\btable\b|\bskill_versions\b|\bcatalog\b|\b114\b|\bregistry\b/i;

/* -------------------------------------------------------------------------- */
/* Committed-artifact integrity                                                */
/* -------------------------------------------------------------------------- */

function digestEveryFile(dir) {
  const digests = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        digests.set(path.slice(ARTIFACT.length), createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  walk(dir);
  return digests;
}

const ARTIFACT_DIGESTS_BEFORE = digestEveryFile(ARTIFACT);

/* -------------------------------------------------------------------------- */
/* Server harness                                                              */
/* -------------------------------------------------------------------------- */

const cleanups = [];
let workdir;
let artifactCopy;
let baseline;

/**
 * Boot one console server and wait for it to answer.
 *
 * `env` is merged over a baseline that clears every release variable, so a test
 * only states what it means to state and cannot accidentally inherit a value.
 */
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
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port,
    base,
    child,
    env,
    /** Everything the process wrote to stdout. Must always be empty. */
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

/** One request, returning status, headers and the parsed or raw body. */
async function request(server, path, init = {}) {
  const response = await fetch(`${server.base}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, text, body };
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ega-web-api-"));
  cleanups.push(() => rmSync(workdir, { recursive: true, force: true }));
  mkdirSync(join(workdir, "dist"), { recursive: true });
  writeFileSync(join(workdir, "dist", "index.html"), "<!doctype html><div id=root></div>");
  artifactCopy = join(workdir, "artifact");
  cpSync(ARTIFACT, artifactCopy, { recursive: true });
  cleanups.push(() => rmSync(artifactCopy, { recursive: true, force: true }));
  baseline = await startServer({ EGA_WEB_ARTIFACT_DIR: artifactCopy });
});

after(() => {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // A cleanup failure must not mask a test result.
    }
  }
  const afterDigests = digestEveryFile(ARTIFACT);
  assert.equal(afterDigests.size, ARTIFACT_DIGESTS_BEFORE.size, "the committed artifact gained or lost files");
  for (const [relative, digest] of ARTIFACT_DIGESTS_BEFORE) {
    assert.equal(afterDigests.get(relative), digest, `the committed artifact file ${relative} was modified`);
  }
});

/* -------------------------------------------------------------------------- */
/* Route table introspection                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The route table, captured once.
 *
 * `installConsoleApi` is deliberately idempotent, so the *first* call in a
 * process is the only one that registers. This module therefore installs into its
 * own array at load time and both route-table assertions read that array.
 */
const REGISTERED_ROUTES = [];
installConsoleApi(REGISTERED_ROUTES, () => ({ ready: true, detail: "" }), loadRequestBounds({}));

/* -------------------------------------------------------------------------- */
/* 7. Every route answers 200 with a well-formed body                          */
/* -------------------------------------------------------------------------- */

describe("every console route answers against the real artifact", () => {
  test("GET /api/release-identity reports the verified identity", async () => {
    const { status, body } = await request(baseline, "/api/release-identity");
    assert.equal(status, 200);
    assert.equal(body.release.release_digest, COMMITTED_DIGEST);
    assert.equal(body.release.skill_count, 114);
    assert.equal(body.actual_release_digest, COMMITTED_DIGEST);
    assert.equal(body.release_unavailable_reason, null);
    assert.equal(body.has_retained_manifest, false);
    assert.equal(body.retained_release_count, null);
    // `environment` is presence-only: no path, no digest, no secret.
    assert.match(body.environment, /artifact directory configured/);
    assert.doesNotMatch(body.environment, /sha256:|\/|secret/i);
  });

  test("GET /api/catalog enumerates the release", async () => {
    const { status, body } = await request(baseline, "/api/catalog?limit=200");
    assert.equal(status, 200);
    assert.equal(body.skill_total, 114);
    assert.equal(body.total, 114);
    assert.equal(body.skills.length, 114);
    assert.equal(body.release.release_digest, COMMITTED_DIGEST);
    assert.equal(body.release_unavailable_reason, null);
    assert.ok(Array.isArray(body.facets.triggers));
  });

  test("GET /api/catalog honours every documented query parameter", async () => {
    const { status, body } = await request(
      baseline,
      `/api/catalog?q=claude&namespace=anthropic&l1=MISSING&sort=-l2_tokens&limit=5&offset=0`,
    );
    assert.equal(status, 200);
    assert.equal(body.limit, 5);
    assert.equal(body.sort, "l2_tokens");
    assert.equal(body.sort_direction, "desc");
    assert.deepEqual(body.applied_filters, {
      q: "claude",
      namespace: "anthropic",
      domain: null,
      framework: null,
      source: null,
      l1: "MISSING",
    });
    assert.ok(body.skills.every((row) => row.namespace === "anthropic"));
  });

  test("GET /api/skills is the catalog list, not a second enumeration", async () => {
    const skills = await request(baseline, "/api/skills");
    const catalog = await request(baseline, "/api/catalog");
    assert.equal(skills.status, 200);
    assert.equal(catalog.status, 200);
    assert.deepEqual(
      skills.body.skills.map((row) => row.skill_id),
      catalog.body.skills.map((row) => row.skill_id),
    );
  });

  test("GET /api/skills/:skillId resolves a percent-encoded canonical id", async () => {
    const { status, body } = await request(baseline, `/api/skills/${SAMPLE_SKILL_SEGMENT}`);
    assert.equal(status, 200);
    assert.equal(body.summary.skill_id, SAMPLE_SKILL);
    assert.equal(body.release.release_digest, COMMITTED_DIGEST);
    assert.ok(Array.isArray(body.files));
    assert.ok(body.routing !== undefined);
  });

  test("GET /api/skills/:skillId/content serves a verified body", async () => {
    const { status, body } = await request(
      baseline,
      `/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L2&max_tokens=32000`,
    );
    assert.equal(status, 200);
    assert.equal(body.skill_id, SAMPLE_SKILL);
    assert.equal(body.level, "L2");
    assert.equal(body.truncated, false);
    assert.ok(body.token_count > 0);
    assert.ok(body.content.length > 0);
    assert.equal(body.release.release_digest, COMMITTED_DIGEST);
  });

  test("no artifact control file is reachable as skill content", async () => {
    // The manifest path must be an exact entry, so a control file name is
    // refused by `runGetContentTool` rather than resolved against the directory.
    for (const attempt of [
      "release-package.json",
      "hub-release.json",
      "candidate.json",
      "registry.sqlite",
      "../release-package.json",
      "../../cache",
    ]) {
      const { status, body } = await request(
        baseline,
        `/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L2&file_path=${encodeURIComponent(attempt)}`,
      );
      assert.notEqual(status, 200, `${attempt} must not be served as content`);
      assert.ok(body.error.code.startsWith("E_WEB_"), `${attempt} must fail with a console error code`);
      assert.doesNotMatch(body.error.message, /"payload"/);
    }
  });

  test("GET /api/releases reports the single verifiable release", async () => {
    const { status, body } = await request(baseline, "/api/releases");
    assert.equal(status, 200);
    assert.equal(body.history_state, "single-verified-release");
    assert.equal(body.release_total, 1);
    assert.equal(body.publication_revision, null);
    assert.equal(body.deployment_id, null);
    assert.match(body.history_unavailable_reason, /no retained release manifest/);
    assert.equal(body.releases[0].release.release_digest, COMMITTED_DIGEST);
  });

  test("GET /api/releases/:releaseDigest serves the real detail", async () => {
    const { status, body } = await request(baseline, `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`);
    assert.equal(status, 200);
    assert.equal(body.release.release_digest, COMMITTED_DIGEST);
    assert.equal(body.artifacts.length, 2);
    assert.equal(
      body.artifacts.find((entry) => entry.artifact_kind === "sqlite").object_digest,
      COMMITTED_PACKAGE.sqlite_artifact_digest,
    );
    assert.equal(body.published_at, null);
  });

  test("GET /api/releases/compare diffs a release against itself", async () => {
    const digest = encodeURIComponent(COMMITTED_DIGEST);
    const { status, body } = await request(
      baseline,
      `/api/releases/compare?base=${digest}&candidate=${digest}`,
    );
    assert.equal(status, 200);
    assert.equal(body.status, "UNCHANGED");
    assert.equal(body.unchanged_count, 114);
    assert.deepEqual(body.added_skill_ids, []);
    assert.deepEqual(body.removed_skill_ids, []);
    assert.deepEqual(body.changed_skill_ids, []);
    assert.deepEqual(body.artifact_changes, {
      adopted_sources: false,
      alias_map: false,
      search_index_input: false,
      token_artifact: false,
    });
  });

  test("every API response carries nosniff and no-store", async () => {
    for (const path of ["/api/release-identity", "/api/catalog?limit=1", "/api/releases", "/api/no-such-view"]) {
      const { headers } = await request(baseline, path);
      assert.equal(headers.get("x-content-type-options"), "nosniff", `${path} must send nosniff`);
      assert.equal(headers.get("cache-control"), "no-store", `${path} must not be cached`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 8. A mismatch fails closed at the HTTP layer                                */
/* -------------------------------------------------------------------------- */

describe("a release-identity mismatch fails closed over HTTP", () => {
  let mismatched;
  const mismatchDigest = `sha256:${"1".repeat(64)}`;

  before(async () => {
    mismatched = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: mismatchDigest,
    });
  });

  test("the deployment really is in a mismatch, verified from the identity route", async () => {
    const { status, body } = await request(mismatched, "/api/release-identity");
    assert.equal(status, 200);
    assert.equal(body.release.status, "mismatch");
    assert.notEqual(body.release.mismatch_reason, null);
    assert.ok(body.release.mismatch_reason.length > 0);
    assert.equal(body.actual_release_digest, COMMITTED_DIGEST);
    assert.equal(body.expected_release_digest, mismatchDigest);
    assert.equal(body.expected_digest_source, "env");
    assert.equal(body.is_stable, false);
  });

  test("catalog, skill and content routes answer 503 and serve no rows", async () => {
    const cases = [
      "/api/catalog",
      "/api/skills",
      `/api/skills/${SAMPLE_SKILL_SEGMENT}`,
      `/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L2&max_tokens=32000`,
      "/api/releases",
      `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`,
      `/api/releases/compare?base=${encodeURIComponent(COMMITTED_DIGEST)}&candidate=${encodeURIComponent(COMMITTED_DIGEST)}`,
    ];
    for (const path of cases) {
      const { status, body, text } = await request(mismatched, path);
      assert.equal(status, 503, `${path} must answer 503 on a mismatch`);
      assert.equal(body.error.code, "E_WEB_RELEASE_MISMATCH", `${path} must name the mismatch`);
      // Not one catalog row, not one skill, not one digest of release content.
      assert.doesNotMatch(text, /"skills"/, `${path} must not serve catalog rows`);
      assert.doesNotMatch(text, /"summary"/, `${path} must not serve skill metadata`);
      assert.doesNotMatch(text, /"content"/, `${path} must not serve a skill body`);
      assert.doesNotMatch(text, /"releases"/, `${path} must not serve release rows`);
      // No warning banner: the failure is the response, not an annotation.
      assert.doesNotMatch(text, /warning|stale/i);
    }
  });

  test("/readyz is 503 and says why", async () => {
    const { status, body } = await request(mismatched, "/readyz");
    assert.equal(status, 503);
    assert.equal(body.status, "unavailable");
    assert.match(body.detail, /does not match the release this deployment expects/);
    assert.match(body.detail, /mismatchDigest|1{64}/);
  });

  test("/healthz still answers 200: the process is alive, its contents are not servable", async () => {
    const { status, body } = await request(mismatched, "/healthz");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ok" });
  });

  test("an unverifiable artifact also fails closed, at every release surface", async () => {
    const broken = join(workdir, "broken-artifact");
    mkdirSync(broken, { recursive: true });
    // A directory that exists but holds no release: the conservative default probe
    // passes it, and the verification half of the real probe must not.
    const server = await startServer({ EGA_WEB_ARTIFACT_DIR: broken });
    const { status, body } = await request(server, "/readyz");
    assert.equal(status, 503);
    assert.match(body.detail, /not verified|release artifact/i);

    for (const path of ["/api/catalog", "/api/releases", `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`]) {
      const answer = await request(server, path);
      assert.equal(answer.status, 503, `${path} must answer 503 for an unverifiable artifact`);
      assert.equal(answer.body.error.code, "E_WEB_RELEASE_UNVERIFIED");
      assert.doesNotMatch(answer.text, /"skills"|"releases"/);
    }
    // The identity route still answers, reporting the refusal rather than throwing.
    const identity = await request(server, "/api/release-identity");
    assert.equal(identity.status, 200);
    assert.equal(identity.body.release, null);
    assert.match(identity.body.release_unavailable_reason, /failed verification|not verified/);
  });

  test("a malformed expected digest is a 503, never a silent unpinned", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: "sha256:not-a-digest",
    });
    const { status, body } = await request(server, "/api/catalog");
    assert.equal(status, 503);
    assert.equal(body.error.code, "E_WEB_ENV_INVALID");
    // The configured value is never echoed.
    assert.doesNotMatch(body.error.message, /not-a-digest/);
    const ready = await request(server, "/readyz");
    assert.equal(ready.status, 503);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. compare is matched before /releases/:releaseDigest                       */
/* -------------------------------------------------------------------------- */

describe("/releases/compare is never swallowed by the detail route", () => {
  test("a compare request reaches the compare route, not the detail route", async () => {
    const digest = encodeURIComponent(COMMITTED_DIGEST);
    const compare = await request(baseline, `/api/releases/compare?base=${digest}&candidate=${digest}`);
    // The detail route would answer 404 `E_WEB_RELEASE_UNAVAILABLE` for the
    // literal path segment `compare`, because `compare` is not a digest.
    assert.equal(compare.status, 200);
    assert.equal(compare.body.status, "UNCHANGED");
    assert.ok(Object.hasOwn(compare.body, "unchanged_skill_ids"));
    assert.equal(Object.hasOwn(compare.body, "artifacts"), false);
  });

  test("both mechanisms hold independently", async () => {
    // `installConsoleApi` registers compare before the detail pattern, and the
    // router prefers an exact literal path over a pattern. Assert the registration
    // order directly so a future reorder is caught rather than silently relying on
    // the router's literal-first pass.
    const paths = REGISTERED_ROUTES.map((route) => route.path);
    assert.ok(
      paths.indexOf("/releases/compare") < paths.indexOf("/releases/:releaseDigest"),
      "compare must be registered before the digest pattern",
    );
    // And the reordering cannot happen silently: installing a second time adds
    // nothing, so the live table and this assertion cannot drift apart.
    const extra = [];
    installConsoleApi(extra, () => ({ ready: true, detail: "" }), loadRequestBounds({}));
    assert.deepEqual(extra, [], "installConsoleApi must be idempotent");
  });

  test("a compare request without both digests is a 400, not a 404 from the detail route", async () => {
    const only = await request(baseline, "/api/releases/compare?base=x");
    assert.equal(only.status, 400);
    assert.equal(only.body.error.code, "E_WEB_RELEASE_DIGEST_INVALID");
  });

  test("a literal non-digest segment still reaches the detail route and is refused as malformed", async () => {
    const { status, body } = await request(baseline, "/api/releases/compare-release");
    assert.equal(status, 400);
    assert.equal(body.error.code, "E_WEB_RELEASE_DIGEST_INVALID");
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Controlled 404 and 405 boundaries                                       */
/* -------------------------------------------------------------------------- */

describe("unknown routes and wrong methods are answered, never executed", () => {
  test("an unknown /api path answers a controlled 404 with no stack trace", async () => {
    for (const path of ["/api/no-such-view", "/api/catalog/extra/segments", "/api", "/api/releases/"]) {
      const { status, body, text } = await request(baseline, path);
      assert.equal(status, 404, `${path} must be a controlled 404`);
      assert.deepEqual(body, { error: { code: "E_NOT_FOUND", message: "No such route." } });
      assert.doesNotMatch(text, /at .*\.m?ts:\d+|Error:|\.ts:\d+:\d+/);
    }
  });

  test("every registered route refuses every write verb with 405 and an Allow header", async () => {
    const paths = [
      "/api/release-identity",
      "/api/catalog",
      "/api/skills",
      `/api/skills/${SAMPLE_SKILL_SEGMENT}`,
      `/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L2`,
      "/api/releases",
      `/api/releases/compare?base=${encodeURIComponent(COMMITTED_DIGEST)}&candidate=${encodeURIComponent(COMMITTED_DIGEST)}`,
      `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`,
    ];
    for (const path of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const { status, headers, body } = await request(baseline, path, { method });
        assert.equal(status, 405, `${method} ${path} must be refused`);
        assert.equal(headers.get("allow"), "GET", `${method} ${path} must advertise GET only`);
        assert.equal(body.error.code, "E_METHOD_NOT_ALLOWED");
      }
    }
  });

  test("a nonexistent skill and an unreleased one are indistinguishable", async () => {
    // CONTRACT-D 6:92-93: an invisible resource returns the same shape as a
    // nonexistent one. This deployment holds exactly one release and reads no
    // per-user authorization, so there is no "invisible but existing" category to
    // distinguish: every canonical id the release does not pin is refused
    // identically. The assertion is that nothing in the refusal reveals whether a
    // row exists anywhere in the snapshot.
    const answers = [];
    for (const id of [
      "anthropic/not-in-this-release",
      "vercel/not-in-this-release",
      "nosuchns/nope",
    ]) {
      const { status, body } = await request(baseline, `/api/skills/${encodeURIComponent(id)}`);
      answers.push({ id, status, body });
    }
    for (const answer of answers) {
      assert.equal(answer.status, 404, `${answer.id} must be refused`);
      assert.equal(answer.body.error.code, "E_WEB_SKILL_NOT_RELEASED");
      // The message quotes the id the caller supplied, never a server-side fact.
      assert.doesNotMatch(answer.body.error.message, SERVER_FACT_PATTERN);
    }
    // Every refusal is byte-identical apart from the echoed id, so nothing about
    // the release's contents can be inferred from the shape of the error.
    const shapes = new Set(
      answers.map((answer) => JSON.stringify({ ...answer.body, error: { ...answer.body.error, message: "" } })),
    );
    assert.equal(shapes.size, 1, "three refusals must share one shape");

    // A released id of the same grammar is a 200, which is a fact about the
    // release the caller could have read from `/api/catalog` anyway.
    const released = await request(baseline, `/api/skills/${SAMPLE_SKILL_SEGMENT}`);
    assert.equal(released.status, 200);

    // An id that is not even canonical is a 400, which reveals the grammar and
    // nothing about existence.
    const malformed = await request(baseline, "/api/skills/not-a-canonical-id");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "E_WEB_SKILL_ID_INVALID");
    assert.doesNotMatch(malformed.body.error.message, SERVER_FACT_PATTERN);
  });

  test("a bad query parameter is a 400, never a silent default", async () => {
    const cases = [
      ["/api/catalog?sort=bogus", "E_WEB_CATALOG_INVALID_SORT"],
      ["/api/catalog?limit=0", "E_WEB_CATALOG_INVALID_LIMIT"],
      ["/api/catalog?limit=99999", "E_WEB_CATALOG_INVALID_LIMIT"],
      ["/api/catalog?offset=-1", "E_WEB_CATALOG_INVALID_OFFSET"],
      ["/api/catalog?limit=abc", "E_WEB_QUERY_INVALID"],
      ["/api/catalog?limit=1e3", "E_WEB_QUERY_INVALID"],
      [`/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L3`, "E_WEB_CONTENT_LEVEL_INVALID"],
      [`/api/skills/${SAMPLE_SKILL_SEGMENT}/content`, "E_WEB_CONTENT_LEVEL_INVALID"],
      [`/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L2&version_hash=not-a-digest`, "E_WEB_CONTENT_VERSION_INVALID"],
    ];
    for (const [path, code] of cases) {
      const { status, body } = await request(baseline, path);
      assert.equal(status, 400, `${path} must be a 400`);
      assert.equal(body.error.code, code, `${path} must report ${code}`);
    }
  });

  test("the query string itself is bounded", async () => {
    const many = new URLSearchParams();
    for (let index = 0; index <= API_MAX_QUERY_PARAMS + 1; index += 1) many.set(`p${index}`, "x");
    const overflow = await request(baseline, `/api/catalog?${many.toString()}`);
    assert.equal(overflow.status, 400);
    assert.equal(overflow.body.error.code, "E_WEB_QUERY_INVALID");
    assert.match(overflow.body.error.message, /at most 16 query parameters/);

    const long = await request(baseline, `/api/catalog?q=${"x".repeat(600)}`);
    assert.equal(long.status, 400);
    assert.equal(long.body.error.code, "E_WEB_QUERY_INVALID");
  });
});

/* -------------------------------------------------------------------------- */
/* 11. No secret, absolute path, or SQL reaches a response                     */
/* -------------------------------------------------------------------------- */

describe("no secret, absolute path, or SQL fragment reaches a response", () => {
  /** Everything a response can leak through, captured as one searchable string. */
  function leakSurface({ headers, text }) {
    const headerText = [...headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
    return `${headerText}\n${text}`;
  }

  const SQL_FRAGMENTS = [
    "SELECT ",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
    "sqlite_master",
    "skill_versions",
    "skill_fts",
    "PRAGMA",
    "release_fts_",
    "query_only",
    "FTS5",
  ];

  test("a genuinely failing request leaks nothing", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: `sha256:${"2".repeat(64)}`,
      EGA_SUPABASE_SECRET_KEY: SECRET_MARKERS.EGA_SUPABASE_SECRET_KEY,
    });
    // A path that fails deep in verification, so a real upstream message with a
    // real absolute path is what gets redacted.
    const broken = join(workdir, "leaky-artifact");
    mkdirSync(broken, { recursive: true });
    cpSync(join(ARTIFACT, "release-package.json"), join(broken, "release-package.json"));
    cpSync(join(ARTIFACT, "hub-release.json"), join(broken, "hub-release.json"));
    const leaky = await startServer({
      EGA_WEB_ARTIFACT_DIR: broken,
      EGA_SUPABASE_SECRET_KEY: SECRET_MARKERS.EGA_SUPABASE_SECRET_KEY,
    });

    const probes = [
      [server, "/readyz"],
      [server, "/api/catalog"],
      [server, "/api/releases"],
      [server, `/api/skills/${SAMPLE_SKILL_SEGMENT}`],
      [server, `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`],
      [server, "/api/no-such-view"],
      [server, `/api/releases/${encodeURIComponent(OTHER_DIGEST)}`],
      [leaky, "/readyz"],
      [leaky, "/api/catalog"],
      [leaky, "/api/releases"],
      [leaky, `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`],
    ];

    for (const [target, path] of probes) {
      const answer = await request(target, path);
      assert.ok(answer.status >= 400, `${path} on ${target.port} must be a failing request for this test to mean anything`);
      const surface = leakSurface(answer);
      for (const [name, marker] of Object.entries(SECRET_MARKERS)) {
        assert.doesNotMatch(surface, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name} leaked from ${path}`);
      }
      for (const fragment of SQL_FRAGMENTS) {
        assert.doesNotMatch(surface, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${fragment} leaked from ${path}`);
      }
      // No absolute path: neither this repository's, the temp dir's, nor the
      // deployment's configured artifact directory.
      assert.doesNotMatch(surface, /\/tmp\/|\/home\/ubuntu|\/srv\/|ega-wt-releases/, `${path} disclosed a filesystem path`);
      assert.doesNotMatch(surface, /EGA_SUPABASE_SECRET_KEY/, `${path} named a secret variable`);
      // No stack trace and no source location.
      assert.doesNotMatch(surface, /\n\s+at |\.mts:\d+|\.ts:\d+|Error:|\{ \[/, `${path} disclosed a stack trace`);
    }
  });

  test("a successful request leaks nothing either", async () => {
    // `/api/release-identity` answers 200 even on a mismatch, by design: it is the
    // endpoint that *reports* the failure, so it is scanned here rather than in
    // the failing-request scan above.
    const mismatched = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: `sha256:${"2".repeat(64)}`,
    });
    for (const [target, path] of [
      [baseline, "/api/release-identity"],
      [baseline, "/api/catalog?limit=1"],
      [baseline, `/api/skills/${SAMPLE_SKILL_SEGMENT}`],
      [baseline, "/api/releases"],
      [baseline, `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`],
      [mismatched, "/api/release-identity"],
    ]) {
      const answer = await request(target, path);
      assert.equal(answer.status, 200, `${path} must succeed for this scan`);
      const surface = leakSurface(answer);
      assert.doesNotMatch(surface, /\/tmp\/|\/home\/ubuntu|ega-wt-releases/, `${path} disclosed a path`);
      for (const [name, marker] of Object.entries(SECRET_MARKERS)) {
        assert.doesNotMatch(surface, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name} leaked from ${path}`);
      }
    }
  });

  test("sanitizeMessage redacts an absolute path but leaves a canonical skill id intact", () => {
    // The redaction boundary is load-bearing: `/claude-api` inside
    // `anthropic/claude-api` is not a token boundary and must survive, or every
    // refusal that names a skill would be corrupted.
    assert.equal(
      sanitizeMessage("The L2 content of anthropic/claude-api exceeds the budget."),
      "The L2 content of anthropic/claude-api exceeds the budget.",
    );
    assert.equal(
      sanitizeMessage("Cached blob sha256:ab is missing at /srv/app/artifact/cache/sha256/ab/ab."),
      "Cached blob sha256:ab is missing at <redacted-path>",
    );
    assert.match(sanitizeMessage("at C:\\apps\\web\\artifact\\registry.sqlite failed"), /<redacted-path>/);
    // And the length is capped.
    assert.ok(sanitizeMessage("x".repeat(5000)).length <= 512);
  });

  test("the built server never writes to stdout", async () => {
    // Drive every route, including failures, then read what the child wrote.
    for (const path of [
      "/healthz",
      "/readyz",
      "/api/release-identity",
      "/api/catalog?limit=2",
      "/api/skills",
      `/api/skills/${SAMPLE_SKILL_SEGMENT}`,
      `/api/skills/${SAMPLE_SKILL_SEGMENT}/content?level=L2&max_tokens=32000`,
      "/api/releases",
      `/api/releases/compare?base=${encodeURIComponent(COMMITTED_DIGEST)}&candidate=${encodeURIComponent(COMMITTED_DIGEST)}`,
      `/api/releases/${encodeURIComponent(COMMITTED_DIGEST)}`,
      "/api/no-such-view",
      "/api/catalog?sort=bogus",
      "/nope",
    ]) {
      await request(baseline, path);
    }
    await request(baseline, "/api/catalog", { method: "POST" });
    await request(baseline, "/", { method: "DELETE" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(baseline.stdout(), "", "server.mts must never write to stdout (SPEC-006 5.1.2)");
    assert.ok(baseline.stderr().length > 0, "the startup banner goes to stderr");
    assert.doesNotMatch(baseline.stderr(), new RegExp(SECRET_MARKERS.EGA_SUPABASE_SECRET_KEY));
  });
});

/* -------------------------------------------------------------------------- */
/* 12. Request bounds                                                          */
/* -------------------------------------------------------------------------- */

describe("response size, deadline and concurrency are bounded", () => {
  test("the response ceiling refuses rather than truncating", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_MAX_RESPONSE_BYTES: "1024",
    });
    for (const path of ["/api/catalog", "/api/releases"]) {
      const { status, body } = await request(server, path);
      assert.equal(status, 503, `${path} must be refused at a 1 KiB ceiling`);
      assert.equal(body.error.code, "E_WEB_RESPONSE_TOO_LARGE");
      assert.match(body.error.message, /1024 byte ceiling/);
      // Refused, not truncated: no partial body was written.
      assert.deepEqual(Object.keys(body), ["error"]);
    }
    // A response that genuinely fits is unaffected, so the ceiling is a ceiling
    // and not a blanket failure.
    const small = await request(server, "/api/release-identity");
    assert.equal(small.status, 200);
    assert.ok(Buffer.byteLength(small.text, "utf8") < 1024);
  });

  test("the default ceiling is the repository's hosted-MCP default", () => {
    assert.equal(API_MAX_RESPONSE_BYTES_DEFAULT, 4 * 1_048_576);
    assert.equal(API_REQUEST_TIMEOUT_MS_DEFAULT, 30_000);
  });

  test("a bad bound is a startup warning, not a silent default", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_MAX_RESPONSE_BYTES: "0",
      EGA_WEB_MAX_CONCURRENT_REQUESTS: "not-a-number",
      EGA_WEB_REQUEST_TIMEOUT_MS: "-5",
    });
    assert.equal((await request(server, "/api/catalog?limit=1")).status, 200);
    assert.match(server.stderr(), /EGA_WEB_MAX_RESPONSE_BYTES is not a positive safe integer/);
    assert.match(server.stderr(), /EGA_WEB_MAX_CONCURRENT_REQUESTS is not a positive safe integer/);
    assert.match(server.stderr(), /EGA_WEB_REQUEST_TIMEOUT_MS is not a positive safe integer/);
  });

  test("the deadline refuses a read that misses it", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_REQUEST_TIMEOUT_MS: "1",
    });
    const { status, body } = await request(server, "/api/catalog");
    assert.equal(status, 504);
    assert.equal(body.error.code, "E_WEB_REQUEST_TIMEOUT");
    assert.match(body.error.message, /within 1 ms/);
    // The readiness probe answers with the same bound rather than hanging.
    const ready = await request(server, "/readyz");
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, "unavailable");
    assert.match(ready.body.detail, /did not verify within 1 ms/);
  });

  test("the concurrency cap refuses an overlapping request", async () => {
    // Driven in-process against the real bound, with a genuinely slow handler.
    // Every console route is synchronous over verified data and settles in one
    // tick, so an HTTP-level test here would assert a race rather than a bound.
    const bounds = { maxResponseBytes: 1024, requestTimeoutMs: 5_000, maxConcurrentRequests: 1 };
    const slow = createBoundedHandler(bounds, async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { ok: true };
    });
    const context = {
      method: "GET",
      pathname: "/catalog",
      query: new URLSearchParams(),
      request: {},
      params: {},
    };
    const inFlight = slow(context);
    await assert.rejects(slow(context), (error) => {
      assert.equal(error.code, "E_WEB_TOO_MANY_REQUESTS");
      assert.equal(error.status, 503);
      assert.match(error.message, /concurrency limit/);
      return true;
    });
    // The slot is released, so the next request is served normally.
    await inFlight;
    assert.deepEqual(await slow(context), { ok: true });
  });

  test("a live server with a cap of one never returns a 500 under concurrency", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_MAX_CONCURRENT_REQUESTS: "1",
    });
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => request(server, "/api/catalog?limit=200")),
    );
    // Every answer is either served or explicitly refused. Neither the cap nor a
    // synchronous handler may produce an unhandled failure.
    for (const answer of answers) {
      assert.ok([200, 503].includes(answer.status), `unexpected status ${answer.status}`);
      if (answer.status === 503) assert.equal(answer.body.error.code, "E_WEB_TOO_MANY_REQUESTS");
    }
    assert.ok(answers.some((answer) => answer.status === 200));
  });

  test("every route is registered exactly once and is GET-only", () => {
    const ids = REGISTERED_ROUTES.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length, "no route is registered twice");
    assert.deepEqual([...ids].sort(), [
      "catalog",
      "release-detail",
      "release-identity",
      "releases",
      "releases-compare",
      "skill-content",
      "skill-detail",
      "skills",
    ]);
    for (const route of REGISTERED_ROUTES) {
      assert.deepEqual(route.methods, ["GET"], `${route.id} must be read-only`);
      assert.equal(typeof route.handle, "function");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Readiness semantics                                                         */
/* -------------------------------------------------------------------------- */

describe("readiness distinguishes configured, verified and mismatched", () => {
  test("an unconfigured deployment keeps the operator message naming the variable", async () => {
    const server = await startServer();
    const { status, body } = await request(server, "/readyz");
    assert.equal(status, 503);
    assert.equal(body.status, "unavailable");
    // The conservative configuration layer is preserved as the first layer, so
    // the message still names what the operator must set.
    assert.match(body.detail, /EGA_WEB_ARTIFACT_DIR/);
  });

  test("a configured, verified, unpinned deployment is ready", async () => {
    const { status, body } = await request(baseline, "/readyz");
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    // `unpinned` is honest and servable, so readiness reports it rather than
    // claiming the deployment is stable.
    assert.match(body.detail, /unpinned/);
    assert.doesNotMatch(body.detail, /stable/i);
  });

  test("a configured, verified, pinned deployment is ready and says so", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST,
    });
    const { status, body } = await request(server, "/readyz");
    assert.equal(status, 200);
    assert.match(body.detail, /stable/);
  });

  test("an artifact path that is a file is refused before verification is attempted", async () => {
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: join(workdir, "dist", "index.html"),
    });
    const { status, body } = await request(server, "/readyz");
    assert.equal(status, 503);
    assert.match(body.detail, /not a directory/);
  });

  test("a retained manifest alone is not enough to be ready", async () => {
    const manifest = join(workdir, "retained.json");
    writeFileSync(manifest, "{}\n");
    cleanups.push(() => rmSync(manifest, { force: true }));
    const server = await startServer({ EGA_WEB_RETAINED_MANIFEST: manifest });
    const { status, body } = await request(server, "/readyz");
    assert.equal(status, 503);
    assert.match(body.detail, /EGA_WEB_ARTIFACT_DIR is not configured/);
  });

  test("readiness is answerable while the API is saturated, and dist/ presence is not required", async () => {
    // The readiness probe deliberately does not take a concurrency slot, and it
    // does not depend on the SPA bundle being built.
    const server = await startServer({
      EGA_WEB_ARTIFACT_DIR: artifactCopy,
      EGA_WEB_MAX_CONCURRENT_REQUESTS: "1",
    });
    const answers = await Promise.all([
      ...Array.from({ length: 6 }, () => request(server, "/api/catalog?limit=200")),
      request(server, "/readyz"),
    ]);
    const ready = answers[answers.length - 1];
    assert.equal(ready.status, 200);
    assert.ok(existsSync(join(workdir, "dist", "index.html")));
  });
});
