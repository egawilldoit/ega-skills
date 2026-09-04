// Golden registry/project setup for TEST-001 router scenarios (EGA-580).
//
// buildRegistryForCatalog(catalogName, skips): materializes every skill in a
// named SKILL_CATALOGS entry via skill-materialize.mjs, writes the tree the
// same byte-deterministic way build-hashes.mjs does (routing frontmatter
// stripped for the strict production schema; boundary L2 fixtures re-padded
// to their exact token targets), and imports each skill into a FRESH temp
// EGA_SKILLS_HOME through the production importer. Namespaces come from the
// canonical id (`ega/...` or `experimental/...`). Returns {home, versionHashes}.
//
// Catalog isolation contract: every call creates its own temp home, so two
// catalogs can never share registry state (e.g. the `mobile-ui` alias claim
// of ega/frontend-mobile can never collide with the excluded alias-conflict
// fixture). router-default is additionally asserted to hold exactly 16
// current versions before the helper returns.
//
// buildGoldenProject(fixtureId, extra): builds a REAL project directory tree
// via project-fixtures.mjs under a fresh temp root. `extra` (optional) is a
// record of relative path -> file content written into the fixture root after
// the table build completes. Returns {dir, projectPath}.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCurrentVersion,
  importSkills,
  openRegistry,
} from "../../../packages/registry/dist/index.js";
import {
  SKILL_CATALOGS,
  SKILL_FIXTURES,
} from "./catalog-data.mjs";
import { buildProjectFixture } from "./project-fixtures.mjs";
import {
  countContentTokens,
  materializeSkill,
} from "./skill-materialize.mjs";

/**
 * Reduce the materialized SKILL.md to production-valid portable frontmatter.
 * The production parser's portableFrontmatterSchema is strict (name,
 * description, license, compatibility, metadata, allowed-tools only) — the
 * routing fields materializeSkill() emits for visibility (domains/platforms/
 * frameworks/triggers) fail the import, so they are dropped here, exactly as
 * build-hashes.mjs does. Routing relevance must therefore flow through
 * ega.yaml if it is to reach the resolver at all (see setup.test.mjs smoke).
 */
function productionSkillMd(skillMd) {
  const lines = skillMd.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) {
    throw new Error(`materialized SKILL.md lacks YAML frontmatter delimiters`);
  }
  const kept = lines
    .slice(1, end)
    .filter((line) => /^(name|description): /.test(line));
  return ["---", ...kept, ...lines.slice(end)].join("\n");
}

// Same neutral filler sentence the materializer uses: no routing significance,
// carries none of the fixture trigger phrases, tokenizes deterministically.
const FILLER_SENTENCE =
  "This neutral filler sentence carries no routing significance; it exists solely to calibrate deterministic token budgets for golden materialization.";

/**
 * Pad `text` to an exact production-estimator token target. Sanitizing the
 * frontmatter removes the routing-field lines the materializer budgeted, so
 * boundary L2 fixtures fall short of their exact targets; re-pad with whole
 * filler sentences, then deterministic word-prefix probes of a single
 * sentence for the exact residual (same strategy as build-hashes.mjs, which
 * produced the frozen golden-hashes.json from these exact file bytes).
 */
function padToExactTokens(text, targetTokens) {
  let current = text;
  let tokens = countContentTokens(current);
  let iterations = 0;
  while (tokens < targetTokens && iterations < 100) {
    const unit = `\n${FILLER_SENTENCE}`;
    const marginal = countContentTokens(`${current}${unit}`) - tokens;
    if (marginal <= 0) break;
    const remaining = targetTokens - tokens;
    if (remaining < marginal) {
      const words = FILLER_SENTENCE.split(" ");
      let matched = false;
      for (let k = 1; k <= words.length && iterations < 100; k += 1) {
        const prefix = words.slice(0, k).join(" ");
        if (countContentTokens(`${current}\n${prefix}`) - tokens === remaining) {
          current = `${current}\n${prefix}`;
          matched = true;
          break;
        }
        iterations += 1;
      }
      if (!matched) break;
      tokens = countContentTokens(current);
      break;
    }
    current += unit;
    tokens += marginal;
    iterations += 1;
  }
  const finalTokens = countContentTokens(current);
  if (finalTokens !== targetTokens) {
    throw new Error(
      `padding reached ${finalTokens} tokens, target ${targetTokens} unreachable`,
    );
  }
  return current;
}

/** Registry namespace for a fixture: the part before the `/` of its canonical id. */
function namespaceOf(canonicalId) {
  return canonicalId.slice(0, canonicalId.indexOf("/"));
}

/** Portable (directory) name: the part after the single `/` of the canonical id. */
function portableNameOf(canonicalId) {
  return canonicalId.slice(canonicalId.indexOf("/") + 1);
}

function fixtureById(fixtureId) {
  const fixture = SKILL_FIXTURES.find((entry) => entry.fixtureId === fixtureId);
  if (fixture === undefined) {
    throw new RangeError(`Unknown skill fixture id: ${fixtureId}`);
  }
  return fixture;
}

/**
 * Build a fresh isolated registry for one named skill catalog.
 * @param {string} catalogName Key of a SKILL_CATALOGS entry.
 * @param {string[]} [skips] Fixture IDs to omit from the catalog build.
 * @returns {Promise<{home: string, versionHashes: Record<string, string>}>}
 *   `home` is the fresh temp EGA_SKILLS_HOME (owned by the caller; never
 *   reused across catalogs) and `versionHashes` maps fixtureId -> current
 *   version hash as read back from the registry.
 * @throws {Error} CATALOG_IMPORT_FAILED when any skill import fails, or
 *   CATALOG_COUNT_INVALID when router-default does not hold exactly 16
 *   current versions.
 */
export async function buildRegistryForCatalog(catalogName, skips = []) {
  const catalog = SKILL_CATALOGS[catalogName];
  if (catalog === undefined) {
    throw new RangeError(`Unknown catalog name: ${catalogName}`);
  }
  const skipSet = new Set(skips);
  const fixtureIds = catalog.filter((fixtureId) => !skipSet.has(fixtureId));

  const base = await mkdtemp(join(tmpdir(), "ega-golden-registry-"));
  const home = join(base, "home");
  await mkdir(home, { recursive: true });

  const versionHashes = {};
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    for (const fixtureId of fixtureIds) {
      const fixture = fixtureById(fixtureId);
      const namespace = namespaceOf(fixture.canonicalId);
      const name = portableNameOf(fixture.canonicalId);
      const root = join(base, "src", namespace, name);

      const materialized = materializeSkill(fixture);
      let skillMd = productionSkillMd(materialized.skillMd);
      if (fixture.l2.tokenTarget !== null && fixture.l2.tokenTarget !== undefined) {
        // Boundary L2 fixture: the sanitized doc falls short of the exact
        // target (the materializer budgeted the stripped routing lines).
        skillMd = padToExactTokens(skillMd, fixture.l2.tokenTarget);
      }
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "SKILL.md"), skillMd);
      if (materialized.coreMdOrNull !== null) {
        await writeFile(join(root, "SKILL.core.md"), materialized.coreMdOrNull);
      }
      await writeFile(join(root, "ega.yaml"), materialized.egaYaml);

      const summary = await importSkills(registry, { path: root, namespace });
      if (summary.failed !== 0) {
        throw new Error(
          `CATALOG_IMPORT_FAILED: ${catalogName} import failed for ${fixtureId}: ${JSON.stringify(summary.failures)}`,
        );
      }
      const skillId = `${namespace}/${name}`;
      const version = getCurrentVersion(registry.db, skillId);
      versionHashes[fixtureId] = version.versionHash;
    }
  } finally {
    registry.close();
  }

  if (catalogName === "router-default" && Object.keys(versionHashes).length !== 16) {
    throw new Error(
      `CATALOG_COUNT_INVALID: router-default built ${Object.keys(versionHashes).length} current versions, expected exactly 16`,
    );
  }
  return { home, versionHashes };
}

/**
 * Build a real golden project directory tree under a fresh temp root.
 * @param {string} fixtureId Logical project fixture ID (PROJECT_FIXTURES).
 * @param {Record<string, string>} [extra] Optional relative path -> content
 *   files written into the fixture root after the table build.
 * @returns {Promise<{dir: string, projectPath: string}>} `dir` is the temp
 *   root holding the tree; `projectPath` is the effective project path per
 *   the §5.1.1.3 `projectPath` column.
 */
export async function buildGoldenProject(fixtureId, extra) {
  const base = await mkdtemp(join(tmpdir(), "ega-golden-project-"));
  const dir = join(base, "fixture");
  const projectPath = buildProjectFixture(fixtureId, dir);
  if (extra !== undefined) {
    for (const [relPath, content] of Object.entries(extra)) {
      const target = join(projectPath, relPath);
      const slash = target.lastIndexOf("/");
      await mkdir(slash > 0 ? target.slice(0, slash) : projectPath, { recursive: true });
      await writeFile(target, content);
    }
  }
  return { dir, projectPath };
}