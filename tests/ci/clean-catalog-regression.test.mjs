/**
 * Clean-catalog regression coverage for the catalog reset.
 *
 * These tests are fixture-based on purpose: they must keep working when the
 * committed active catalog is emptied AND when it later grows again. They do
 * not pin a skill count and do not require specific historical skill ids.
 *
 * Frozen contracts exercised here: SPEC-002 (release identity), SPEC-003
 * (registry-backed discovery), SPEC-004 (presentation is never routing
 * authority), SPEC-005 (empty eligible catalogs are legal), and the
 * `catalog:check` staleness gate in CI.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildCatalogModel,
  CatalogError,
  CATALOG_PRESENTATION_SCHEMA_VERSION,
  renderCatalogMarkdown,
  renderCatalogText,
  validatePresentation,
} from "../../packages/cli/dist/index.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const GENERATE = join(ROOT, "scripts/catalog/generate.mjs");

/** A presentation with zero favorites and zero groups: the reset end state. */
function emptyPresentation(overrides = {}) {
  return {
    catalog_version: CATALOG_PRESENTATION_SCHEMA_VERSION,
    favorites: [],
    groups: [],
    ...overrides,
  };
}

/**
 * A model for a zero-skill release. Built structurally instead of through
 * `buildCatalogModel` so the rendering assertions stay independent of the
 * presentation-validation change required by the reset.
 */
function emptyModel() {
  return {
    favorites: [],
    groups: [],
    ungroupedTitle: "Other",
    ungrouped: [],
    multiGroup: [],
    skillCount: 0,
    namespaces: [],
  };
}

// --- valid empty catalog ---------------------------------------------------

test("Markdown rendering handles a zero-skill release deterministically", () => {
  const identity = { digest: "sha256:" + "a".repeat(64), hubId: "personal" };
  const a = renderCatalogMarkdown(emptyModel(), identity);
  const b = renderCatalogMarkdown(emptyModel(), identity);
  assert.equal(a, b, "empty catalog rendering must be byte-identical");
  assert.match(a, /Skills in this release: \*\*0\*\* across 0 namespace\(s\)/u);
  assert.match(a, /Hub Release: sha256:[0-9a-f]{64}/u);
  assert.match(a, /Do not edit manually/u);
  assert.doesNotMatch(a, /^### /mu, "an empty catalog must not contain skill headings");
  const sectionHeadings = a.match(/^## .+$/gmu) ?? [];
  assert.deepEqual(
    sectionHeadings,
    ["## START HERE / COMMON TASKS"],
    "an empty catalog must contain only the fixed recognition section, no authored groups",
  );
});

test("terminal rendering handles a zero-skill release without emitting rows", () => {
  const text = renderCatalogText(emptyModel(), { digest: "sha256:" + "b".repeat(64) });
  assert.match(text, /^EGA SKILLS$/mu);
  assert.match(text, /0 skills in 0 namespaces/u);
  assert.doesNotMatch(text, /^  \S/mu, "an empty catalog must not print skill rows");
});

test("an empty presentation is valid for an empty release", () => {
  // Reset contract: source `validate_catalog.py` accepts zero skills with empty
  // provenance. The hub must match it. This also proves `buildCatalogModel`
  // can project an empty release without inventing skills.
  assert.doesNotThrow(
    () => validatePresentation(emptyPresentation(), new Set()),
    "validatePresentation must accept a zero-skill release: groups=[] and favorites=[]",
  );
  const model = buildCatalogModel(new Map(), emptyPresentation());
  assert.equal(model.skillCount, 0);
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.namespaces, []);
});

// --- invalid manifests still fail -----------------------------------------

test("a presentation referencing a removed skill still fails against an empty release", () => {
  assert.throws(
    () =>
      validatePresentation(
        emptyPresentation({
          groups: [{ id: "g", title: "G", skills: ["egawilldoit/verify-this"] }],
        }),
        new Set(),
      ),
    CatalogError,
  );
});

test("a presentation that carries routing authority still fails for an empty release", () => {
  for (const key of ["triggers", "anti_triggers", "domains", "aliases", "keywords"]) {
    assert.throws(
      () => validatePresentation(emptyPresentation({ [key]: ["x"] }), new Set()),
      CatalogError,
      `empty release must still reject routing key ${key}`,
    );
  }
});

test("a malformed empty presentation still fails closed", () => {
  for (const presentation of [
    { catalog_version: 99, favorites: [], groups: [] },
    { catalog_version: CATALOG_PRESENTATION_SCHEMA_VERSION, favorites: null, groups: [] },
    { catalog_version: CATALOG_PRESENTATION_SCHEMA_VERSION, favorites: [], groups: "not-a-list" },
  ]) {
    assert.throws(() => validatePresentation(presentation, new Set()), CatalogError);
  }
});

// --- stale generated catalog still fails the CI gate -----------------------

test("catalog:check fails on a stale or missing generated catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ega-clean-catalog-check-"));
  try {
    const good = join(dir, "current.md");
    await execFileAsync(process.execPath, [GENERATE, "--out", good], { cwd: ROOT });

    const stale = join(dir, "stale.md");
    await writeFile(stale, "This is not the generated catalog.\n", "utf8");
    const staleRun = await execFileAsync(process.execPath, [GENERATE, "--check", "--out", stale], { cwd: ROOT })
      .then((result) => result)
      .catch((error) => error);
    assert.notEqual(staleRun.status, 0, "a stale generated catalog must fail the check");
    assert.match(String(staleRun.stderr ?? ""), /stale/u);

    const missing = join(dir, "missing.md");
    const missingRun = await execFileAsync(process.execPath, [GENERATE, "--check", "--out", missing], { cwd: ROOT })
      .then((result) => result)
      .catch((error) => error);
    assert.notEqual(missingRun.status, 0, "a missing generated catalog must fail the check");
    assert.match(String(missingRun.stderr ?? ""), /missing/u);

    const currentRun = await execFileAsync(process.execPath, [GENERATE, "--check", "--out", good], { cwd: ROOT });
    assert.match(currentRun.stdout, /catalog:check OK/u);
    const committed = await readFile(join(ROOT, "docs/generated/SKILL-CATALOG.md"), "utf8");
    assert.equal(await readFile(good, "utf8"), committed, "committed catalog must match the generator");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
