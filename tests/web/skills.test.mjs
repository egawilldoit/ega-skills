/**
 * Skill detail and on-demand content.
 *
 * ## The fixture is the real release
 *
 * Every assertion here reads the REAL committed artifact (`packages/mcp/
 * artifact`, the verified 114-skill release, digest `sha256:1efdbc3d…31b77`).
 * Nothing is mocked: `loadHostedReleaseSnapshot` runs its full verification, the
 * SQLite file is opened read-only with `query_only` enforced, and both the
 * metadata join and the content read go through the real MCP tools
 * (`runInspectTool`, `runGetContentTool`).
 *
 * Where a test needs a different artifact it copies to a temp directory and
 * mutates THE COPY. A module-level digest of every committed artifact file is
 * taken before the first test and re-checked in `after`, so "the committed
 * artifact is never mutated" is asserted rather than assumed — a write here
 * would silently corrupt the repository's own fixtures for every other suite.
 *
 * ## What is asserted about a sparse release
 *
 * The shipped release is genuinely sparse and these tests assert the real values
 * rather than convenient ones:
 *
 * - `l1_status` is `MISSING` for all 114 skills. There are no `core`-role files
 *   in the artifact (`SELECT DISTINCT role FROM skill_files` returns
 *   `other, skill-body, ega-metadata, script, asset, reference` and no `core`),
 *   so `SKILL.core.md` was never authored and **L1 content genuinely does not
 *   exist**. A request for L1 must produce the deterministic missing-level error,
 *   never an empty string, a zero, or a fabricated body.
 * - `skill_versions` holds exactly 114 rows for 114 distinct skills: one version
 *   per skill, so **no history exists to show**. And the table has no timestamp
 *   column at all, so there is no real date to report either.
 * - `trust_level` is `UNKNOWN` and `source_type` is `local` with null repository
 *   and commit sha for all 114, so no adopted source revision exists.
 *
 * If a future release changes any of these, the failure is a fact about the
 * release and must be investigated, not papered over by loosening the assertion.
 *
 * ## Content protection is asserted behaviourally
 *
 * Nothing here tests this module's own guards in isolation; each case drives
 * `getSkillContent` end to end and asserts the observable refusal. The
 * protections being proven are `runGetContentTool`'s (exact manifest-path
 * equality, `FORBIDDEN_FILE_ROLES`, BINARY refusal, hash-verified reads, the
 * per-call `max_tokens` bound, and no truncation) — reusing it unchanged is the
 * security requirement, so the tests pin the behaviour it provides rather than
 * re-deriving it.
 *
 * ## The eight control files
 *
 * `hub-release.json`, `release-package.json`, `candidate.json`,
 * `token-artifact.json`, `alias-map.json`, `search-index-input.json`,
 * `release-diff.json` and `publication-preflight.json` sit in the artifact
 * directory and are NOT manifest entries, so exact manifest-path equality makes
 * them unreachable through the content path. Each is driven as a `file_path`
 * request and asserted refused. The per-file proof is the real one; the aggregate
 * is asserted too so a future change that made one reachable would name it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";

import { loadHostedReleaseSnapshot, openReadOnlyRegistry } from "../../packages/mcp/dist/index.js";
import { getCacheBlob } from "../../packages/registry/dist/index.js";

import { parseServerConfig } from "../../apps/web/server/env.ts";
import { closeRegistry, createRegistryReader } from "../../apps/web/server/registry.ts";
import {
  GET_CONTENT_MAX_TOKENS_MAX,
  GET_CONTENT_MAX_TOKENS_MIN,
  SKILL_CONTENT_DEFAULT_MAX_TOKENS,
  SKILL_CONTENT_LEVELS,
  SKILL_ID_MAX_LENGTH,
  SkillReadError,
  getSkillContent,
  getSkillDetail,
} from "../../apps/web/server/skills.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");

/** The committed release's real facts, read from the package, never hardcoded. */
const COMMITTED_PACKAGE = JSON.parse(readFileSync(join(ARTIFACT, "release-package.json"), "utf8"));
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;
const COMMITTED_RELEASE = JSON.parse(readFileSync(join(ARTIFACT, "hub-release.json"), "utf8"));
const COMMITTED_SKILL_IDS = Object.keys(COMMITTED_RELEASE.payload.skill_versions).sort();

/** The skill the brief names, and its real released version. */
const KNOWN = "anthropic/academy-guide";
const KNOWN_VERSION = COMMITTED_RELEASE.payload.skill_versions[KNOWN];

/** A different but syntactically valid digest, for the mismatch and 404 cases. */
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

/**
 * The eight artifact control files.
 *
 * Named explicitly rather than globbed, so a file added to the artifact
 * directory later cannot silently fall outside the coverage.
 */
const CONTROL_FILES = [
  "hub-release.json",
  "release-package.json",
  "candidate.json",
  "token-artifact.json",
  "alias-map.json",
  "search-index-input.json",
  "release-diff.json",
  "publication-preflight.json",
];

function committedConfig(extraEnv = {}) {
  return parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT, ...extraEnv });
}

/**
 * better-sqlite3 resolved through the workspace member that declares it.
 *
 * The console does not depend on it directly — it goes through
 * `@ega-skills/registry` — so a test that needs to manufacture an impossible
 * snapshot resolves it where it is actually installed, the same way
 * `catalog.test.mjs:407-410` does.
 */
async function loadBetterSqlite3() {
  const imported = await import("../../packages/registry/node_modules/better-sqlite3/lib/index.js");
  return imported.default?.default ?? imported.default;
}

/**
 * The on-disk path of a cached blob.
 *
 * The cache is sharded by the first two hex characters
 * (`cacheBlobPath`, `packages/registry/src/cache.ts:56-64`), so a blob is at
 * `cache/sha256/<xx>/<remaining 62 hex>` — not directly under `sha256/`. The
 * sharded function itself is used, so a layout change is a one-line fix here
 * rather than a silent test failure.
 */
function blobPathIn(artifactDir, blobHash) {
  const hex = blobHash.replace(/^sha256:/, "");
  return join(artifactDir, "cache", "sha256", hex.slice(0, 2), hex.slice(2));
}

/* -------------------------------------------------------------------------- */
/* Committed-artifact integrity, checked before and after the run              */
/* -------------------------------------------------------------------------- */

function digestEveryFile(dir) {
  const digests = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        digests.set(full.slice(ARTIFACT.length), createHash("sha256").update(readFileSync(full)).digest("hex"));
      }
    }
  };
  walk(dir);
  return digests;
}

const ARTIFACT_DIGESTS_BEFORE = digestEveryFile(ARTIFACT);

const tempDirs = [];
function copyArtifact(label) {
  const dir = mkdtempSync(join(tmpdir(), `ega-web-skills-${label}-`));
  cpSync(ARTIFACT, dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

after(() => {
  closeRegistry();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  const afterDigests = digestEveryFile(ARTIFACT);
  assert.equal(afterDigests.size, ARTIFACT_DIGESTS_BEFORE.size, "the committed artifact gained or lost files");
  for (const [relative, digest] of ARTIFACT_DIGESTS_BEFORE) {
    assert.equal(afterDigests.get(relative), digest, `the committed artifact file ${relative} was modified`);
  }
});

/**
 * Every `SkillReadError` carries the HTTP status a route should use, so no route
 * mapping logic is needed. Assert the mapping on a representative refusal of each
 * class rather than trusting the constructors.
 */
/**
 * Assert a refusal: a typed error carrying the expected `code` and HTTP `status`.
 *
 * Deliberately duck-typed rather than `instanceof SkillReadError`. The
 * release-identity refusals (`E_WEB_RELEASE_UNVERIFIED`, `E_WEB_RELEASE_MISMATCH`)
 * come from `./release-identity.ts` and are propagated **unchanged** — this
 * module does not re-wrap them — so they arrive as `ReleaseIdentityError`. The
 * point of the shared `code`/`status` shape is that a route needs no mapping
 * logic regardless of which module refused; this asserts that property.
 * `assertValidationRefusal` below is the strict variant for this module's own
 * guards.
 */
function assertRefusal(fn, { code, status }, note) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(
    thrown !== undefined && typeof thrown === "object",
    `${note ?? code}: expected a thrown error, got ${thrown === undefined ? "no throw" : String(thrown)}`,
  );
  assert.equal(typeof thrown.status, "number", `${code} must carry an HTTP status`);
  assert.equal(thrown.status, status, `${note ?? ""} expected status ${status} for ${code}, got ${thrown.status}`);
  // Sanitization is asserted where this module is responsible for it, i.e. for
  // the messages IT composes. The release-identity refusals are propagated
  // unchanged from `./release-identity.ts` and are asserted there instead; see
  // the "known upstream leak" test in section 5.
  if (thrown instanceof SkillReadError) {
    assert.doesNotMatch(
      thrown.message,
      /\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/i,
      `message leaked SQL text: ${thrown.message}`,
    );
    assert.doesNotMatch(thrown.message, /\/(home|tmp|var|etc|usr)\//, `message leaked an absolute path: ${thrown.message}`);
    assert.doesNotMatch(thrown.message, /\bat \w+ \(/, `message leaked a stack frame: ${thrown.message}`);
  }
  return thrown;
}

/**
 * The strict variant: the refusal must be this module's own `SkillReadError`,
 * not merely something carrying a code. Used for the input guards.
 */
function assertValidationRefusal(fn, { code, status }, note) {
  const thrown = assertRefusal(fn, { code, status }, note);
  assert.ok(
    thrown instanceof SkillReadError,
    `${note ?? code}: expected a SkillReadError from skills.ts, got ${thrown.constructor.name}`,
  );
  return thrown;
}

/* -------------------------------------------------------------------------- */
/* 1. Detail is correct for anthropic/academy-guide                            */
/* -------------------------------------------------------------------------- */

describe("detail is correct for the named skill", () => {
  const detail = getSkillDetail(committedConfig(), KNOWN);

  test("identity, namespace, name and version hash are the real ones", () => {
    assert.equal(detail.summary.skill_id, KNOWN);
    assert.equal(detail.summary.namespace, "anthropic");
    assert.equal(detail.summary.name, "academy-guide");
    assert.equal(detail.summary.namespace + "/" + detail.summary.name, KNOWN);
    // The version the RELEASE pins, cross-checked three ways.
    assert.equal(detail.summary.version_hash, KNOWN_VERSION);
    assert.equal(detail.summary.version_hash, COMMITTED_RELEASE.payload.skill_versions[KNOWN]);
    assert.match(detail.summary.version_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(detail.summary.schema_version, 1);
    assert.equal(detail.summary.description.length > 0, true);
  });

  test("L1 status is the real MISSING, and L2 tokens are a real count", () => {
    // The genuine shipped value, asserted as a fact about the release.
    assert.equal(detail.summary.l1_status, "MISSING");
    assert.equal(detail.content.l1_status, "MISSING");
    assert.equal(detail.content.l1_available, false);
    assert.equal(detail.content.l1_unavailable_reason !== null, true);
    // l1_tokens is null, never 0: a zero would read as a measurement.
    assert.equal(detail.summary.l1_tokens, null);
    // L2 really exists and its recorded count is real.
    assert.equal(typeof detail.summary.l2_tokens, "number");
    assert.ok(detail.summary.l2_tokens > 0);
    assert.equal(detail.content.l2_available, true);
    assert.equal(detail.content.token_estimator_id, "ega-o200k-v1");
  });

  test("there are genuinely no core-role files, which is why L1 is MISSING", () => {
    // Proves the MISSING is a property of the release, not a bug in this module.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      const roles = handle.db.prepare("SELECT DISTINCT role FROM skill_files").all().map((row) => row.role);
      assert.equal(roles.includes("core"), false, `expected no core-role file, found ${JSON.stringify(roles)}`);
      const authored = handle.db.prepare("SELECT count(*) AS n FROM skill_versions WHERE l1_status = 'AUTHORED'").get();
      assert.equal(authored.n, 0, "expected zero AUTHORED L1 rows");
    } finally {
      handle.close();
    }
  });

  test("source type is local and trust level is UNKNOWN", () => {
    assert.equal(detail.summary.source_type, "local");
    assert.equal(detail.summary.provenance_status, "local-only");
    assert.equal(detail.trust_level, "UNKNOWN");
    assert.equal(detail.source_repository, null);
    assert.equal(detail.source_commit_sha, null);
    assert.equal(detail.observed_source_revision, null);
  });

  test("the real source observation is carried without inventing a revision", () => {
    // `sources` describes an adopted source REVISION, which no released skill
    // has. It is empty with a reason, and the actual observation is still
    // reported — suppressing it would hide a fact the release does record.
    assert.equal(detail.sources.length, 0);
    assert.equal(detail.sources_unavailable_reason !== null, true);
    assert.ok(detail.source_observations.length > 0);
    const observation = detail.source_observations[0];
    assert.equal(observation.source_type, "local");
    assert.equal(observation.repository, null);
    assert.equal(observation.commit_sha, null);
    // A real stored observation instant, never a generated one.
    assert.match(observation.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("files are the real manifest entries with real digests", () => {
    assert.deepEqual(
      detail.files.map((file) => file.path),
      ["LICENSE.txt", "SKILL.md"],
    );
    const body = detail.files.find((file) => file.path === "SKILL.md");
    assert.ok(body, "SKILL.md must be in the file list");
    assert.equal(body.content_digest, detail.summary.content_digest, "content_digest must agree with the file list");
    assert.equal(body.byte_length, 7755);
    // Every declared digest is canonical and no path is absolute or traversing.
    for (const file of detail.files) {
      assert.match(file.content_digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(pathIsCanonicalRelative(file.path), true, `${file.path} must be a relative POSIX path`);
    }
  });

  test("release identity is carried and is honest about being unpinned", () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    assert.equal(detail.release.release_digest, snapshot.release.digest);
    assert.equal(detail.release.release_digest, COMMITTED_DIGEST);
    assert.equal(detail.release.hub_id, COMMITTED_RELEASE.payload.hub_id);
    assert.equal(detail.release.status, "unpinned");
    assert.equal(detail.release.mismatch_reason, null);
    // Never null: an unservable release throws rather than degrading.
    assert.notEqual(detail.release, null);
  });

  test("the payload satisfies the shared SkillSummary contract", () => {
    for (const field of [
      "skill_id", "name", "description", "domains", "frameworks", "platforms",
      "triggers", "version_hash", "l1_status", "l1_tokens", "l2_tokens",
      "source_type", "provenance_status", "schema_version", "content_digest",
    ]) {
      assert.notEqual(detail.summary[field], undefined, `SkillSummary.${field} must be present`);
    }
  });

  test("anti-triggers come from the manifest where it has them", () => {
    // The named skill genuinely carries none, and that must be reported as empty
    // rather than filled from some other source.
    assert.deepEqual([...detail.routing.anti_triggers], []);
    // A skill that does carry them must surface them from the manifest. No FTS
    // table has an anti_triggers column at all, so this data is only reachable
    // by reading the manifest.
    const withAnti = getSkillDetail(committedConfig(), "anthropic/claude-api");
    assert.equal(withAnti.routing.anti_triggers.length, 9, "anthropic/claude-api carries 9 anti_triggers");
    assert.equal(
      withAnti.routing.anti_triggers.every((value) => typeof value === "string" && value.length > 0),
      true,
    );
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      for (const table of [snapshot.ftsTable, "skill_fts"]) {
        const columns = handle.db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((row) => row.name);
        assert.equal(columns.includes("anti_triggers"), false, `${table} unexpectedly has an anti_triggers column`);
      }
    } finally {
      handle.close();
    }
  });

  test("every released skill's detail resolves without error", () => {
    // Proves no skill needs a manufactured path, and that 114 of 114 agree on
    // the honest sparse facts.
    let missingL1 = 0;
    let localSources = 0;
    for (const skillId of COMMITTED_SKILL_IDS) {
      const each = getSkillDetail(committedConfig(), skillId);
      assert.equal(each.summary.skill_id, skillId);
      assert.equal(each.summary.version_hash, COMMITTED_RELEASE.payload.skill_versions[skillId]);
      if (each.content.l1_available === false) missingL1 += 1;
      if (each.summary.source_type === "local") localSources += 1;
    }
    assert.equal(missingL1, 114, "L1 is genuinely unavailable for all 114 released skills");
    assert.equal(localSources, 114, "source_type is local for all 114 released skills");
  });

  test("routing reports the DTO fields the manifest cannot supply, with a reason", () => {
    // `exclude_patterns` and `priority` are not fields of the canonical manifest.
    // The DTO declares them, so they are present with their declared absent
    // representation, and the reason says why they cannot be read as "checked
    // and found none".
    assert.deepEqual([...detail.routing.exclude_patterns], []);
    assert.equal(detail.routing.priority, null);
    assert.equal(detail.routing.unavailable_fields_reason !== null, true);
    // The four facets the manifest does carry are read from it.
    assert.ok(Array.isArray(detail.routing.domains));
    assert.ok(Array.isArray(detail.routing.frameworks));
    assert.ok(Array.isArray(detail.routing.platforms));
    assert.ok(Array.isArray(detail.routing.anti_triggers));
    assert.ok(Array.isArray(detail.routing.aliases));
  });
});

/** A relative POSIX path with no `.` or `..` segment and no leading `/`. */
function pathIsCanonicalRelative(path) {
  if (path === "" || path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/* -------------------------------------------------------------------------- */
/* 2. The detail payload carries no body                                        */
/* -------------------------------------------------------------------------- */

describe("detail carries no body", () => {
  test("no released skill's L2 text appears anywhere in its detail payload", () => {
    // The real risk is the skill's own SKILL.md. Read it from the committed
    // artifact through the hash-verified cache reader, take a distinctive chunk
    // of its prose, and prove that chunk is absent from the serialized detail.
    const detail = getSkillDetail(committedConfig(), KNOWN);
    const bodyDigest = detail.summary.content_digest;
    const bytes = getCacheBlob(join(ARTIFACT, "cache", "sha256"), bodyDigest);
    const body = new TextDecoder().decode(bytes);
    const fingerprint = body.split("\n").filter((line) => line.trim().length > 40)[0];
    assert.ok(fingerprint !== undefined, "expected a distinctive line in the body");
    assert.equal(JSON.stringify(detail).includes(fingerprint), false, "detail leaked the L2 body");

    // And structurally: the whole artifact's blob cache for THIS skill contains
    // exactly one retrievable body, and neither it nor its digest-as-content is
    // a field of the payload.
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes(body), false, "detail contained the whole body");
  });

  test("no payload field is a body: the declared shape has no content field", () => {
    const detail = getSkillDetail(committedConfig(), KNOWN);
    // `content` here is the AVAILABILITY block, not a body. Prove it carries no
    // prose: every one of its values is a status, a count, a reason, or null.
    const availability = detail.content;
    assert.equal(availability.retrieval, "on-demand");
    assert.equal(typeof availability.l2_tokens, "number");
    for (const [key, value] of Object.entries(availability)) {
      if (key.endsWith("_tokens") || key.endsWith("_status") || key.endsWith("_id") || key.endsWith("_class")) continue;
      if (key === "retrieval" || key === "l1_available" || key === "l2_available") continue;
      if (key.endsWith("_reason")) {
        assert.equal(typeof value, "string", `${key} must be a reason string or null`);
        continue;
      }
      assert.fail(`unexpected field on the content availability block: ${key}`);
    }
  });

  test("content is retrievable but never pre-loaded into the detail", () => {
    const before = getSkillDetail(committedConfig(), KNOWN);
    const body = getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2" });
    const after = getSkillDetail(committedConfig(), KNOWN);
    // The detail is unchanged by having read content: it is a pure metadata read.
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    assert.equal(JSON.stringify(before).includes(body.content), false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Content is on demand and byte-identical to the released blob             */
/* -------------------------------------------------------------------------- */

describe("content is on demand", () => {
  test("L2 content is byte-identical to the released blob", () => {
    const detail = getSkillDetail(committedConfig(), KNOWN);
    const body = getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2" });
    // Identity fields echo what was asked for, and the digest is the one the
    // release pins.
    assert.equal(body.skill_id, KNOWN);
    assert.equal(body.version_hash, detail.summary.version_hash);
    assert.equal(body.level, "L2");
    assert.equal(body.token_count, detail.summary.l2_tokens);
    assert.equal(body.truncated, false);
    assert.equal(body.requested_max_tokens, SKILL_CONTENT_DEFAULT_MAX_TOKENS);

    // Byte-identical to what the hash-verified cache reader yields.
    const bytes = getCacheBlob(join(ARTIFACT, "cache", "sha256"), detail.summary.content_digest);
    const expected = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(body.content, expected, "L2 content must be byte-identical to the released blob");
    assert.equal(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      detail.summary.content_digest,
      "the returned bytes must hash to the digest the release declares",
    );
  });

  test("an explicit version hash selects the same bytes, and any other version is refused", () => {
    const released = COMMITTED_RELEASE.payload.skill_versions[KNOWN];
    const explicit = getSkillContent(committedConfig(), {
      skillId: KNOWN,
      versionHash: released,
      level: "L2",
    });
    assert.equal(explicit.content, getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2" }).content);
    // A well-formed digest that this release does not pin is a 404, not a
    // silent substitution.
    assertRefusal(
      () => getSkillContent(committedConfig(), { skillId: KNOWN, versionHash: OTHER_DIGEST, level: "L2" }),
      { code: "E_WEB_SKILL_VERSION_NOT_RELEASED", status: 404 },
    );
    // A malformed digest is invalid input, a different fact.
    assertRefusal(
      () => getSkillContent(committedConfig(), { skillId: KNOWN, versionHash: "sha256:zzz", level: "L2" }),
      { code: "E_WEB_CONTENT_VERSION_INVALID", status: 400 },
    );
  });

  test("a retrievable TEXT companion file is served by exact manifest path", () => {
    // `LICENSE.txt` is role `other` and TEXT, so it is genuinely retrievable.
    // This proves the protection is discriminating rather than a blanket denial.
    const companion = getSkillContent(committedConfig(), {
      skillId: KNOWN,
      level: "L2",
      filePath: "LICENSE.txt",
    });
    assert.equal(companion.file_path, "LICENSE.txt");
    assert.equal(typeof companion.content, "string");
    assert.ok(companion.content.length > 0);
    assert.equal(companion.truncated, false);
  });

  test("file_path requires level L2", () => {
    assertRefusal(
      () => getSkillContent(committedConfig(), { skillId: KNOWN, level: "L1", filePath: "LICENSE.txt" }),
      { code: "E_WEB_CONTENT_FILE_PATH_INVALID", status: 400 },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. L1 is honestly unavailable                                                */
/* -------------------------------------------------------------------------- */

describe("L1 is honestly unavailable", () => {
  test("requesting L1 returns the deterministic missing-level error", () => {
    const error = assertRefusal(
      () => getSkillContent(committedConfig(), { skillId: KNOWN, level: "L1" }),
      { code: "E_WEB_CONTENT_LEVEL_MISSING", status: 409 },
    );
    // The message names the fact, not a placeholder.
    assert.match(error.message, /no L1 content/i);
    assert.match(error.message, /MISSING/);
  });

  test("L1 is refused for every released skill, never answered with a body", () => {
    // Not a one-skill accident: all 114 lack a core-role file.
    for (const skillId of COMMITTED_SKILL_IDS) {
      let thrown;
      try {
        getSkillContent(committedConfig(), { skillId: skillId, level: "L1" });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof SkillReadError, `${skillId} returned L1 content; it must not`);
      assert.equal(thrown.code, "E_WEB_CONTENT_LEVEL_MISSING", `${skillId} wrong code`);
    }
  });

  test("the refusal is a class, not a string, and never an empty success", () => {
    // Guards against a future "return an empty body for an absent level".
    let result;
    try {
      result = getSkillContent(committedConfig(), { skillId: KNOWN, level: "L1" });
    } catch {
      result = undefined;
    }
    assert.equal(result, undefined, "L1 must throw rather than return a payload");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Protected content is not exposed                                         */
/* -------------------------------------------------------------------------- */

describe("protected content is not exposed", () => {
  const CONFIG = committedConfig();

  test("a script-role path is refused", () => {
    // anthropic/mcp-builder ships real script-role files.
    assertRefusal(
      () => getSkillContent(CONFIG, { skillId: "anthropic/mcp-builder", level: "L2", filePath: "scripts/connections.py" }),
      { code: "E_WEB_CONTENT_FILE_FORBIDDEN", status: 400 },
    );
  });

  test("an asset-role path is refused", () => {
    // anthropic/skill-creator ships exactly one asset-role file in the release.
    assertRefusal(
      () => getSkillContent(CONFIG, { skillId: "anthropic/skill-creator", level: "L2", filePath: "assets/eval_review.html" }),
      { code: "E_WEB_CONTENT_FILE_FORBIDDEN", status: 400 },
    );
  });

  test("an ega-metadata-role path is refused as an unknown path", () => {
    // `ega.yaml` is refused TWICE OVER, and the tests pin both reasons
    // separately because they are independent:
    //   1. it is `ega-metadata` role, which is in FORBIDDEN_FILE_ROLES;
    //   2. it is NOT a manifest entry at all. `skill_files` records 73 `ega.yaml`
    //      rows that the canonical manifests deliberately exclude, so exact
    //      manifest-path equality rejects it before the role check is reached.
    // The observable result is the unknown-path refusal, because the manifest
    // lookup is what fails. Asserting the specific code is therefore not
    // cosmetic: it distinguishes "refused because it is metadata" from "refused
    // because it is not part of the released skill".
    assertRefusal(
      () => getSkillContent(CONFIG, { skillId: "anthropic/claude-api", level: "L2", filePath: "ega.yaml" }),
      { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
    );
  });

  test("a skill-body path is refused: use level, not file_path, for the body", () => {
    assertRefusal(
      () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: "SKILL.md" }),
      { code: "E_WEB_CONTENT_FILE_FORBIDDEN", status: 400 },
    );
  });

  test("a core-role path is refused", () => {
    // No released skill has a `core`-role file, so this asserts the rule rather
    // than a real entry: the shape that would be served if L1 existed.
    assertRefusal(
      () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: "SKILL.core.md" }),
      { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
    );
  });

  test("a BINARY path is refused", () => {
    // anthropic/canvas-design ships 57 BINARY files (role `other`); a BINARY
    // entry is refused even though its role is not forbidden.
    assertRefusal(
      () =>
        getSkillContent(CONFIG, {
          skillId: "anthropic/canvas-design",
          level: "L2",
          filePath: "canvas-fonts/ArsenalSC-Regular.ttf",
        }),
      { code: "E_WEB_CONTENT_FILE_FORBIDDEN", status: 400 },
    );
  });

  test("traversal shapes are refused", () => {
    const shapes = [
      "../SKILL.md",
      "../../etc/passwd",
      "scripts/../../SKILL.md",
      "..",
      "./SKILL.md",
      "reference/../SKILL.md",
      "LICENSE.txt/../SKILL.md",
    ];
    for (const filePath of shapes) {
      assertRefusal(
        () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: filePath }),
        { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
        `traversal shape ${filePath} must be refused`,
      );
    }
  });

  test("absolute paths are refused", () => {
    for (const filePath of [
      "/etc/passwd",
      "/SKILL.md",
      join(ARTIFACT, "hub-release.json"),
      join(ARTIFACT, "cache", "sha256"),
    ]) {
      assertRefusal(
        () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: filePath }),
        { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
        `absolute path ${filePath} must be refused`,
      );
    }
  });

  test("globs are refused", () => {
    for (const filePath of ["*", "**", "*.md", "scripts/*", "reference/**/*", "?.md", "[a-z]*.md"]) {
      assertRefusal(
        () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: filePath }),
        { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
        `glob ${filePath} must be refused`,
      );
    }
  });

  test("a directory path is refused", () => {
    // An empty path is refused as invalid input by this module; a directory-like
    // or trailing-slash path is a non-empty string that is simply not a manifest
    // entry, so it reaches the tool and comes back as an unknown path.
    assertValidationRefusal(
      () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: "" }),
      { code: "E_WEB_CONTENT_FILE_PATH_INVALID", status: 400 },
      "an empty file path is invalid input",
    );
    for (const filePath of ["reference", "scripts", "reference/", "./"]) {
      assertRefusal(
        () => getSkillContent(CONFIG, { skillId: KNOWN, level: "L2", filePath: filePath }),
        { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
        `directory path ${JSON.stringify(filePath)} must be refused`,
      );
    }
  });

  test("no forbidden-role file in the release is retrievable by any path", () => {
    // The exhaustive version, over every file the release actually records for
    // every skill. A forbidden-role manifest entry is refused by the role rule;
    // a file the manifest excludes is refused by the exact-equality rule. Both
    // are refusals, and neither ever returns content.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    const forbidden = new Set(["skill-body", "core", "ega-metadata", "script", "asset"]);
    let forbiddenRoleRefusals = 0;
    let notManifestRefusals = 0;
    try {
      const rows = handle.db
        .prepare(
          `SELECT f.skill_id AS skill_id, f.version_hash AS version_hash, f.path AS path, f.role AS role
             FROM skill_files f
             JOIN skill_versions v ON v.skill_id = f.skill_id AND v.version_hash = f.version_hash
            ORDER BY f.skill_id, f.path`,
        )
        .all();
      assert.ok(rows.length > 800, `expected the whole release, got ${rows.length} file rows`);
      for (const row of rows) {
        if (!forbidden.has(row.role)) continue;
        // Prove which rule refused it, rather than accepting either. A
        // `ega-metadata` row is absent from the manifest, so it is refused as an
        // unknown path; every other forbidden role IS a manifest entry and is
        // refused by the role rule.
        const manifestHasIt = JSON.parse(
          handle.db
            .prepare("SELECT manifest_json FROM skill_versions WHERE skill_id = ? AND version_hash = ?")
            .get(row.skill_id, row.version_hash).manifest_json,
        ).files.some((file) => file.path === row.path);
        if (manifestHasIt) {
          assertRefusal(
            () => getSkillContent(CONFIG, { skillId: row.skill_id, level: "L2", filePath: row.path }),
            { code: "E_WEB_CONTENT_FILE_FORBIDDEN", status: 400 },
            `${row.skill_id} ${row.path} (role ${row.role}) must be refused as a forbidden role`,
          );
          forbiddenRoleRefusals += 1;
        } else {
          assertRefusal(
            () => getSkillContent(CONFIG, { skillId: row.skill_id, level: "L2", filePath: row.path }),
            { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
            `${row.skill_id} ${row.path} must be refused as not a manifest entry`,
          );
          notManifestRefusals += 1;
        }
      }
    } finally {
      handle.close();
    }
    assert.equal(forbiddenRoleRefusals, 154, "39 script + 114 skill-body + 1 asset manifest entries");
    assert.equal(notManifestRefusals, 73, "the 73 registry-only ega.yaml rows");
  });

  test("a corrupt blob is refused before any content is served", () => {
    // The artifact copy's blob for SKILL.md is replaced with valid UTF-8 that
    // does NOT hash to the declared digest. Integrity must be checked before
    // bytes are exposed, so the request refuses rather than returning the
    // tampered text.
    const copy = copyArtifact("corrupt-blob");
    const detail = getSkillDetail(committedConfig(), KNOWN);
    const blobPath = blobPathIn(copy, detail.summary.content_digest);
    const original = readFileSync(blobPath);
    try {
      writeFileSync(blobPath, Buffer.from("# tampered\n", "utf8"));
      const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy });
      // Snapshot verification itself refuses first, which is the stronger
      // outcome: a blob that fails its hash check means the artifact is never
      // verified, so it is never served at all.
      assertRefusal(
        () => getSkillContent(config, { skillId: KNOWN, level: "L2" }),
        { code: "E_WEB_RELEASE_UNVERIFIED", status: 503 },
      );
      assertRefusal(
        () => getSkillDetail(config, KNOWN),
        { code: "E_WEB_RELEASE_UNVERIFIED", status: 503 },
      );
    } finally {
      writeFileSync(blobPath, original);
    }
  });

  test("the refusal is hash verification, not a decode failure", () => {
    // The tampered bytes above are valid UTF-8, so a module that checked
    // decodability but not the hash would have returned them. Prove the check
    // that fires is the digest check: the blob no longer hashes to its name.
    const copy = copyArtifact("corrupt-blob-hash");
    const detail = getSkillDetail(committedConfig(), KNOWN);
    const blobPath = blobPathIn(copy, detail.summary.content_digest);
    const tampered = Buffer.from("# tampered but perfectly decodable\n", "utf8");
    assert.notEqual(`sha256:${createHash("sha256").update(tampered).digest("hex")}`, detail.summary.content_digest);
    const original = readFileSync(blobPath);
    try {
      writeFileSync(blobPath, tampered);
      const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy });
      let thrown;
      try {
        getSkillContent(config, { skillId: KNOWN, level: "L2" });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown !== undefined);
      assert.equal(thrown.code, "E_WEB_RELEASE_UNVERIFIED");
      assert.equal(thrown.status, 503);
      // And the tampered bytes were never returned to anyone.
      assert.equal(typeof thrown.content, "undefined");
      assert.equal(JSON.stringify(thrown).includes("tampered"), false);
    } finally {
      writeFileSync(blobPath, original);
    }
  });

  test("FIXED UPSTREAM LEAK: the identity message no longer embeds an absolute path", () => {
    // This test previously DOCUMENTED a live defect and was written to fail once
    // the defect was fixed. The lead has now fixed it in
    // `describeLoadFailure` (`apps/web/server/release-identity.ts`), which
    // redacts absolute POSIX and Windows paths out of an upstream message while
    // preserving the blob digest and the error code, because those are what an
    // operator actually needs.
    //
    // `getCacheBlob` (`packages/registry/src/cache.ts`) still builds its message
    // with the absolute cache path inside it; the redaction happens at the web
    // boundary, which is the correct place for it. So this test now asserts the
    // boundary holds.
    //
    // Verified end-to-end before the fix: a blob hash failure produced
    // "Cached blob sha256:ab.. is missing at /tmp/.../cache/sha256/ab/ab..".
    const copy = copyArtifact("known-upstream-leak-fixed");
    const detail = getSkillDetail(committedConfig(), KNOWN);
    const blobPath = blobPathIn(copy, detail.summary.content_digest);
    const original = readFileSync(blobPath);
    let thrown;
    try {
      writeFileSync(blobPath, Buffer.from("# tampered\n", "utf8"));
      const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy });
      try {
        getSkillContent(config, { skillId: KNOWN, level: "L2" });
      } catch (error) {
        thrown = error;
      }
    } finally {
      writeFileSync(blobPath, original);
    }
    assert.ok(thrown !== undefined);
    assert.equal(thrown.code, "E_WEB_RELEASE_UNVERIFIED");
    // The operator still learns WHAT failed...
    assert.match(thrown.message, /hash verification/i, "the failure class must survive redaction");
    // ...but not WHERE it lives on the server.
    assert.doesNotMatch(
      thrown.message,
      /\/(home|tmp|var|etc|usr|opt|srv)\//,
      "an absolute server path must never reach a route",
    );
    assert.doesNotMatch(thrown.message, /[A-Za-z]:\\/i, "a Windows absolute path must never reach a route");

    // A MISSING blob is the case where the upstream message does carry the blob
    // digest, and that digest is the operator's only handle on which blob is
    // broken. Redaction must remove the path without removing the digest.
    const missing = copyArtifact("known-upstream-leak-missing");
    const missingBlob = blobPathIn(missing, detail.summary.content_digest);
    rmSync(missingBlob);
    let missingThrown;
    try {
      const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: missing });
      try {
        getSkillContent(config, { skillId: KNOWN, level: "L2" });
      } catch (error) {
        missingThrown = error;
      }
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
    assert.ok(missingThrown !== undefined, "a missing blob must fail closed");
    assert.doesNotMatch(
      missingThrown.message,
      /\/(home|tmp|var|etc|usr|opt|srv)\//,
      "the missing-blob message must also be redacted",
    );
    assert.match(
      missingThrown.message,
      /sha256:[0-9a-f]{64}/,
      "the failing blob digest must survive redaction, or the operator loses their only handle",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The eight artifact control files are unreachable                          */
/* -------------------------------------------------------------------------- */

describe("the artifact control files are unreachable", () => {
  test("each of the eight is refused through the content path", () => {
    const config = committedConfig();
    for (const fileName of CONTROL_FILES) {
      assertRefusal(
        () => getSkillContent(config, { skillId: KNOWN, level: "L2", filePath: fileName }),
        { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
        `${fileName} must be refused`,
      );
    }
  });

  test("the refusal does not depend on which skill is asked", () => {
    // Each control file is refused for every released skill, not just the one
    // whose files happen to collide.
    for (const skillId of [KNOWN, "anthropic/claude-api", "anthropic/skill-creator"]) {
      for (const fileName of CONTROL_FILES) {
        assertRefusal(
          () => getSkillContent(committedConfig(), { skillId: skillId, level: "L2", filePath: fileName }),
          { code: "E_WEB_CONTENT_FILE_UNKNOWN", status: 400 },
          `${fileName} via ${skillId} must be refused`,
        );
      }
    }
  });

  test("none of the eight is a manifest entry for any released skill", () => {
    // The structural reason the refusal happens at all: they are release control
    // files, not skill content. If one ever became a manifest entry, the exact
    // equality that refuses it would no longer apply.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      const offenders = handle.db
        .prepare("SELECT DISTINCT path FROM skill_files WHERE path IN (?,?,?,?,?,?,?,?)")
        .all(...CONTROL_FILES)
        .map((row) => row.path);
      assert.deepEqual(offenders, [], `control files present as manifest entries: ${JSON.stringify(offenders)}`);
    } finally {
      handle.close();
    }
  });

  test("a real manifest entry IS served, so the refusal above is discriminating", () => {
    // The control of the control: exact equality against real entries works, so
    // the eight refusals are not an artefact of refusing everything.
    const served = getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2", filePath: "LICENSE.txt" });
    assert.ok(served.content.length > 0);
    assert.equal(served.file_path, "LICENSE.txt");
  });
});

/* -------------------------------------------------------------------------- */
/* 7. max_tokens bounds are enforced                                           */
/* -------------------------------------------------------------------------- */

describe("max_tokens bounds are enforced", () => {
  test("the re-exported bounds are the frozen tool's own", () => {
    assert.equal(GET_CONTENT_MAX_TOKENS_MIN, 1);
    assert.equal(GET_CONTENT_MAX_TOKENS_MAX, 1_000_000);
    assert.equal(SKILL_CONTENT_DEFAULT_MAX_TOKENS < GET_CONTENT_MAX_TOKENS_MAX, true);
    assert.equal(SKILL_CONTENT_DEFAULT_MAX_TOKENS >= 32_000, true);
    assert.deepEqual([...SKILL_CONTENT_LEVELS], ["L1", "L2"]);
  });

  test("0, a negative value, a non-integer and an over-ceiling value are each rejected", () => {
    const config = committedConfig();
    const refusals = [
      [0, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [-1, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [-1000, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [1.5, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [Number.NaN, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [Number.POSITIVE_INFINITY, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [GET_CONTENT_MAX_TOKENS_MAX + 1, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
      [Number.MAX_SAFE_INTEGER, "E_WEB_CONTENT_MAX_TOKENS_INVALID"],
    ];
    for (const [value, code] of refusals) {
      assertRefusal(
        () => getSkillContent(config, { skillId: KNOWN, level: "L2", maxTokens: value }),
        { code, status: 400 },
        `maxTokens ${value} must be rejected`,
      );
    }
  });

  test("a non-number maxTokens is rejected", () => {
    for (const value of ["1000", null, {}, [], true]) {
      assertRefusal(
        () => getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2", maxTokens: value }),
        { code: "E_WEB_CONTENT_MAX_TOKENS_INVALID", status: 400 },
      );
    }
  });

  test("an over-budget real request is an explicit error, never a truncation", () => {
    const detail = getSkillDetail(committedConfig(), KNOWN);
    // A budget one token below the real count: the request cannot be satisfied.
    assertRefusal(
      () => getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2", maxTokens: detail.summary.l2_tokens - 1 }),
      { code: "E_WEB_CONTENT_TOKEN_BUDGET", status: 400 },
    );
    // Exactly at the count is satisfied: the bound is inclusive.
    const exact = getSkillContent(committedConfig(), { skillId: KNOWN, level: "L2", maxTokens: detail.summary.l2_tokens });
    assert.equal(exact.token_count, detail.summary.l2_tokens);
    assert.equal(exact.truncated, false);
    assert.equal(exact.content.length > 0, true);
  });

  test("truncated is false on every successful retrieval", () => {
    for (const skillId of [KNOWN, "anthropic/claude-api", "anthropic/skill-creator"]) {
      const body = getSkillContent(committedConfig(), { skillId: skillId, level: "L2" });
      assert.equal(body.truncated, false, `${skillId} returned truncated content`);
      assert.equal(body.token_count <= body.requested_max_tokens, true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Invalid skill ids are rejected without touching the database            */
/* -------------------------------------------------------------------------- */

describe("invalid skill ids are rejected before any read", () => {
  test("SQL metacharacters, empty, non-canonical and traversal shapes are all refused", () => {
    const config = committedConfig();
    const shapes = [
      // SQL metacharacters.
      "'; DROP TABLE skill_versions; --",
      "anthropic/academy-guide' OR '1'='1",
      "anthropic/academy-guide; DELETE FROM skills",
      "anthropic/academy-guide UNION SELECT 1",
      // Empty and whitespace.
      "",
      "   ",
      "/",
      "//",
      "anthropic/",
      "/academy-guide",
      // Non-canonical shapes.
      "academy-guide",
      "anthropic",
      "anthropic/academy guide",
      "anthropic/academy_guide",
      "anthropic/ACADEMY-GUIDE",
      "anthropic/academy-guide/extra",
      "anthropic/.hidden",
      "-anthropic/x",
      // Path traversal.
      "../anthropic/academy-guide",
      "../../etc/passwd",
      "anthropic/../../etc/passwd",
      "anthropic/./academy-guide",
    ];
    for (const skillId of shapes) {
      assertRefusal(
        () => getSkillDetail(config, skillId),
        { code: "E_WEB_SKILL_ID_INVALID", status: 400 },
        `skill id ${JSON.stringify(skillId)} must be refused`,
      );
    }
  });

  test("an invalid id is refused even against an unverified artifact", () => {
    // Ordering proof: validation runs FIRST, so a malformed id produces the
    // option error, not the verification error, regardless of artifact state.
    const broken = parseServerConfig({
      EGA_WEB_ARTIFACT_DIR: join(tmpdir(), "ega-web-skills-does-not-exist-3f9a"),
      EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST,
    }, { requireArtifactDir: false });
    assertRefusal(
      () => getSkillDetail(broken, "not a skill id"),
      { code: "E_WEB_SKILL_ID_INVALID", status: 400 },
    );
    assertRefusal(
      () => getSkillContent(broken, { skillId: "not a skill id", level: "L2" }),
      { code: "E_WEB_SKILL_ID_INVALID", status: 400 },
    );
  });

  test("a valid-but-unreleased id is a 404, distinct from a malformed one", () => {
    // Syntactically canonical and well-formed, simply not in this release.
    assertRefusal(
      () => getSkillDetail(committedConfig(), "anthropic/does-not-exist"),
      { code: "E_WEB_SKILL_NOT_RELEASED", status: 404 },
    );
    assertRefusal(
      () => getSkillContent(committedConfig(), { skillId: "anthropic/does-not-exist", level: "L2" }),
      { code: "E_WEB_SKILL_NOT_RELEASED", status: 404 },
    );
  });

  test("an oversized skill id is refused", () => {
    const long = `anthropic/${"a".repeat(SKILL_ID_MAX_LENGTH)}`;
    assertRefusal(
      () => getSkillDetail(committedConfig(), long),
      { code: "E_WEB_SKILL_ID_INVALID", status: 400 },
    );
  });

  test("an invalid level is refused", () => {
    for (const level of ["L3", "l1", "l2", "", "CORE", null, 1]) {
      assertRefusal(
        () => getSkillContent(committedConfig(), { skillId: KNOWN, level: level }),
        { code: "E_WEB_CONTENT_LEVEL_INVALID", status: 400 },
      );
    }
  });

  test("a non-object options argument is refused", () => {
    for (const options of [null, undefined, "L2", 42, []]) {
      assertRefusal(
        () => getSkillContent(committedConfig(), options),
        { code: "E_WEB_CONTENT_REQUEST_INVALID", status: 400 },
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 9. No fabricated history                                                    */
/* -------------------------------------------------------------------------- */

describe("no fabricated history", () => {
  test("history is empty-with-reason and the count it cites is real", () => {
    const detail = getSkillDetail(committedConfig(), KNOWN);
    assert.equal(detail.history.state, "not-retained");
    assert.deepEqual([...detail.history.versions], []);
    assert.equal(detail.history.reason !== null, true);
    // The reason cites the real recorded row count. Verify it independently:
    // the release must hold exactly one version row for this skill.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      const counted = handle.db
        .prepare("SELECT count(*) AS n FROM skill_versions WHERE skill_id = ?")
        .get(KNOWN);
      assert.equal(counted.n, 1, "expected exactly one recorded version for this skill");
      const total = handle.db
        .prepare("SELECT count(*) AS n, count(DISTINCT skill_id) AS skills FROM skill_versions")
        .get();
      // The whole release: one row per skill, no history anywhere.
      assert.equal(total.n, 114);
      assert.equal(total.skills, 114);
      assert.equal(total.n, total.skills, "no skill has more than one recorded version");
    } finally {
      handle.close();
    }
  });

  test("no invented version entries or timestamps appear in any detail", () => {
    for (const skillId of COMMITTED_SKILL_IDS) {
      const detail = getSkillDetail(committedConfig(), skillId);
      assert.deepEqual([...detail.history.versions], [], `${skillId} invented a version entry`);
      assert.equal(detail.history.state, "not-retained", `${skillId} claimed retained history`);
      // No ISO-8601 timestamp anywhere in the history block. The schema records
      // none, so there is none to report.
      const serializedHistory = JSON.stringify(detail.history);
      assert.doesNotMatch(
        serializedHistory,
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
        `${skillId} history contains a timestamp the release does not record`,
      );
    }
  });

  test("a history the release really has would be reported, not suppressed", async () => {
    // Proves the empty state is a real reading and not a hardcoded empty array.
    // A second version row is added to a COPY — but the reader used here is the
    // console's own, built over the verified snapshot's release map with the
    // COPY's SQLite file, exactly as `catalog.test.mjs:419-429` does. The
    // history block is then asked directly, with no identity gate in between, so
    // the genuine row is observed.
    const copy = copyArtifact("history");
    const Database = await loadBetterSqlite3();
    const writable = new Database(join(copy, "registry.sqlite"));
    try {
      writable
        .prepare(
          `INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level)
           SELECT skill_id, ?, manifest_json, l1_status, l2_size_class, trust_level
             FROM skill_versions WHERE skill_id = ?`,
        )
        .run(OTHER_DIGEST, KNOWN);
    } finally {
      writable.close();
    }

    // A reader over the untouched verified snapshot, reading the copy's rows.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const sqlitePath = join(copy, "registry.sqlite");
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const reader = createRegistryReader(snapshot, {
      db,
      registryDatabase: sqlitePath,
      close: () => db.close(),
    });
    try {
      const recorded = reader.listSkillVersions(KNOWN);
      assert.equal(recorded.length, 2, "the copy now genuinely records two versions");
      assert.deepEqual(
        recorded.map((row) => row.version_hash).sort(),
        [KNOWN_VERSION, OTHER_DIGEST].sort(),
      );
    } finally {
      reader.close();
    }

    // And the same copy read through the full entry point must refuse, because
    // the release projection no longer matches its SQLite bytes. A tampered
    // artifact is never served, so the extra row cannot become a payload.
    const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy });
    assertRefusal(
      () => getSkillDetail(config, KNOWN),
      { code: "E_WEB_RELEASE_UNVERIFIED", status: 503 },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Mismatch fails closed                                                   */
/* -------------------------------------------------------------------------- */

describe("a release mismatch fails closed", () => {
  const MISMATCH_ENV = { EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST };

  test("getSkillDetail throws rather than returning data", () => {
    assertRefusal(
      () => getSkillDetail(committedConfig(MISMATCH_ENV), KNOWN),
      { code: "E_WEB_RELEASE_MISMATCH", status: 503 },
    );
  });

  test("getSkillContent throws rather than returning data", () => {
    assertRefusal(
      () => getSkillContent(committedConfig(MISMATCH_ENV), { skillId: KNOWN, level: "L2" }),
      { code: "E_WEB_RELEASE_MISMATCH", status: 503 },
    );
  });

  test("the refusal names both digests and the variable, and no path", () => {
    let thrown;
    try {
      getSkillDetail(committedConfig(MISMATCH_ENV), KNOWN);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /EGA_WEB_EXPECTED_RELEASE_DIGEST/);
    assert.match(thrown.message, new RegExp(COMMITTED_DIGEST));
    assert.doesNotMatch(thrown.message, /\/(home|tmp|var|etc|usr)\//);
  });

  test("no database handle is opened at all under a mismatch", () => {
    // The refusal must come from the identity check, not from an empty query.
    // Proven by asserting the error is the identity error rather than a
    // registry/content error, and that it names the digest comparison.
    let thrown;
    const config = committedConfig(MISMATCH_ENV);
    try {
      getSkillDetail(config, KNOWN);
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown.code, "E_WEB_RELEASE_MISMATCH");
    assert.doesNotMatch(thrown.message, /select|prepare/i);
  });

  test("an expectation matching the artifact yields stable and serves", () => {
    // The control: the guard is not refusing everything, it is comparing digests.
    const detail = getSkillDetail(
      committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST }),
      KNOWN,
    );
    assert.equal(detail.release.status, "stable");
    assert.equal(detail.release.mismatch_reason, null);
    assert.equal(detail.summary.skill_id, KNOWN);
    assert.equal(
      getSkillContent(committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST }), {
        skillId: KNOWN,
        level: "L2",
      }).content.length > 0,
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 11. The committed artifact is untouched                                     */
/* -------------------------------------------------------------------------- */

describe("the committed artifact is untouched", () => {
  test("a read-only handle reports query_only enforcement", () => {
    // The content path opens its handle through `openReadOnlyRegistry`, which
    // sets and verifies `query_only`. Assert the property holds on the handle
    // this process actually uses.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      assert.equal(handle.db.pragma("query_only", { simple: true }), 1);
      assert.equal(handle.registryDatabase.endsWith("registry.sqlite"), true);
    } finally {
      handle.close();
    }
  });

  test("the committed artifact is byte-identical to its pre-run digests", () => {
    // The full before/after comparison runs in `after`; this asserts the corpus
    // was non-trivial to begin with, so the comparison is meaningful.
    assert.ok(ARTIFACT_DIGESTS_BEFORE.size > 800, `expected the whole artifact, found ${ARTIFACT_DIGESTS_BEFORE.size} files`);
    for (const name of CONTROL_FILES) {
      assert.equal(ARTIFACT_DIGESTS_BEFORE.has(`/${name}`), true, `${name} must be part of the digested corpus`);
    }
  });

  test("the handle the content path uses cannot write", () => {
    // The read-only guarantee is structural at the SQLite layer, so it is
    // asserted where it is enforced rather than described. `openReadOnlyRegistry`
    // is what `runGetContentTool` opens for every content request.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      assert.throws(
        () => handle.db.prepare("UPDATE skill_versions SET trust_level = 'OWNED'").run(),
        /readonly|read-only|query_only|attempt to write/i,
      );
      assert.throws(
        () => handle.db.prepare("DELETE FROM skill_versions").run(),
        /readonly|read-only|query_only|attempt to write/i,
      );
    } finally {
      handle.close();
    }
  });
});
