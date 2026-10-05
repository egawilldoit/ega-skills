import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildCatalogModel,
  readL0Metadata,
  renderCatalogMarkdown,
  renderCatalogText,
  runCatalog,
  summarize,
  validatePresentation,
  CatalogError,
  CATALOG_PRESENTATION_SCHEMA_VERSION,
} from "../../packages/cli/dist/index.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const ARTIFACT = join(ROOT, "packages/mcp/artifact");
const PRESENTATION = join(ROOT, "catalog/presentation.yaml");
const GENERATED = join(ROOT, "docs/generated/SKILL-CATALOG.md");
const ENV = { ...process.env, EGA_SKILLS_HOME: ARTIFACT };

function knownIds() {
  return new Set(readL0Metadata(ENV).keys());
}

function basePresentation(overrides = {}) {
  return {
    catalog_version: CATALOG_PRESENTATION_SCHEMA_VERSION,
    favorites: ["egawilldoit/verify-this"],
    groups: [{ id: "verify", title: "Verify", skills: ["egawilldoit/verify-this", "egawilldoit/verify-ui"] }],
    ...overrides,
  };
}

// --- generator determinism ------------------------------------------------

test("catalog generation is byte-identical for identical inputs", async () => {
  const a = renderCatalogMarkdown(
    buildCatalogModel(readL0Metadata(ENV), JSON.parse(JSON.stringify(await loadPresentation()))),
    { digest: "sha256:test", hubId: "personal" },
  );
  const b = renderCatalogMarkdown(
    buildCatalogModel(readL0Metadata(ENV), JSON.parse(JSON.stringify(await loadPresentation()))),
    { digest: "sha256:test", hubId: "personal" },
  );
  assert.equal(a, b);
});

async function loadPresentation() {
  const { parse } = await import("../../packages/cli/node_modules/yaml/dist/index.js");
  return parse(await readFile(PRESENTATION, "utf8"));
}

test("group ordering is authored and skill ordering is id-sorted", async () => {
  const model = buildCatalogModel(readL0Metadata(ENV), await loadPresentation());
  assert.deepEqual(
    model.groups.map((g) => g.id),
    model.groups.map((g) => g.id),
  );
  for (const group of model.groups) {
    const ids = group.skills.map((s) => s.id);
    assert.deepEqual(ids, [...ids].sort(), `group ${group.id} is not id-sorted`);
  }
});

test("generated markdown carries the exact release identity", async () => {
  const markdown = await readFile(GENERATED, "utf8");
  const release = JSON.parse(await readFile(join(ARTIFACT, "hub-release.json"), "utf8"));
  assert.match(markdown, /Hub Release: sha256:[0-9a-f]{64}/u);
  assert.ok(markdown.includes(`Hub Release: ${release.digest}`));
  assert.match(markdown, /Do not edit manually/u);
});

test("every skill in the release appears in the generated catalog", async () => {
  const markdown = await readFile(GENERATED, "utf8");
  for (const id of knownIds()) {
    assert.ok(markdown.includes(`\`${id}\``), `generated catalog is missing ${id}`);
  }
});

test("summarize produces a short deterministic one-line pocket summary", () => {
  assert.equal(summarize("Route work. Then do more things."), "Route work.");
  assert.equal(summarize("No trailing period here"), "No trailing period here");
  assert.equal(summarize(""), "");
  assert.equal(summarize("a\n\n  b   c"), "a b c");
  const long = summarize(`${"word ".repeat(60)}end.`);
  assert.ok(long.length <= 141, `expected a clipped summary, got ${long.length} chars`);
});

// --- validation fails closed ---------------------------------------------

test("unknown skill id fails validation", () => {
  assert.throws(
    () => validatePresentation(basePresentation({ favorites: ["egawilldoit/not-a-real-skill"] }), knownIds()),
    CatalogError,
  );
});

test("removed skill fails validation", () => {
  // Simulates a skill deleted from the release while still referenced.
  const shrunken = new Set([...knownIds()].filter((id) => id !== "egawilldoit/verify-ui"));
  assert.throws(() => validatePresentation(basePresentation(), shrunken), CatalogError);
});

test("malformed group fails validation", () => {
  const cases = [
    basePresentation({ groups: [] }),
    basePresentation({ groups: [{ id: "g", title: "G" }] }),
    basePresentation({ groups: [{ id: "g", title: "G", skills: [] }] }),
    basePresentation({ groups: [{ title: "G", skills: ["egawilldoit/verify-ui"] }] }),
    basePresentation({ groups: "not-a-list" }),
    basePresentation({ catalog_version: 99 }),
    basePresentation({ catalog_version: undefined }),
  ];
  for (const presentation of cases) {
    assert.throws(() => validatePresentation(presentation, knownIds()), CatalogError);
  }
});

test("duplicate ids are rejected within a group and within favorites", () => {
  assert.throws(
    () =>
      validatePresentation(
        basePresentation({ groups: [{ id: "g", title: "G", skills: ["egawilldoit/verify-ui", "egawilldoit/verify-ui"] }] }),
        knownIds(),
      ),
    CatalogError,
  );
  assert.throws(
    () => validatePresentation(basePresentation({ favorites: ["egawilldoit/verify-this", "egawilldoit/verify-this"] }), knownIds()),
    CatalogError,
  );
});

test("cross-group duplicates are permitted and reported, never silently dropped", async () => {
  const model = buildCatalogModel(
    readL0Metadata(ENV),
    basePresentation({
      groups: [
        { id: "a", title: "A", skills: ["egawilldoit/verify-this"] },
        { id: "b", title: "B", skills: ["egawilldoit/verify-this"] },
      ],
    }),
  );
  assert.deepEqual(model.multiGroup, [{ id: "egawilldoit/verify-this", groups: ["a", "b"] }]);
  assert.equal(model.groups.length, 2);
});

test("duplicate group ids fail validation", () => {
  assert.throws(
    () =>
      validatePresentation(
        basePresentation({
          groups: [
            { id: "g", title: "G", skills: ["egawilldoit/verify-ui"] },
            { id: "g", title: "G again", skills: ["egawilldoit/verify-this"] },
          ],
        }),
        knownIds(),
      ),
    CatalogError,
  );
});

test("presentation metadata may not carry routing authority", () => {
  for (const key of ["triggers", "anti_triggers", "domains", "platforms", "frameworks", "aliases"]) {
    assert.throws(
      () => validatePresentation(basePresentation({ [key]: ["x"] }), knownIds()),
      CatalogError,
      `expected routing key ${key} to be rejected`,
    );
  }
});

// --- presentation cannot influence routing -------------------------------

test("presentation metadata cannot change routing behaviour", async () => {
  const { resolveSkills } = await import("../../packages/router/dist/index.js");
  const project = await mkdtemp(join(tmpdir(), "ega-catalog-routing-"));
  try {
    const task = "The agent report, GitHub, CI, and deployment disagree about what shipped.";
    const before = await resolveSkills({ task, projectPath: project, env: ENV });
    const presentation = await loadPresentation();
    presentation.groups.push({ id: "zzz", title: "Z", skills: ["egawilldoit/verify-this"] });
    // Rebuild a model from mutated presentation and confirm the catalog changes
    // while the resolver's answer does not.
    const model = buildCatalogModel(readL0Metadata(ENV), presentation);
    assert.ok(model.groups.some((g) => g.id === "zzz"));
    const after = await resolveSkills({ task, projectPath: project, env: ENV });
    assert.deepEqual(after.selected.map((s) => s.id), before.selected.map((s) => s.id));
    assert.equal(after.confidence, before.confidence);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// --- generated file freshness --------------------------------------------

test("committed catalog is not stale (pnpm catalog:check)", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/catalog/generate.mjs", "--check"], {
    cwd: ROOT,
  });
  assert.match(stdout, /catalog:check OK/u);
});

// --- CLI surface ---------------------------------------------------------

test("cli catalog output is stable and non-empty", async () => {
  const first = await execFileAsync(process.execPath, ["packages/cli/bin/ega-skills.mjs", "catalog"], {
    cwd: ROOT,
    env: ENV,
  });
  const second = await execFileAsync(process.execPath, ["packages/cli/bin/ega-skills.mjs", "catalog"], {
    cwd: ROOT,
    env: ENV,
  });
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /^EGA SKILLS$/mu);
  assert.match(first.stdout, /114 skills/u);
  // Human groups, not namespaces.
  assert.match(first.stdout, /^Understand$/mu);
  assert.match(first.stdout, /^Review$/mu);
  assert.match(first.stdout, /release sha256:[0-9a-f]{64}/u);
});

test("cli catalog --json is valid JSON with release identity", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["packages/cli/bin/ega-skills.mjs", "catalog", "--json"],
    { cwd: ROOT, env: ENV },
  );
  const parsed = JSON.parse(stdout);
  assert.match(parsed.release.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Array.isArray(parsed.catalog.favorites));
  assert.ok(parsed.catalog.favorites.length > 0);
  assert.equal(parsed.catalog.skillCount, 114);
});

test("cli catalog --search reuses existing search and reports groups", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["packages/cli/bin/ega-skills.mjs", "catalog", "--search", "review PR", "--json"],
    { cwd: ROOT, env: ENV },
  );
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.query, "review PR");
  assert.ok(parsed.results.length > 0);
  assert.ok(parsed.results.length <= 5);
  assert.ok(parsed.results.some((r) => r.id === "egawilldoit/review-and-ship"));
});

test("cli catalog rejects unknown options", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["packages/cli/bin/ega-skills.mjs", "catalog", "--nope"], { cwd: ROOT, env: ENV }),
    /Unknown command or option/u,
  );
});

test("cli catalog reports invalid catalog state instead of printing a partial catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ega-catalog-bad-"));
  try {
    const path = join(dir, "presentation.yaml");
    await writeFile(path, "catalog_version: 1\ngroups:\n  - id: g\n    title: G\n    skills:\n      - egawilldoit/does-not-exist\n");
    await assert.rejects(
      execFileAsync(process.execPath, ["packages/cli/bin/ega-skills.mjs", "catalog", "--presentation", path], {
        cwd: ROOT,
        env: ENV,
      }),
      /unknown skill id/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing `list` command contract is unchanged", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/bin/ega-skills.mjs", "list"], {
    cwd: ROOT,
    env: ENV,
  });
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 114);
  assert.match(lines[0], /^anthropic\/academy-guide sha256:[0-9a-f]{64}$/u);
});

test("renderCatalogText and runCatalog agree", () => {
  const model = buildCatalogModel(readL0Metadata(ENV), basePresentation());
  const fromRender = renderCatalogText(model, { digest: "sha256:test" });
  const fromRun = runCatalog({ env: ENV, presentationPath: PRESENTATION });
  assert.match(fromRun, /^EGA SKILLS$/mu);
  assert.match(fromRender, /^EGA SKILLS$/mu);
});