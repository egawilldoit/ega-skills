/**
 * Category browsing: presentation categories over the governed catalog (EGA-724).
 *
 * ## What this file executes
 *
 * The categories the Skills page renders are the catalog's own values for
 * `namespace`, `domain`, `framework` and the human-intent presentation `group`
 * — the panel holds no registry of its own. These tests execute that claim
 * against the REAL committed release (`packages/mcp/artifact`, 116 skills)
 * rather than trusting the source:
 *
 * 1. every axis the panel declares is a filter the catalog really accepts, and
 *    selecting it returns exactly the release's members of that category;
 * 2. a category the release does not contain yields zero rows and no fabricated
 *    identifier, so the page can only report an honest empty result;
 * 3. the detail route a category row links to reports the release's own pinned
 *    version and its release identity — and refuses an unknown id (404) and a
 *    mismatched release, so no category click can bypass those refusals.
 *
 * The `group` axis is the `catalog/presentation.yaml` projection behind the
 * same seam: group membership is validated against the release's own
 * `skill_versions` map, and the selection resolves through the existing
 * catalog reader — no second catalog, no hardcoded registry.
 *
 * ## Fixture policy
 *
 * The mismatch case copies the committed artifact to a temp directory and mutates
 * THE COPY; the committed artifact is never written to. The file list is checked
 * before/after so "read-only" is asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";

import { parseServerConfig } from "../../apps/web/server/env.ts";
import { CATALOG_MAX_LIMIT, getCatalog } from "../../apps/web/server/catalog.ts";
import { closeRegistry } from "../../apps/web/server/registry.ts";
import { getSkillDetail } from "../../apps/web/server/skills.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");
const PRESENTATION_YAML = join(REPO_ROOT, "catalog", "presentation.yaml");
const CATEGORY_COMPONENT = join(
  REPO_ROOT,
  "apps",
  "web",
  "src",
  "components",
  "CategoryBrowse.tsx",
);

/** The release's own authoritative `skill_id -> version_hash` map. */
const COMMITTED_RELEASE = JSON.parse(readFileSync(join(ARTIFACT, "hub-release.json"), "utf8"));
const COMMITTED_SKILLS = COMMITTED_RELEASE.payload.skill_versions;
const COMMITTED_SKILL_IDS = Object.keys(COMMITTED_SKILLS);

/** A different but syntactically valid digest, for the mismatch scenario. */
const OTHER_DIGEST = `sha256:${"0".repeat(64)}`;

function committedConfig(extraEnv = {}) {
  return parseServerConfig({ EGA_WEB_ARTIFACT_DIR: ARTIFACT, ...extraEnv });
}

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
      if (statSync(full).isDirectory()) walk(full);
      else
        digests.set(
          full.slice(ARTIFACT.length),
          createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
    }
  };
  walk(dir);
  return digests;
}

const ARTIFACT_DIGESTS_BEFORE = digestEveryFile(ARTIFACT);
const tempDirs = [];

function copyArtifact(label) {
  const dir = mkdtempSync(join(tmpdir(), `ega-web-category-${label}-`));
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
/* The axes the panel actually declares                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the panel's axis list out of its source.
 *
 * `node --test` cannot import a `.tsx` module, so the declaration is parsed the
 * same way `catalog.test.mjs` parses the SPA's copy of the sort keys: by string,
 * with the executed contract asserted immediately afterwards. The point is not
 * to trust the string but to make the page's declaration the input to a real
 * `getCatalog` call.
 */
function declaredAxes() {
  const source = readFileSync(CATEGORY_COMPONENT, "utf8");
  const block = /const AXES[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(source);
  assert.ok(block, "CategoryBrowse.tsx must declare an AXES list");
  const axes = [...block[1].matchAll(/key:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*facet:\s*"([^"]+)"/g)].map(
    (match) => ({ key: match[1], label: match[2], facet: match[3] }),
  );
  assert.ok(axes.length > 0, "the panel must declare at least one axis");
  return axes;
}

describe("the categories the panel renders are the catalog's own categories", () => {
  test("every declared axis names a facet value list the server really returns", () => {
    const page = fullCatalog();
    const axes = declaredAxes();
    for (const axis of axes) {
      assert.ok(
        Array.isArray(page.facets[axis.facet]),
        `axis ${axis.key} must read the real facet list ${axis.facet}`,
      );
      assert.ok(
        page.facets[axis.facet].length > 0,
        `the committed release has no ${axis.facet}; the axis would render nothing and should not claim otherwise`,
      );
    }
    // The panel maps each axis onto a filter `/skills` accepts. Assert that set
    // is exactly the catalog's, so the panel cannot offer a selection the server
    // has no filter for.
    assert.deepEqual(
      axes.map((axis) => axis.key).sort(),
      ["domain", "framework", "group", "namespace"],
    );
  });

  test("selecting a namespace category returns exactly the release's members of it", () => {
    const namespaces = fullCatalog().facets.namespaces.map((entry) => entry.value);
    const target = namespaces.find((value) => value === "mattpocock");
    assert.ok(target, "the committed release must still contain the mattpocock namespace");

    const expected = COMMITTED_SKILL_IDS.filter((id) => id.startsWith(`${target}/`));
    assert.ok(expected.length > 0, "the chosen category must cover at least one real skill");
    const page = getCatalog(committedConfig(), { namespace: target, limit: CATALOG_MAX_LIMIT });

    assert.equal(page.total, expected.length);
    assert.deepEqual(
      page.skills.map((row) => row.skill_id).sort(),
      [...expected].sort(),
      "a category selection may never add, drop or rename a released skill",
    );
    for (const row of page.skills) {
      assert.equal(row.namespace, target);
      // Every row is a real release member with the release's own version pin.
      assert.equal(COMMITTED_SKILLS[row.skill_id], row.version_hash);
    }
  });

  test("the groups facet exposes the presentation groups with real counts", () => {
    const groups = fullCatalog().facets.groups;
    assert.ok(groups.length === 13, `the committed presentation defines 13 groups, got ${groups.length}`);
    for (const entry of groups) {
      assert.ok(entry.skill_count > 0, `group ${entry.value} must cover at least one real skill`);
    }
    const verify = groups.find((entry) => entry.value === "verify");
    assert.ok(verify, "the committed presentation must still contain the verify group");
  });

  test("selecting a presentation group returns exactly the release's members of it", () => {
    const expected = presentationGroupMembers("verify");
    assert.ok(expected.length > 0, "the verify group must cover at least one real skill");
    // Every member the presentation file names must be a real release member.
    for (const id of expected) {
      assert.ok(COMMITTED_SKILL_IDS.includes(id), `${id} in group verify must be a released skill`);
    }
    const page = getCatalog(committedConfig(), { group: "verify", limit: CATALOG_MAX_LIMIT });

    assert.equal(page.total, expected.length);
    assert.deepEqual(
      page.skills.map((row) => row.skill_id).sort(),
      [...expected].sort(),
      "a group selection may never add, drop or rename a released skill",
    );
    assert.equal(page.applied_filters.group, "verify");
    for (const row of page.skills) {
      // Every row is a real release member with the release's own version pin.
      assert.equal(COMMITTED_SKILLS[row.skill_id], row.version_hash);
    }
  });
});

/**
 * Members of one presentation group, read from the committed
 * `catalog/presentation.yaml` — the same source the server projects.
 *
 * Parsed by string (the file's shape is stable: `- id: <group>` then a
 * `skills:` list), so this test needs no YAML dependency to state the
 * independent expectation the server's filter must satisfy.
 */
function presentationGroupMembers(groupId) {
  const text = readFileSync(PRESENTATION_YAML, "utf8");
  const lines = text.split("\n");
  let inTarget = false;
  let inSkills = false;
  const members = [];
  for (const line of lines) {
    const idMatch = /^  - id:\s*(\S+)\s*$/.exec(line);
    if (idMatch) {
      inTarget = idMatch[1] === groupId;
      inSkills = false;
      continue;
    }
    if (!inTarget) continue;
    if (/^\s*skills:\s*$/.test(line)) {
      inSkills = true;
      continue;
    }
    if (inSkills) {
      const skillMatch = /^\s*-\s*([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\s*$/.exec(line);
      if (skillMatch) {
        members.push(skillMatch[1]);
        continue;
      }
      // A non-list line ends the skills block (next key or next group).
      if (/^\S/.test(line) || /^  [a-z]/.test(line)) break;
    }
  }
  assert.ok(members.length > 0, `presentation group ${groupId} must list at least one skill`);
  return members;
}

/* -------------------------------------------------------------------------- */
/* Negatives                                                                   */
/* -------------------------------------------------------------------------- */

describe("a category cannot fabricate a skill", () => {
  test("a category the release does not contain returns zero rows and zero total", () => {
    const page = getCatalog(committedConfig(), { namespace: "not-a-real-namespace", limit: CATALOG_MAX_LIMIT });
    assert.equal(page.total, 0);
    assert.deepEqual(page.skills, [], "an unknown category must not produce rows");
    // And the facets it echoes back are still the release's, not invented ones.
    for (const entry of page.facets.namespaces) {
      assert.ok(COMMITTED_SKILL_IDS.some((id) => id.startsWith(`${entry.value}/`)));
    }
  });

  test("an unknown presentation group returns zero rows and stays recoverable", () => {
    const page = getCatalog(committedConfig(), { group: "not-a-real-group", limit: CATALOG_MAX_LIMIT });
    assert.equal(page.total, 0);
    assert.deepEqual(page.skills, [], "an unknown group must not produce rows");
    assert.equal(page.applied_filters.group, "not-a-real-group");
    // Facets over an empty filtered set are honestly empty — no group invented.
    assert.deepEqual([...page.facets.groups], []);
    // And the unfiltered catalog is unaffected: the empty result is recoverable
    // and the release's real 13 groups are still there.
    const unfiltered = fullCatalog();
    assert.ok(unfiltered.total > 0);
    assert.equal(unfiltered.facets.groups.length, 13);
  });

  test("an unknown skill id reached from a category is a 404, not a nearest match", () => {
    let thrown;
    try {
      getSkillDetail(committedConfig(), "anthropic/does-not-exist");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "an unknown id must be refused");
    assert.equal(thrown.code, "E_WEB_SKILL_NOT_RELEASED");
    assert.equal(thrown.status, 404);
    assert.ok(!COMMITTED_SKILL_IDS.includes("anthropic/does-not-exist"));
  });

  test("a mismatched release refuses both the category catalog and the detail", () => {
    const mismatched = () => committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: OTHER_DIGEST });

    assert.throws(() => getCatalog(mismatched(), { namespace: "mattpocock" }), (error) => {
      assert.equal(error.code, "E_WEB_RELEASE_MISMATCH");
      assert.equal(error.status, 503);
      return true;
    });

    assert.throws(() => getSkillDetail(mismatched(), "mattpocock/pr"), (error) => {
      assert.equal(error.code, "E_WEB_RELEASE_MISMATCH");
      assert.equal(error.status, 503);
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Category -> verified skill detail                                           */
/* -------------------------------------------------------------------------- */

describe("a category row links to a detail that reflects the verified release", () => {
  test("the first skill of a category opens with the release's pinned version and identity", () => {
    const page = getCatalog(committedConfig(), { namespace: "mattpocock", limit: CATALOG_MAX_LIMIT });
    const row = page.skills[0];
    assert.ok(row, "the category must list a real skill");

    // The list itself is attributed to a verified snapshot. Without an
    // authoritative expectation the artifact is fully verified but `unpinned`,
    // and the console says so rather than calling it stable.
    assert.equal(page.release.status, "unpinned");
    assert.equal(page.release.mismatch_reason, null);
    const pinnedDigest = page.release.release_digest;

    // Pin the deployment to the digest it just verified: the same detail now
    // reports `stable`, which is the release identity the page renders.
    const detail = getSkillDetail(
      committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: pinnedDigest }),
      row.skill_id,
    );
    assert.equal(detail.summary.skill_id, row.skill_id);
    assert.equal(detail.summary.version_hash, COMMITTED_SKILLS[row.skill_id]);
    assert.equal(detail.release.release_digest, pinnedDigest);
    assert.equal(detail.release.status, "stable");
    assert.equal(detail.release.mismatch_reason, null);
  });

  test("a presentation-group row opens with the release's pinned version and identity", () => {
    const page = getCatalog(committedConfig(), { group: "verify", limit: CATALOG_MAX_LIMIT });
    const row = page.skills.find((candidate) => candidate.skill_id === "egawilldoit/verify-this");
    assert.ok(row, "the verify group must list egawilldoit/verify-this");

    assert.equal(page.release.status, "unpinned");
    assert.equal(page.release.mismatch_reason, null);
    const pinnedDigest = page.release.release_digest;

    const detail = getSkillDetail(
      committedConfig({ EGA_WEB_EXPECTED_RELEASE_DIGEST: pinnedDigest }),
      row.skill_id,
    );
    assert.equal(detail.summary.skill_id, "egawilldoit/verify-this");
    assert.equal(detail.summary.version_hash, COMMITTED_SKILLS["egawilldoit/verify-this"]);
    assert.equal(detail.summary.version_hash, row.version_hash);
    assert.equal(detail.release.release_digest, pinnedDigest);
    assert.equal(detail.release.status, "stable");
    assert.equal(detail.release.mismatch_reason, null);
  });
});

/* -------------------------------------------------------------------------- */
/* No second authority                                                         */
/* -------------------------------------------------------------------------- */

describe("the presentation layer owns no catalog of its own", () => {
  test("the panel declares no skill id, no endpoint and no fetch", () => {
    const source = readFileSync(CATEGORY_COMPONENT, "utf8");
    // A hardcoded id would be the second catalog this feature must not have.
    assert.doesNotMatch(source, /["'`][a-z0-9-]+\/[a-z0-9-]+["'`]/i, "no literal namespace/name skill id");
    assert.doesNotMatch(source, /fetch\(|useApiClient|API_ENDPOINTS/, "the panel reads no endpoint of its own");
    assert.doesNotMatch(source, /domains:\s*\[|triggers:\s*\[/, "the panel carries no routing metadata");
  });
});
