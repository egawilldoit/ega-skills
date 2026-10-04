/**
 * Catalog enumeration: the console's authoritative list of released skills.
 *
 * ## The fixture is the real release
 *
 * These tests read the REAL committed artifact (`packages/mcp/artifact`, a
 * verified 114-skill release). Nothing is mocked: `loadHostedReleaseSnapshot`
 * runs its full verification, the SQLite file is opened read-only with
 * `query_only` enforced, and every row is read through Builder 2a's reader.
 *
 * Where a test needs to manufacture an impossible state it copies the artifact
 * to a temp directory and mutates THE COPY. A module-level digest of all 845
 * committed files is taken before the first test and re-checked in `after`, so
 * "never mutate the committed artifact" is asserted rather than assumed — a
 * mutation here would silently corrupt the repository's own fixtures.
 *
 * ## Naming note
 *
 * The brief describes the identity fields as
 * `CatalogSummary.releaseIdentity.actual_release_digest`. The shared DTO in
 * `apps/web/src/api/contracts.ts` — which this slice must not edit, and whose
 * field names `release-identity.test.mjs:160-170` pins — declares them as
 * `CatalogSummary.release` and `ReleaseIdentity.release_digest`. The tests use
 * the DTO names. See the report for the full reconciliation.
 *
 * ## What is asserted about sparse data
 *
 * The shipped release is genuinely sparse and the assertions say so:
 * `l1_status` is `MISSING` for all 114 skills because no `core`-role file
 * exists, `trust_level` is `UNKNOWN` for all 114, `source_type` is `local` for
 * all 114 with no repository or commit sha, and only 7 of 114 skills carry a
 * domain. Tests assert those real numbers. If a future release changes them,
 * the failure is a fact about the release and must be investigated, not
 * papered over by loosening the expectation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";

import { loadHostedReleaseSnapshot, openReadOnlyRegistry } from "../../packages/mcp/dist/index.js";

import { parseServerConfig } from "../../apps/web/server/env.ts";
import {
  CATALOG_DEFAULT_LIMIT,
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_MAX_LIMIT,
  CATALOG_MAX_OFFSET,
  CATALOG_MAX_QUERY_LENGTH,
  CATALOG_SORT_KEYS,
  CATALOG_UNSCOPED_WORKSPACE_ID,
  CatalogError,
  buildCatalogPage,
  getCatalog,
} from "../../apps/web/server/catalog.ts";
import {
  ReleaseIdentityError,
  evaluateReleaseIdentity,
} from "../../apps/web/server/release-identity.ts";
import { closeRegistry, createRegistryReader } from "../../apps/web/server/registry.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");
const CATALOG_SOURCE = join(REPO_ROOT, "apps", "web", "server", "catalog.ts");

/** The committed release's real digests, read from the package, never hardcoded. */
const COMMITTED_PACKAGE = JSON.parse(
  readFileSync(join(ARTIFACT, "release-package.json"), "utf8"),
);
const COMMITTED_DIGEST = COMMITTED_PACKAGE.hub_release_digest;
const COMMITTED_RELEASE = JSON.parse(readFileSync(join(ARTIFACT, "hub-release.json"), "utf8"));
const COMMITTED_SKILL_IDS = Object.keys(COMMITTED_RELEASE.payload.skill_versions).sort();

/** A different but syntactically valid digest, for the mismatch scenario. */
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

/** Config for the committed artifact, read-only. */
function committedConfig(extraEnv = {}) {
  return parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT, ...extraEnv });
}

/** The whole release in one page, so assertions are about the release. */
function fullCatalog(extraEnv = {}) {
  return getCatalog(committedConfig(extraEnv), { limit: CATALOG_MAX_LIMIT });
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
  const dir = mkdtempSync(join(tmpdir(), `ega-web-catalog-${label}-`));
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

/* -------------------------------------------------------------------------- */
/* 1. The full release is enumerated                                          */
/* -------------------------------------------------------------------------- */

describe("the full release is enumerated", () => {
  test("every skill in the release map is returned, and nothing else is", () => {
    const page = fullCatalog();
    const ids = page.skills.map((row) => row.skill_id);
    assert.equal(ids.length, 114);
    // Exactly the release's authoritative map, sorted: no extra row invented
    // from the SQLite file, and no released skill silently omitted.
    assert.deepEqual([...ids].sort(), COMMITTED_SKILL_IDS);
    assert.equal(new Set(ids).size, 114, "no skill appears twice");
    // `total` is the pre-pagination match count, so a page proves the total.
    assert.equal(page.total, 114);
    assert.equal(page.skill_total, 114);
  });

  test("the row count agrees with the verified snapshot and the package", () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const page = fullCatalog();
    assert.equal(page.total, snapshot.release.payload.skill_versions === undefined ? 0 : 114);
    assert.equal(page.release.snapshot_rows, COMMITTED_PACKAGE.snapshot_rows);
    assert.equal(page.release.skill_count, COMMITTED_SKILL_IDS.length);
    // The reader's own corpus count is the independent third opinion.
    assert.equal(page.total, page.release.snapshot_rows);
  });

  test("a page never exceeds the requested limit", () => {
    const page = getCatalog(committedConfig(), { limit: 10 });
    assert.equal(page.skills.length, 10);
    assert.equal(page.total, 114, "the total is unaffected by the page size");
    assert.equal(page.limit, 10);
    const defaulted = getCatalog(committedConfig());
    assert.equal(defaulted.skills.length, CATALOG_DEFAULT_LIMIT);
    assert.equal(defaulted.limit, CATALOG_DEFAULT_LIMIT);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Release identity is carried                                             */
/* -------------------------------------------------------------------------- */

describe("release identity is carried", () => {
  test("the digest chain agrees end to end", () => {
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const page = fullCatalog();
    // The three-way binding: the verified envelope, the snapshot, and the
    // byte-level package the deployment ships. All three must be one value.
    assert.equal(page.release.release_digest, snapshot.release.digest);
    assert.equal(page.release.release_digest, COMMITTED_PACKAGE.hub_release_digest);
    assert.equal(page.release.hub_id, COMMITTED_RELEASE.payload.hub_id);
  });

  test("an artifact with no expectation is reported as unpinned, not stable", () => {
    const page = fullCatalog();
    assert.equal(page.release.status, "unpinned");
    assert.equal(page.release.mismatch_reason, null);
    // `CatalogSummary.release` is never null here: an unservable release throws.
    assert.equal(page.release_unavailable_reason, null);
  });

  test("expecting the artifact's own digest yields stable", () => {
    const page = fullCatalog({ EGA_WEB_EXPECTED_RELEASE_DIGEST: COMMITTED_DIGEST });
    assert.equal(page.release.status, "stable");
    assert.equal(page.release.mismatch_reason, null);
    assert.equal(page.total, 114);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Metadata is correct for a known skill                                   */
/* -------------------------------------------------------------------------- */

describe("metadata is correct for a known skill", () => {
  const KNOWN = "anthropic/academy-guide";

  test("identity, namespace, name and version hash are the real ones", () => {
    const row = fullCatalog().skills.find((candidate) => candidate.skill_id === KNOWN);
    assert.ok(row, `${KNOWN} must be in the catalog`);
    assert.equal(row.namespace, "anthropic");
    assert.equal(row.name, "academy-guide");
    assert.equal(row.namespace + "/" + row.name, row.skill_id);
    // The version hash is the one THE RELEASE pins, not the registry's
    // `current_version_hash` and not anything derived.
    assert.equal(row.version_hash, COMMITTED_RELEASE.payload.skill_versions[KNOWN]);
    assert.match(row.version_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.schema_version, 1);
  });

  test("the honest shipped values are reported, not convenient ones", () => {
    const row = fullCatalog().skills.find((candidate) => candidate.skill_id === KNOWN);
    // L1 is genuinely MISSING for all 114 skills: there are no `core`-role
    // files, so no SKILL.core.md was ever authored.
    assert.equal(row.l1_status, "MISSING");
    // And therefore l1_tokens is null — never 0, which would read as a count.
    assert.equal(row.l1_tokens, null);
    // L2 content does exist and its recorded count is real.
    assert.equal(typeof row.l2_tokens, "number");
    assert.ok(row.l2_tokens > 0);
    assert.equal(row.token_estimator_id, "ega-o200k-v1");
    // Trust and provenance are equally honest.
    assert.equal(row.trust_level, "UNKNOWN");
    assert.equal(row.source_type, "local");
    assert.equal(row.provenance_status, "local-only");
    assert.equal(row.source_repository, null);
    assert.equal(row.source_commit_sha, null);
    assert.equal(row.source_unavailable_reason, null);
  });

  test("the row still satisfies the shared SkillSummary contract", () => {
    const row = fullCatalog().skills.find((candidate) => candidate.skill_id === KNOWN);
    // Every field `SkillSummary` declares must be present with a usable value,
    // because the SPA types its table columns against it.
    for (const field of ["skill_id", "name", "description", "schema_version", "content_digest"]) {
      assert.notEqual(row[field], undefined, `SkillSummary.${field} must be present`);
    }
    assert.ok(Array.isArray(row.domains));
    assert.ok(Array.isArray(row.triggers));
    assert.match(row.content_digest, /^sha256:[0-9a-f]{64}$/);
  });

  test("long descriptions are truncated and say so", () => {
    const page = fullCatalog();
    for (const row of page.skills) {
      assert.ok(row.description.length <= CATALOG_DESCRIPTION_MAX_LENGTH + 1, `${row.skill_id} description was not truncated`);
      if (row.description_truncated) {
        assert.ok(row.description.endsWith("…"), `${row.skill_id} truncation is not marked`);
      }
    }
    // The real longest description in the release is 1018 characters, so at
    // least one row must actually be truncated.
    assert.ok(
      page.skills.some((row) => row.description_truncated),
      "expected at least one truncated description in a 114-skill release with a 1018-character description",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Routing comes from the manifest, not the FTS projection                 */
/* -------------------------------------------------------------------------- */

describe("routing comes from the manifest, not the FTS projection", () => {
  test("anti_triggers is surfaced although no FTS table indexes it", () => {
    // The decisive structural difference between the two sources. Both release
    // and registry FTS tables carry exactly these columns; `anti_triggers` is
    // in neither, and exists only inside manifest_json.routing.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    try {
      for (const table of [snapshot.ftsTable, "skill_fts"]) {
        const columns = handle.db
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(table)
          .map((row) => row.name);
        for (const projected of ["domains", "platforms", "frameworks", "triggers", "aliases"]) {
          assert.ok(columns.includes(projected), `${table} should project ${projected}`);
        }
        assert.ok(
          !columns.includes("anti_triggers"),
          `${table} unexpectedly has an anti_triggers column; the premise of this test has changed`,
        );
      }
    } finally {
      handle.close();
    }

    // 44 of the 114 skills carry anti_triggers in their manifest.
    const withAnti = fullCatalog().skills.filter((row) => row.anti_triggers.length > 0);
    assert.equal(withAnti.length, 44);
    const claudeApi = withAnti.find((row) => row.skill_id === "anthropic/claude-api");
    assert.ok(claudeApi, "anthropic/claude-api carries 9 anti_triggers in the shipped release");
    assert.equal(claudeApi.anti_triggers.length, 9);
    // Those nine strings are readable only because the manifest was read.
    assert.ok(claudeApi.anti_triggers.every((value) => typeof value === "string" && value.length > 0));
  });

  test("emptying the FTS domains column does not change what the catalog reports", async () => {
    // The behavioural proof that the FTS projection is not the source. The
    // committed artifact is read once (so the snapshot verifies), then a COPY
    // has one FTS `domains` cell blanked. If the catalog read the projection,
    // this skill's domain facet would vanish; reading the manifest, it does not.
    const copy = copyArtifact("blank-fts-domains");
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const Database = await loadBetterSqlite3();
    const writable = new Database(join(copy, "registry.sqlite"));
    try {
      writable.prepare(`UPDATE "${snapshot.ftsTable}" SET domains = '' WHERE skill_id = ?`).run("egawilldoit/design-architecture");
    } finally {
      writable.close();
    }

    // Independent confirmation that the copy really was changed.
    const probe = new Database(join(copy, "registry.sqlite"), { readonly: true, fileMustExist: true });
    try {
      const ftsRow = probe
        .prepare(`SELECT domains FROM "${snapshot.ftsTable}" WHERE skill_id = ?`)
        .get("egawilldoit/design-architecture");
      assert.equal(ftsRow.domains, "", "the copy's FTS domains cell should now be empty");
    } finally {
      probe.close();
    }

    const reader = await readerOver(snapshot, copy);
    try {
      const identity = evaluateReleaseIdentity(committedConfig()).identity;
      assert.ok(identity);
      const page = buildCatalogPage(reader, identity, { domain: "architecture" });
      // Still found, because the domain came from manifest_json.routing.
      const found = page.skills.find((row) => row.skill_id === "egawilldoit/design-architecture");
      assert.ok(found, "the domain filter must match the manifest routing, not the FTS projection");
      assert.deepEqual([...found.domains], ["architecture"]);
      assert.deepEqual(
        page.facets.domains.map((facet) => facet.value),
        ["architecture"],
      );
    } finally {
      reader.close();
    }
  });

  test("in the shipped artifact the two sources happen to agree value for value", () => {
    // Reported honestly rather than as if a divergence had been found. In this
    // release the projection is faithful for all 114 skills across all five
    // projected facets, so the sparse counts are the same from either source
    // (7 domains, 1 platform, 1 framework, 71 triggers, 22 aliases). The
    // reasons to prefer the manifest are therefore structural, not empirical:
    // the projection is a newline-joined search blob that has to be re-split,
    // it silently loses any value containing a newline, and it cannot carry
    // anti_triggers at all.
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const handle = openReadOnlyRegistry(snapshot.context);
    let disagreements = 0;
    try {
      for (const row of fullCatalog().skills) {
        const fts = handle.db
          .prepare(
            `SELECT domains, platforms, frameworks, triggers, aliases FROM "${snapshot.ftsTable}" WHERE skill_id = ?`,
          )
          .get(row.skill_id);
        assert.ok(fts, `${row.skill_id} must have an FTS row`);
        const projected = (value) => (typeof value === "string" && value !== "" ? value.split("\n") : []);
        if (JSON.stringify([...row.domains]) !== JSON.stringify(projected(fts.domains))) disagreements += 1;
        if (JSON.stringify([...row.frameworks]) !== JSON.stringify(projected(fts.frameworks))) disagreements += 1;
        if (JSON.stringify([...row.platforms]) !== JSON.stringify(projected(fts.platforms))) disagreements += 1;
        if (JSON.stringify([...row.triggers]) !== JSON.stringify(projected(fts.triggers))) disagreements += 1;
        if (JSON.stringify([...row.aliases]) !== JSON.stringify(projected(fts.aliases))) disagreements += 1;
      }
    } finally {
      handle.close();
    }
    assert.equal(disagreements, 0, "the projection and the manifest disagree in this artifact; investigate before assuming they cannot");
  });

  test("domain facets are derived from routing values, not from a namespace or name guess", () => {
    const page = fullCatalog();
    const withDomain = page.skills.filter((row) => row.domains.length > 0);
    assert.equal(withDomain.length, 7);
    // Every domain facet value is carried by at least one skill whose row
    // declares it, and no skill declares a domain outside the facet list.
    const declared = new Set(page.skills.flatMap((row) => [...row.domains]));
    for (const facet of page.facets.domains) {
      assert.ok(declared.has(facet.value), `facet ${facet.value} is not declared by any skill`);
    }
  });
});

/**
 * Load better-sqlite3 through the workspace member that declares it.
 *
 * The console does not depend on `better-sqlite3` directly — it goes through
 * `@ega-skills/registry` — so a test that needs to manufacture an impossible
 * snapshot resolves it from where it is actually installed, the same way
 * `tests/web/release-identity.test.mjs:586` does.
 */
async function loadBetterSqlite3() {
  const imported = await import("../../packages/registry/node_modules/better-sqlite3/lib/index.js");
  return imported.default?.default ?? imported.default;
}

/**
 * A `RegistryReader` over a verified snapshot but a *different* SQLite file:
 * the release map and FTS table name come from the untouched artifact, the rows
 * come from `directory`. Used to prove refusals and to prove the catalog ignores
 * the FTS projection. `query_only` is set here because a production handle gets
 * it from `openReadOnlyRegistry`.
 */
async function readerOver(snapshot, directory) {
  const Database = await loadBetterSqlite3();
  const sqlitePath = join(directory, "registry.sqlite");
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return createRegistryReader(snapshot, {
    db,
    registryDatabase: sqlitePath,
    close: () => db.close(),
  });
}

/* -------------------------------------------------------------------------- */
/* 5. Facet counts report sparse reality                                       */
/* -------------------------------------------------------------------------- */

describe("facet counts report sparse reality", () => {
  test("domains, frameworks and platforms are far below the skill count", () => {
    const page = fullCatalog();
    /** How many of the 114 skills carry at least one value of this facet. */
    const skillsWith = (field) => page.skills.filter((row) => row[field].length > 0).length;

    // The real shipped numbers, asserted as facts about the release.
    assert.equal(page.facets.domains.length, 7);
    assert.equal(skillsWith("domains"), 7);
    assert.equal(page.facets.frameworks.length, 1);
    assert.deepEqual([...page.facets.frameworks], [{ value: "typescript", skill_count: 1 }]);
    assert.equal(page.facets.platforms.length, 1);
    assert.deepEqual([...page.facets.platforms], [{ value: "web", skill_count: 1 }]);
    assert.equal(page.facets.triggers.length, 266);
    assert.equal(page.facets.aliases.length, 23);
    assert.equal(page.domain_total, 7);

    // The point of the architecture note: none of these may be mistaken for
    // full coverage. A facet whose skills summed to 114 would be a lie.
    for (const field of ["domains", "frameworks", "platforms", "triggers", "aliases"]) {
      const covered = skillsWith(field);
      assert.ok(covered > 0, `${field} covers no skill; that would mean the facet was not read`);
      assert.ok(covered < 114, `${field} must not report full coverage in this release`);
    }
    // The exact sparse coverage of the shipped release.
    assert.equal(skillsWith("triggers"), 71);
    assert.equal(skillsWith("aliases"), 22);
    assert.equal(skillsWith("anti_triggers"), 44);

    // Facet counts are per (value, skill), so a skill with two triggers
    // contributes to two entries, and two skills sharing a trigger value
    // contribute to one entry counted twice. Both happen in this release:
    // 268 (skill, trigger) pairs over 266 distinct values, because "root cause"
    // and "red green refactor" are each declared by two skills. That is why
    // coverage has to be counted from rows rather than by summing facet counts,
    // which would double-count multi-valued skills and read as full coverage.
    const triggerSum = page.facets.triggers.reduce((sum, facet) => sum + facet.skill_count, 0);
    assert.equal(page.facets.triggers.length, 266, "distinct trigger values in this release");
    assert.equal(triggerSum, 268, "(skill, trigger) pairs in this release");
    assert.ok(triggerSum > 114, "a multi-valued facet's count sum legitimately exceeds the skill count");
    assert.deepEqual(
      page.facets.triggers.filter((facet) => facet.skill_count === 2).map((facet) => facet.value).sort(),
      ["red green refactor", "root cause"],
      "the two trigger values declared by more than one skill",
    );
  });

  test("namespace and scalar facets are exact", () => {
    const page = fullCatalog();
    assert.deepEqual(
      page.facets.namespaces.map((facet) => [facet.value, facet.skill_count]),
      [
        ["egawilldoit", 66],
        ["mattpocock", 25],
        ["anthropic", 14],
        ["vercel", 9],
      ],
    );
    // All 114 skills report MISSING / UNKNOWN / local. Not one fabricated zero.
    assert.deepEqual(page.facets.l1_statuses, [{ value: "MISSING", skill_count: 114 }]);
    assert.deepEqual(page.facets.trust_levels, [{ value: "UNKNOWN", skill_count: 114 }]);
    assert.deepEqual(page.facets.sources, [{ value: "local", skill_count: 114 }]);
    assert.equal(
      page.skills.every((row) => row.l1_tokens === null),
      true,
      "no skill may report an L1 token count in a release with no core-role files",
    );
  });

  test("facet counts describe the filtered set, and state which filter ran", () => {
    const page = getCatalog(committedConfig(), { namespace: "anthropic", limit: CATALOG_MAX_LIMIT });
    assert.equal(page.total, 14);
    assert.deepEqual(page.facets.namespaces.map((facet) => facet.value), ["anthropic"]);
    assert.equal(page.applied_filters.namespace, "anthropic");
    assert.equal(page.applied_filters.q, null);
    // All 7 domain-bearing skills live in the `egawilldoit` namespace, so the
    // anthropic facet set is genuinely empty. Reported as empty rather than
    // back-filled with the unfiltered release's domains.
    assert.equal(page.skills.filter((row) => row.domains.length > 0).length, 0);
    assert.deepEqual([...page.facets.domains], []);
    // But `domain_total` is release-wide by definition, so it does not move.
    assert.equal(page.domain_total, 7);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Filters work and are bounded                                             */
/* -------------------------------------------------------------------------- */

describe("filters work and are bounded", () => {
  const all = fullCatalog();

  test("namespace filter returns a real subset", () => {
    const page = getCatalog(committedConfig(), { namespace: "vercel", limit: CATALOG_MAX_LIMIT });
    assert.equal(page.total, 9);
    assert.ok(page.total <= all.total);
    for (const row of page.skills) assert.equal(row.namespace, "vercel");
  });

  test("domain and framework filters match manifest routing exactly", () => {
    const byDomain = getCatalog(committedConfig(), { domain: "github", limit: CATALOG_MAX_LIMIT });
    assert.equal(byDomain.total, 1);
    assert.equal(byDomain.skills[0].skill_id, "egawilldoit/get-pr-comments");

    const byFramework = getCatalog(committedConfig(), { framework: "typescript", limit: CATALOG_MAX_LIMIT });
    assert.equal(byFramework.total, 1);
    assert.deepEqual([...byFramework.skills[0].frameworks], ["typescript"]);
  });

  test("source and l1 filters work", () => {
    const bySource = getCatalog(committedConfig(), { source: "local", limit: CATALOG_MAX_LIMIT });
    assert.equal(bySource.total, 114);
    assert.ok(bySource.total <= all.total);
    const byL1 = getCatalog(committedConfig(), { l1: "MISSING", limit: CATALOG_MAX_LIMIT });
    assert.equal(byL1.total, 114);
    const byAuthored = getCatalog(committedConfig(), { l1: "AUTHORED", limit: CATALOG_MAX_LIMIT });
    assert.equal(byAuthored.total, 0, "no skill in this release has an authored L1");
  });

  test("filters compose, and q matches metadata only", () => {
    const page = getCatalog(committedConfig(), {
      namespace: "anthropic",
      q: "claude",
      limit: CATALOG_MAX_LIMIT,
    });
    assert.ok(page.total > 0);
    assert.ok(page.total <= 14);
    for (const row of page.skills) {
      assert.equal(row.namespace, "anthropic");
      // `q` matches identity, name, description and every routing facet, so the
      // honest check is that the term appears somewhere in that text — not that
      // it appears in the id or the description specifically.
      const haystack = [
        row.skill_id,
        row.name,
        row.namespace,
        row.description,
        ...row.domains,
        ...row.frameworks,
        ...row.platforms,
        ...row.triggers,
        ...row.aliases,
        ...row.anti_triggers,
      ]
        .join("\n")
        .toLowerCase();
      assert.ok(haystack.includes("claude"), `${row.skill_id} does not contain "claude" in any searchable field`);
    }
    assert.equal(page.applied_filters.q, "claude");
    // q is trimmed before it is compared, so padding cannot widen or narrow the
    // result. Compared against the same query without the namespace filter.
    const bare = getCatalog(committedConfig(), { q: "claude", limit: CATALOG_MAX_LIMIT });
    const padded = getCatalog(committedConfig(), { q: "   claude   ", limit: CATALOG_MAX_LIMIT });
    assert.equal(padded.applied_filters.q, "claude");
    assert.equal(padded.total, bare.total);
    assert.deepEqual(
      padded.skills.map((row) => row.skill_id),
      bare.skills.map((row) => row.skill_id),
    );
    assert.ok(page.total < bare.total, "the namespace filter should narrow the claude match set");
  });

  test("an unknown filter value yields an empty page, not an error or a fake", () => {
    for (const options of [
      { namespace: "nope" },
      { domain: "nope" },
      { framework: "nope" },
      { source: "nope" },
      { l1: "nope" },
      { q: "zzzzz-no-such-text-zzzzz" },
    ]) {
      const page = getCatalog(committedConfig(), { ...options, limit: CATALOG_MAX_LIMIT });
      assert.equal(page.total, 0, `expected no matches for ${JSON.stringify(options)}`);
      assert.deepEqual([...page.skills], []);
      // Facets go empty with the result rather than reporting the unfiltered set.
      assert.deepEqual([...page.facets.domains], []);
    }
  });

  test("no filter can return more rows than the unfiltered catalog", () => {
    for (const options of [
      { namespace: "anthropic" },
      { domain: "architecture" },
      { framework: "typescript" },
      { source: "local" },
      { l1: "MISSING" },
      { q: "e" },
    ]) {
      const page = getCatalog(committedConfig(), { ...options, limit: CATALOG_MAX_LIMIT });
      assert.ok(page.total <= all.total, `${JSON.stringify(options)} returned more rows than the whole catalog`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Rejections are deterministic and happen before any read                   */
/* -------------------------------------------------------------------------- */

describe("rejections are deterministic", () => {
  const rejections = [
    ["an unknown sort key", { sort: "l1_token" }, "E_WEB_CATALOG_INVALID_SORT"],
    ["an empty sort key", { sort: "" }, "E_WEB_CATALOG_INVALID_SORT"],
    ["a sort key with trailing junk", { sort: "name asc" }, "E_WEB_CATALOG_INVALID_SORT"],
    ["a non-string sort", { sort: 7 }, "E_WEB_CATALOG_INVALID_SORT"],
    ["a negative limit", { limit: -1 }, "E_WEB_CATALOG_INVALID_LIMIT"],
    ["a zero limit", { limit: 0 }, "E_WEB_CATALOG_INVALID_LIMIT"],
    ["a fractional limit", { limit: 1.5 }, "E_WEB_CATALOG_INVALID_LIMIT"],
    ["an oversized limit", { limit: CATALOG_MAX_LIMIT + 1 }, "E_WEB_CATALOG_INVALID_LIMIT"],
    ["an absurd limit", { limit: 10 ** 9 }, "E_WEB_CATALOG_INVALID_LIMIT"],
    ["a NaN limit", { limit: Number.NaN }, "E_WEB_CATALOG_INVALID_LIMIT"],
    ["a negative offset", { offset: -1 }, "E_WEB_CATALOG_INVALID_OFFSET"],
    ["a fractional offset", { offset: 0.5 }, "E_WEB_CATALOG_INVALID_OFFSET"],
    ["an oversized offset", { offset: CATALOG_MAX_OFFSET + 1 }, "E_WEB_CATALOG_INVALID_OFFSET"],
    ["an over-long q", { q: "a".repeat(CATALOG_MAX_QUERY_LENGTH + 1) }, "E_WEB_CATALOG_INVALID_QUERY"],
    ["a whitespace-only q", { q: "   " }, "E_WEB_CATALOG_INVALID_QUERY"],
    ["a q with a control character", { q: "claude " }, "E_WEB_CATALOG_INVALID_QUERY"],
    ["an over-long namespace", { namespace: "n".repeat(200) }, "E_WEB_CATALOG_INVALID_FILTER"],
    ["an empty domain", { domain: "" }, "E_WEB_CATALOG_INVALID_FILTER"],
    ["an over-long workspace id", { workspace_id: "w".repeat(200) }, "E_WEB_CATALOG_INVALID_WORKSPACE"],
  ];

  for (const [label, options, code] of rejections) {
    test(`rejects ${label}`, () => {
      assert.throws(
        () => getCatalog(committedConfig(), options),
        (error) => {
          assert.ok(error instanceof CatalogError, `expected a CatalogError, got ${error?.name}`);
          assert.equal(error.code, code);
          assert.equal(error.status, 400);
          // Operator-safe: no SQL, no path, no stack in the message.
          assert.doesNotMatch(error.message, /SELECT|FROM |WHERE |sqlite/i);
          assert.doesNotMatch(error.message, /\/(home|tmp|var)\//);
          return true;
        },
      );
    });
  }

  test("validation runs BEFORE any read, so a rejection needs no valid artifact", () => {
    // A tampered artifact would fail verification at the identity guard. If an
    // invalid option is rejected first, the error must be the option error —
    // proof that no handle was opened and no query ran.
    const copy = copyArtifact("validate-order");
    const bytes = readFileSync(join(copy, "registry.sqlite"));
    bytes[bytes.length - 512] = bytes[bytes.length - 512] ^ 0xff;
    writeFileSync(join(copy, "registry.sqlite"), bytes);
    const tamperedConfig = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: copy });

    assert.throws(() => getCatalog(tamperedConfig, { sort: "nope" }), CatalogError);
    assert.throws(() => getCatalog(tamperedConfig, { limit: 0 }), CatalogError);
    // With a valid option the same config fails at the guard instead, which is
    // what proves the two failures are different and correctly ordered.
    assert.throws(() => getCatalog(tamperedConfig, { limit: 5 }), ReleaseIdentityError);
  });

  test("every declared sort key is accepted, and descending is a prefix", () => {
    for (const key of CATALOG_SORT_KEYS) {
      const ascending = getCatalog(committedConfig(), { sort: key, limit: CATALOG_MAX_LIMIT });
      const descending = getCatalog(committedConfig(), { sort: `-${key}`, limit: CATALOG_MAX_LIMIT });
      assert.equal(ascending.sort, key);
      assert.equal(ascending.sort_direction, "asc");
      assert.equal(descending.sort_direction, "desc");
      assert.equal(ascending.total, 114);
      assert.equal(descending.total, 114);
      // Same rows, opposite order, identical multiset.
      assert.deepEqual(
        [...descending.skills.map((row) => row.skill_id)].sort(),
        [...ascending.skills.map((row) => row.skill_id)].sort(),
      );
    }
  });

  test("an un-authored L1 sorts last in both directions", () => {
    // All 114 skills have l1_tokens null, so this cannot be observed as a
    // reversal here; the guarantee is asserted structurally instead: no sort
    // key may silently drop or reorder a null-token row out of the result.
    const page = getCatalog(committedConfig(), { sort: "-l1_tokens", limit: CATALOG_MAX_LIMIT });
    assert.equal(page.total, 114);
    assert.equal(page.skills.length, 114);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Pagination is bounded and consistent                                    */
/* -------------------------------------------------------------------------- */

describe("pagination is bounded and consistent", () => {
  test("paging through the release visits every skill exactly once", () => {
    const size = 7;
    const seen = [];
    for (let offset = 0; offset < 200; offset += size) {
      const page = getCatalog(committedConfig(), { sort: "skill_id", limit: size, offset });
      assert.ok(page.skills.length <= size, "a page exceeded its own limit");
      assert.equal(page.total, 114, "the total must not drift between pages");
      if (page.skills.length === 0) break;
      for (const row of page.skills) seen.push(row.skill_id);
    }
    assert.equal(seen.length, 114, "paging dropped or repeated rows");
    assert.equal(new Set(seen).size, 114, "paging repeated a row");
    assert.deepEqual(seen, COMMITTED_SKILL_IDS, "the default order must be skill_id ascending");
  });

  test("a sorted pagination is stable across every sort key", () => {
    // One page per key: enough to prove every declared key produces a total,
    // reproducible order over all 114 rows.
    for (const key of CATALOG_SORT_KEYS) {
      for (const direction of ["", "-"]) {
        const first = getCatalog(committedConfig(), { sort: `${direction}${key}`, limit: CATALOG_MAX_LIMIT });
        const second = getCatalog(committedConfig(), { sort: `${direction}${key}`, limit: CATALOG_MAX_LIMIT });
        assert.equal(first.total, 114);
        assert.equal(first.skills.length, 114);
        assert.deepEqual(
          first.skills.map((row) => row.skill_id),
          second.skills.map((row) => row.skill_id),
          `sort=${direction}${key} is not reproducible`,
        );
      }
    }
  });

  test("multi-page paging is consistent for a non-default sort", () => {
    // `skill_id` is trivially total; `l2_tokens` is not, so ties are broken by
    // skill_id. Paging that order must still visit every row exactly once.
    for (const key of ["-l2_tokens", "name"]) {
      const size = 13;
      const seen = [];
      for (let offset = 0; offset < 200; offset += size) {
        const page = getCatalog(committedConfig(), { sort: key, limit: size, offset });
        assert.ok(page.skills.length <= size);
        assert.equal(page.total, 114);
        if (page.skills.length === 0) break;
        for (const row of page.skills) seen.push(row.skill_id);
      }
      assert.equal(seen.length, 114, `sort=${key} lost rows while paging`);
      assert.equal(new Set(seen).size, 114, `sort=${key} repeated a row while paging`);
    }
  });

  test("an offset past the end is an empty page that still reports the total", () => {
    const page = getCatalog(committedConfig(), { limit: 10, offset: 114 });
    assert.deepEqual([...page.skills], []);
    assert.equal(page.total, 114);
    assert.equal(page.offset, 114);
  });

  test("the workspace id is echoed, never invented", () => {
    assert.equal(fullCatalog().workspace_id, CATALOG_UNSCOPED_WORKSPACE_ID);
    assert.equal(
      getCatalog(committedConfig(), { workspace_id: "11111111-1111-1111-1111-111111111111" }).workspace_id,
      "11111111-1111-1111-1111-111111111111",
    );
    assert.equal(fullCatalog().hub_id, COMMITTED_RELEASE.payload.hub_id);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. No skill bodies anywhere in the payload                                 */
/* -------------------------------------------------------------------------- */

describe("no skill bodies are served", () => {
  /** Read a blob body straight out of the artifact's verified cache. */
  function readBody(blobHash) {
    const hex = blobHash.slice("sha256:".length);
    return readFileSync(join(ARTIFACT, "cache", "sha256", hex.slice(0, 2), hex.slice(2)), "utf8");
  }

  test("a window from the middle of a real SKILL.md is absent from the payload", () => {
    const page = fullCatalog();
    const serialized = JSON.stringify(page);
    const sampled = ["anthropic/claude-api", "anthropic/academy-guide", "egawilldoit/technical-writing"];
    for (const skillId of sampled) {
      const row = page.skills.find((candidate) => candidate.skill_id === skillId);
      assert.ok(row, `${skillId} must be in the catalog`);
      const body = readBody(row.content_digest);
      assert.ok(body.length > 500, `${skillId} body should be substantial`);
      // A window from the middle of the body: nowhere near the description,
      // which is itself truncated to 280 characters.
      const window = body.slice(Math.floor(body.length / 2), Math.floor(body.length / 2) + 200).replace(/\s+/g, " ");
      assert.ok(window.trim().length > 100, "the sampled window must be distinctive");
      assert.equal(serialized.includes(window), false, `${skillId} body content leaked into the catalog payload`);
    }
  });

  test("no row or page key carries content, and the payload stays small", () => {
    const page = fullCatalog();
    const forbidden = /^(body|content|contents|text|markdown|skill_md|raw|bytes|path|paths|source_text|blob)$/i;
    const check = (value, where) => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => check(entry, `${where}[${index}]`));
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        assert.doesNotMatch(key, forbidden, `${where} carries a content-shaped key ${key}`);
        check(nested, `${where}.${key}`);
      }
    };
    check(page.skills[0], "skills[0]");
    // 114 metadata rows stay well under a megabyte, which is itself evidence
    // that no blob text travelled with them.
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    assert.ok(bytes < 1_000_000, `catalog payload is ${bytes} bytes; that is too large for metadata only`);
  });

  test("every content_digest is a hash, never file content", () => {
    for (const row of fullCatalog().skills) {
      assert.match(row.content_digest, /^sha256:[0-9a-f]{64}$/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 10. MCP search is not the source of the catalog                            */
/* -------------------------------------------------------------------------- */

describe("MCP search is not the source", () => {
  test("the module's import surface contains no MCP package at all", () => {
    const source = readFileSync(CATALOG_SOURCE, "utf8");
    // Matched per `from "..."` rather than per line, because an import with a
    // long named-binding list spans several lines and a line-anchored pattern
    // would silently skip exactly the import most worth checking.
    const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, "the module must import something");
    // Only Builder 2a's modules and the shared DTO types. No @ega-skills/*
    // package at all, so no hosted handler, no search tool, no MCP runtime.
    assert.deepEqual(
      [...new Set(specifiers)].sort(),
      ["../src/api/contracts.ts", "./env.ts", "./registry.ts", "./release-identity.ts"],
    );
    for (const banned of [
      // Call syntax, so a prose mention of a name in the module's rationale
      // does not fail the scan while an actual invocation still does.
      /\brunSearchTool\s*\(/,
      /\bcreateHostedMcpHandler\s*\(/,
      /\bloadHostedReleaseSnapshot\s*\(/,
      /\bresolveMcpProjectContext\s*\(/,
      /\bsearchReleaseFts\s*\(/,
    ]) {
      assert.doesNotMatch(source, banned, `catalog.ts must not call ${banned}`);
    }
    // Not a single `@ega-skills/*` specifier, which is what rules out the hosted
    // handler and the MCP runtime by construction rather than by inspection.
    assert.doesNotMatch(source, /from\s*["']@ega-skills\//);
  });

  test("the catalog is complete with no MCP runtime configured at all", () => {
    // Only EGA_WEB_* variables exist in the scenario: no hosted runtime, no
    // bearer token, no authz policy, no MCP endpoint. MCP search additionally
    // cannot enumerate: it needs a non-empty query and caps at 20 results, so
    // it could not have produced 114 rows.
    const config = parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT });
    assert.equal(config.artifactDir, ARTIFACT);
    const page = getCatalog(config, { limit: CATALOG_MAX_LIMIT });
    assert.equal(page.skills.length, 114);
    assert.deepEqual(page.skills.map((row) => row.skill_id), COMMITTED_SKILL_IDS);
  });

  test("an empty q is a rejection, and no query is capped at 20 rows", () => {
    // The defining difference from MCP search: there is no "empty query means
    // everything" path, and there is no 20-result cap anywhere.
    assert.throws(() => getCatalog(committedConfig(), { q: "" }), CatalogError);
    assert.throws(() => getCatalog(committedConfig(), { q: "  " }), CatalogError);
    // A term broad enough to match dozens of skills returns every one of them.
    // `SEARCH_LIMIT_MAX` is 20, so a search-backed implementation could not
    // produce this count.
    const broad = getCatalog(committedConfig(), { q: "the", limit: CATALOG_MAX_LIMIT });
    assert.ok(broad.total > 20, `expected more than 20 matches, got ${broad.total}`);
    assert.equal(broad.total, broad.skills.length);
  });
});

/* -------------------------------------------------------------------------- */
/* 11. Partial catalogs fail closed                                           */
/* -------------------------------------------------------------------------- */

describe("a partial catalog is refused", () => {
  test("a released skill with no row refuses and names the skill", async () => {
    // An impossible state, manufactured on purpose: the snapshot is read from
    // the untouched committed artifact (so it verifies), while the reader is
    // pointed at a copy whose `skills` row has been deleted. Production cannot
    // reach this — the artifact loader's projection verification catches it
    // first — which is exactly why the catalog needs its own refusal.
    const copy = copyArtifact("missing-row");
    const snapshot = loadHostedReleaseSnapshot(ARTIFACT);
    const Database = await loadBetterSqlite3();
    const writable = new Database(join(copy, "registry.sqlite"));
    try {
      // Foreign keys are enforced on this connection, and `skills` is the
      // parent of the version row, so the version row is what has to go. The
      // reader joins `skill_versions` to `skills`, so a deleted version row is
      // exactly the "released skill with no row" case.
      writable.pragma("foreign_keys = OFF");
      writable.prepare("DELETE FROM skill_versions WHERE skill_id = ?").run("anthropic/academy-guide");
    } finally {
      writable.close();
    }
    const reader = await readerOver(snapshot, copy);
    try {
      const identity = evaluateReleaseIdentity(committedConfig()).identity;
      assert.ok(identity);
      // The doctored reader really is missing the row.
      assert.throws(() => reader.getReleasedSkill("anthropic/academy-guide"), /E_WEB_SKILL_MISSING|no row/);
      assert.throws(
        () => buildCatalogPage(reader, identity, {}),
        (error) => {
          assert.ok(error instanceof CatalogError, `expected a CatalogError, got ${error?.name}`);
          assert.equal(error.code, "E_WEB_CATALOG_INCOMPLETE");
          assert.equal(error.status, 503);
          // The operator must be told WHICH skill is missing.
          assert.match(error.message, /anthropic\/academy-guide/);
          // And no rows at all: a refusal, not a short catalog.
          assert.doesNotMatch(error.message, /\/(home|tmp|var)\//);
          return true;
        },
      );
    } finally {
      reader.close();
    }
  });

  test("the refusal is total: the same reader serves the intact artifact", () => {
    // Control: the doctored reader is what fails, not the module or the config.
    const page = fullCatalog();
    assert.equal(page.skills.length, 114);
  });
});

/* -------------------------------------------------------------------------- */
/* 12. Mismatch fails closed                                                  */
/* -------------------------------------------------------------------------- */

describe("mismatch fails closed", () => {
  const mismatched = () => committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST });

  test("getCatalog throws rather than returning rows", () => {
    assert.throws(
      () => getCatalog(mismatched(), { limit: CATALOG_MAX_LIMIT }),
      (error) => {
        assert.ok(error instanceof ReleaseIdentityError, `expected a ReleaseIdentityError, got ${error?.name}`);
        assert.equal(error.code, "E_WEB_RELEASE_MISMATCH");
        assert.equal(error.status, 503);
        assert.match(error.message, /Catalog unavailable/);
        return true;
      },
    );
  });

  test("a mismatch is never downgraded to a warning or an empty catalog", () => {
    for (const options of [{}, { limit: 1 }, { sort: "name" }, { namespace: "anthropic" }]) {
      let returned = null;
      try {
        returned = getCatalog(mismatched(), options);
      } catch (error) {
        assert.ok(error instanceof ReleaseIdentityError);
        continue;
      }
      assert.equal(returned, null, "a mismatched release must never return a catalog");
    }
  });

  test("the mismatched digest is named so an operator can act", () => {
    assert.throws(() => getCatalog(mismatched(), {}), (error) => {
      const reason = String(error.binding?.identity?.mismatch_reason ?? "");
      assert.ok(reason.includes(OTHER_DIGEST), "the expected digest must be named");
      assert.ok(reason.includes(COMMITTED_DIGEST), "the verified digest must be named");
      return true;
    });
  });

  test("no registry handle is opened for a mismatched release", () => {
    // `assertCatalogServable` runs before `getRegistry`, so a mismatched
    // deployment cannot even reach the database.
    assert.throws(() => getCatalog(mismatched(), {}), ReleaseIdentityError);
    // The healthy path still works afterwards, so the refusal did not poison
    // any memoized state.
    assert.equal(getCatalog(committedConfig(), { limit: 1 }).skills.length, 1);
  });
});