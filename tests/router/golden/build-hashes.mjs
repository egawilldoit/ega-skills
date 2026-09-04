// Golden hash builder for TEST-001 router scenarios (EGA-580).
// For every SKILL_FIXTURES entry: materialize via skill-materialize.mjs into
// a temp dir tree, import it into an isolated temp EGA_SKILLS_HOME registry
// through the production importer, and collect {versionHash, l1Status,
// l1Tokens, l2Tokens} straight from the registry (persisted token counts).
//
// First run (no golden-hashes.json yet) writes the frozen file (sorted keys,
// stable formatting). Every run deep-compares computed values against the
// file and throws GOLDEN_FIXTURE_INVALID listing the mismatches — the file is
// frozen once committed. Excludes nothing: all 20 fixtures are hashed,
// including the alias-conflict fixture (its router exclusion is enforced at
// the catalog level, not here; each fixture gets its own isolated registry so
// the shared `mobile-ui` alias claim can never collide).

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_FIXTURES } from "./catalog-data.mjs";
import {
  countContentTokens,
  materializeSkill,
} from "./skill-materialize.mjs";
import { EGA_O200K_V1_ESTIMATOR_ID } from "../../../packages/schema/dist/index.js";
import {
  getCurrentVersion,
  getTokenCount,
  importSkills,
  openRegistry,
} from "../../../packages/registry/dist/index.js";

const GOLDEN_PATH = fileURLToPath(new URL("./golden-hashes.json", import.meta.url));

/**
 * Reduce the materialized SKILL.md to production-valid portable frontmatter.
 * materializeSkill() emits routing fields (domains/platforms/frameworks/
 * triggers) in the YAML frontmatter for visibility, but the production
 * parser's portableFrontmatterSchema is strict and accepts only name,
 * description, license, compatibility, metadata, allowed-tools — extra keys
 * fail the import. We drop every frontmatter line except name/description
 * before writing (routing relevance lives in the body and ega.yaml anyway),
 * keeping skill-materialize.mjs itself untouched. Line-based and
 * deterministic: split on the leading/trailing --- delimiters.
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
// carries none of the fixture trigger phrases, and tokenizes deterministically.
const FILLER_SENTENCE =
  "This neutral filler sentence carries no routing significance; it exists solely to calibrate deterministic token budgets for golden materialization.";

/**
 * Pad `text` to an exact production-estimator token target. Sanitizing the
 * frontmatter removes the routing-field lines the materializer budgeted,
 * so boundary L2 fixtures fall short of their exact targets; re-pad here with
 * whole filler sentences, then deterministic word-prefix probes of a single
 * sentence for the exact residual (same strategy as the materializer).
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

/** Query the registry for the persisted token count of one control blob. */
function tokenCountFor(db, skillId, path) {
  const row = db
    .prepare("SELECT blob_hash AS blobHash FROM skill_files WHERE skill_id = ? AND path = ?")
    .get(skillId, path);
  if (row === undefined) return null;
  return getTokenCount(db, row.blobHash, EGA_O200K_V1_ESTIMATOR_ID);
}

/**
 * Materialize + import one fixture into its own isolated registry and return
 * the registry-derived {versionHash, l1Status, l1Tokens, l2Tokens}.
 */
async function hashOneFixture(fixture, base) {
  const name = portableNameOf(fixture.canonicalId);
  const root = join(base, "src", name);
  const home = join(base, "home", fixture.fixtureId);
  await mkdir(home, { recursive: true });

  const materialized = materializeSkill(fixture);
  let skillMd = productionSkillMd(materialized.skillMd);
  if (fixture.l2.tokenTarget !== null && fixture.l2.tokenTarget !== undefined) {
    // Boundary L2 fixture: the sanitized doc falls short of the exact target
    // (the materializer budgeted the stripped routing lines), so re-pad.
    skillMd = padToExactTokens(skillMd, fixture.l2.tokenTarget);
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), skillMd);
  if (materialized.coreMdOrNull !== null) {
    await writeFile(join(root, "SKILL.core.md"), materialized.coreMdOrNull);
  }
  await writeFile(join(root, "ega.yaml"), materialized.egaYaml);

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    const skillId = `${namespaceOf(fixture.canonicalId)}/${name}`;
    const summary = await importSkills(registry, {
      path: root,
      namespace: namespaceOf(fixture.canonicalId),
    });
    if (summary.failed !== 0) {
      throw new Error(
        `import failed for ${fixture.fixtureId}: ${JSON.stringify(summary.failures)}`,
      );
    }
    const version = getCurrentVersion(registry.db, skillId);
    const l2Tokens = tokenCountFor(registry.db, skillId, "SKILL.md");
    const l1Tokens =
      version.l1Status === "AUTHORED"
        ? tokenCountFor(registry.db, skillId, "SKILL.core.md")
        : null;
    return {
      versionHash: version.versionHash,
      l1Status: version.l1Status,
      l1Tokens,
      l2Tokens,
    };
  } finally {
    registry.close();
  }
}

/** Serialize sorted-by-fixtureId with stable 2-space formatting + trailing newline. */
function serialize(results) {
  const sorted = {};
  for (const fixtureId of Object.keys(results).sort()) {
    sorted[fixtureId] = results[fixtureId];
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** List per-fixture field mismatches between computed and stored (parsed). */
function mismatchList(computed, stored) {
  const lines = [];
  const fixtureIds = new Set([
    ...Object.keys(computed),
    ...Object.keys(stored ?? {}),
  ]);
  for (const fixtureId of [...fixtureIds].sort()) {
    const c = computed[fixtureId];
    const s = stored?.[fixtureId];
    if (s === undefined) {
      lines.push(`${fixtureId}: missing from golden file`);
      continue;
    }
    if (c === undefined) {
      lines.push(`${fixtureId}: stale entry not in computed output`);
      continue;
    }
    for (const field of ["versionHash", "l1Status", "l1Tokens", "l2Tokens"]) {
      if (c[field] !== s[field]) {
        lines.push(
          `${fixtureId}.${field}: computed ${JSON.stringify(c[field])} !== file ${JSON.stringify(s[field])}`,
        );
      }
    }
  }
  return lines;
}

/**
 * Build the frozen hash table for every SKILL_FIXTURES entry.
 * @returns {Promise<Record<string, {versionHash: string, l1Status: string, l1Tokens: number|null, l2Tokens: number|null}>>}
 *   Computed results keyed by fixtureId (keys sorted ascending).
 * @throws {Error} GOLDEN_FIXTURE_INVALID when the computed table diverges from
 *   the committed golden-hashes.json (first run writes the file instead).
 */
export async function buildFrozenHashes() {
  const base = await mkdtemp(join(tmpdir(), "ega-golden-hashes-"));
  try {
    const results = {};
    for (const fixture of SKILL_FIXTURES) {
      results[fixture.fixtureId] = await hashOneFixture(fixture, base);
    }
    const serialized = serialize(results);

    let storedText = null;
    try {
      storedText = await readFile(GOLDEN_PATH, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (storedText === null) {
      // First run: freeze the computed table.
      await writeFile(GOLDEN_PATH, serialized, "utf8");
      return results;
    }

    // Line-ending tolerance: a CRLF checkout (without eol enforcement) must
    // not fail byte-identical content — .gitattributes enforces LF repo-wide
    // and this comparison is belt-and-braces (spec values, not checkout bytes).
    if (storedText.replace(/\r\n/g, "\n") !== serialized) {
      let stored = null;
      try {
        stored = JSON.parse(storedText);
      } catch {
        // Fall through to the generic mismatch listing below.
      }
      const lines = mismatchList(results, stored ?? {});
      if (lines.length === 0) {
        lines.push("serialized formatting differs from golden-hashes.json");
      }
      throw new Error(
        `GOLDEN_FIXTURE_INVALID: computed hashes diverge from golden-hashes.json\n${lines.join("\n")}`,
      );
    }
    return results;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}