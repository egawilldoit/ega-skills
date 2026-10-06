import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildCatalogModel,
  loadPresentation,
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

/**
 * Size of the committed release, asserted in several places on purpose: it is a
 * re-vendor tripwire. When the catalog is rebuilt, these must be updated
 * deliberately rather than drifting.
 */
const EXPECTED_CATALOG_SKILLS = 114;

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

test("catalog rendering is stable in-process for identical inputs", async () => {
  const a = renderCatalogMarkdown(
    buildCatalogModel(readL0Metadata(ENV), JSON.parse(JSON.stringify(loadPresentation(PRESENTATION)))),
    { digest: "sha256:test", hubId: "personal" },
  );
  const b = renderCatalogMarkdown(
    buildCatalogModel(readL0Metadata(ENV), JSON.parse(JSON.stringify(loadPresentation(PRESENTATION)))),
    { digest: "sha256:test", hubId: "personal" },
  );
  assert.equal(a, b);
  // Cross-process / cross-run determinism is proven by the committed
  // `pnpm catalog:check` staleness gate below, which re-renders and compares.
});

test("generation is byte-identical across separate processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ega-catalog-det-"));
  try {
    const outputs = [];
    for (const name of ["a.md", "b.md"]) {
      const out = join(dir, name);
      await execFileAsync(process.execPath, ["scripts/catalog/generate.mjs", "--out", out], { cwd: ROOT, env: ENV });
      outputs.push(await readFile(out, "utf8"));
    }
    assert.equal(outputs[0], outputs[1], "two separate generator processes must produce identical bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarize never emits a lone surrogate or exceeds its cap", () => {
  const emoji = `${"x".repeat(139)}😀 more text that goes on`;
  const clipped = summarize(emoji);
  assert.ok(clipped.length <= 140, `expected <=140 chars, got ${clipped.length}`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(clipped), "must not contain a lone high surrogate");
  assert.ok(!/[\uDC00-\uDFFF](?![\uD800-\uDBFF])/u.test(clipped), "must not contain a lone low surrogate");
});

test("summarize honours its cap for astral-heavy text", () => {
  // Every character here is a surrogate PAIR, so a naive code-unit clip would
  // emit 2 units per glyph and blow straight past the budget.
  const astral = summarize(`${"😀".repeat(120)} tail text that continues for a while`);
  assert.ok(astral.length <= 140, `astral summary exceeded cap: ${astral.length}`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(astral));
});

test("summarize clamps a nonsensical cap instead of slicing negatively", () => {
  // slice(0, -1) on a zero budget would return "" plus a stray ellipsis, and a
  // negative cap would slice from the end of the string.
  for (const cap of [0, -5]) {
    const out = summarize("hello there, this is a description", cap);
    assert.ok(out.length <= 1, `cap ${cap} produced ${JSON.stringify(out)}`);
  }
});

test("a skill in two groups keeps its compact bare name", () => {
  // Name disambiguation must count DISTINCT skills, not group placements.
  const model = buildCatalogModel(
    readL0Metadata(ENV),
    basePresentation({
      groups: [
        { id: "a", title: "A", skills: ["egawilldoit/principle-minimize-reader-load"] },
        { id: "b", title: "B", skills: ["egawilldoit/principle-minimize-reader-load"] },
      ],
    }),
  );
  const markdown = renderCatalogMarkdown(model, { digest: "sha256:test", hubId: "personal" });
  assert.ok(
    markdown.includes("\n### principle-minimize-reader-load\n"),
    "a twice-listed skill must not be namespace-qualified",
  );
  assert.ok(!markdown.includes("### egawilldoit/principle-minimize-reader-load"));
});

test("terminal output truncates over-long labels instead of breaking alignment", () => {
  const model = buildCatalogModel(
    readL0Metadata(ENV),
    basePresentation({
      groups: [
        {
          id: "long",
          title: "Long",
          skills: ["egawilldoit/principle-separate-before-serializing-shared-state", "egawilldoit/verify-ui"],
        },
      ],
    }),
  );
  const text = renderCatalogText(model, { digest: "sha256:test" });
  // The other 112 skills land in the ungrouped section; select only the two
  // rows belonging to the group under test.
  const rows = text
    .split("\n")
    .filter((line) => /principle-separate-before-serializing|verify-ui/.test(line) && line.startsWith("  "));
  assert.equal(rows.length, 2, `expected 2 skill rows, got ${rows.length}`);
  // The label cell is capped at 44 columns and padded to exactly that width, so
  // every summary must begin at the same offset (2 indent + 44 + 2 gap).
  for (const row of rows) {
    assert.equal(row.slice(2, 46).length, 44, `label cell is not 44 wide: ${JSON.stringify(row)}`);
    assert.equal(row.slice(46, 48), "  ", `summary does not start at column 48: ${JSON.stringify(row)}`);
  }
  assert.ok(rows.some((row) => row.includes("…")), "the over-long label was not truncated");
});

test("an explicit empty --search reports no matches instead of dumping the catalog", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["packages/cli/bin/ega-skills.mjs", "catalog", "--search", "", "--json"],
    { cwd: ROOT, env: ENV },
  );
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.query, "");
  assert.deepEqual(parsed.results, []);
  assert.ok(!("catalog" in parsed), "an explicit empty query must not fall through to the full catalog");
});

test("presentation metadata that is not valid UTF-8 is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ega-catalog-utf8-"));
  try {
    const path = join(dir, "presentation.yaml");
    // latin-1 byte 0xE9 is invalid as UTF-8 and would silently become U+FFFD.
    await writeFile(path, "catalog_version: 1\ngroups:\n  - id: g\n    title: caf\u00e9\n", "latin1");
    assert.throws(() => loadPresentation(path), /not valid UTF-8/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("text output disambiguates skills that share a bare name", () => {
  const model = buildCatalogModel(
    readL0Metadata(ENV),
    basePresentation({
      groups: [
        {
          id: "dup",
          title: "Dup",
          skills: ["egawilldoit/tdd", "mattpocock/tdd", "egawilldoit/verify-ui"],
        },
      ],
    }),
  );
  const text = renderCatalogText(model, { digest: "sha256:test" });
  // Both `tdd` skills must be distinguishable; the unique one stays compact.
  assert.match(text, /egawilldoit\/tdd/u);
  assert.match(text, /mattpocock\/tdd/u);
  assert.match(text, / {2}verify-ui {2}/u);
});

test("group ordering follows the authored presentation and skills are id-sorted", async () => {
  const presentation = loadPresentation(PRESENTATION);
  const model = buildCatalogModel(readL0Metadata(ENV), presentation);
  assert.deepEqual(
    model.groups.map((g) => g.id),
    presentation.groups.map((g) => g.id),
    "rendered group order must match the authored order",
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
  // A leading sentence long enough to stand alone is used as-is.
  assert.equal(
    summarize("Build a senior-engineer mental model of a subsystem before changing anything at all."),
    "Build a senior-engineer mental model of a subsystem before changing anything at all.",
  );
  // A too-short leading sentence pulls in the next one, so the catalog is useful.
  assert.equal(summarize("Stop. That last message did not land: re-pitch it."), "Stop. That last message did not land: re-pitch it.");
  // No sentence boundary: the whole (short) text is the summary.
  assert.equal(summarize("No trailing period here"), "No trailing period here");
  assert.equal(summarize(""), "");
  // Whitespace is collapsed identically everywhere.
  assert.equal(summarize("a\n\n  b   c"), "a b c");
  const long = summarize(`${"word ".repeat(60)}end.`);
  assert.ok(long.length <= 140, `expected a clipped summary <=140, got ${long.length} chars`);
});

test("every real release skill gets a non-trivial summary", async () => {
  const l0 = readL0Metadata(ENV);
  for (const [id, skill] of l0) {
    assert.ok(skill.summary.length >= 45, `${id} has a too-short summary: ${JSON.stringify(skill.summary)}`);
    assert.ok(skill.summary.length <= 140, `${id} has an over-long summary (${skill.summary.length})`);
    assert.ok(!skill.summary.includes("\n"), `${id} summary must be one line`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(skill.summary), `${id} summary has a lone surrogate`);
  }
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

test("presentation metadata may not carry routing authority at any depth or spelling", () => {
  // Top level, exact spelling.
  for (const key of ["triggers", "anti_triggers", "domains", "platforms", "frameworks", "aliases"]) {
    assert.throws(
      () => validatePresentation(basePresentation({ [key]: ["x"] }), knownIds()),
      CatalogError,
      `expected top-level routing key ${key} to be rejected`,
    );
  }
  // Nested inside a group — a top-level-only check would let these through.
  for (const key of ["triggers", "anti_triggers", "domains", "platforms", "frameworks", "aliases"]) {
    assert.throws(
      () =>
        validatePresentation(
          basePresentation({
            groups: [{ id: "g", title: "G", skills: ["egawilldoit/verify-ui"], [key]: ["x"] }],
          }),
          knownIds(),
        ),
      CatalogError,
      `expected nested routing key ${key} to be rejected`,
    );
  }
  // Near-miss spellings and realistic synonyms normalize onto a forbidden key.
  for (const key of ["antiTriggers", "anti-triggers", "ANTITRIGGERS", "trigger_phrases", "keywords"]) {
    assert.throws(
      () => validatePresentation(basePresentation({ [key]: ["x"] }), knownIds()),
      CatalogError,
      `expected near-miss routing key ${key} to be rejected`,
    );
  }
  // Nested deeper still.
  assert.throws(
    () =>
      validatePresentation(
        basePresentation({ extra: { nested: { domains: ["x"] } } }),
        knownIds(),
      ),
    CatalogError,
    "expected deeply nested routing key to be rejected",
  );
});

test("group titles and blurbs cannot inject Markdown structure", () => {
  const model = buildCatalogModel(
    readL0Metadata(ENV),
    basePresentation({
      groups: [{ id: "g", title: "Verify\n## Injected", blurb: "line one\nline two", skills: ["egawilldoit/verify-ui"] }],
    }),
  );
  assert.equal(model.groups[0].title, "Verify ## Injected");
  assert.equal(model.groups[0].blurb, "line one line two");
  const markdown = renderCatalogMarkdown(model, { digest: "sha256:test", hubId: "personal" });
  // Assert the RENDERED structure, not the absence of the raw input: the title
  // must appear as one heading line, and "Injected" must not become its own
  // heading on a line of its own.
  assert.ok(markdown.includes("\n## Verify ## Injected\n"), "title was not rendered as a single heading line");
  assert.ok(!/^## Injected/mu.test(markdown), "injected heading escaped into the document");
  assert.ok(!/^line two/mu.test(markdown), "injected blurb line escaped into the document");
});

// --- presentation cannot influence routing -------------------------------

test("the router and registry never read catalog presentation metadata", async () => {
  // The causal guarantee behind "presentation is not routing authority" is
  // structural: the resolver and registry must not even be able to SEE the
  // presentation file. Assert that at the source level, because a behavioural
  // comparison of two identical resolver calls cannot fail.
  const { readdir, readFile } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  for (const pkg of ["router", "registry"]) {
    const dir = joinPath(ROOT, "packages", pkg, "src");
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const text = await readFile(joinPath(dir, entry), "utf8");
      assert.ok(
        !/presentation|catalog\/presentation/i.test(text),
        `packages/${pkg}/src/${entry} references catalog presentation metadata; routing must not depend on it`,
      );
    }
  }
});

test("presentation metadata cannot change routing behaviour", async () => {
  const { resolveSkills } = await import("../../packages/router/dist/index.js");
  const project = await mkdtemp(join(tmpdir(), "ega-catalog-routing-"));
  const dir = await mkdtemp(join(tmpdir(), "ega-catalog-routing-"));
  try {
    const task = "The agent report, GitHub, CI, and deployment disagree about what shipped.";
    // Point the resolver at a presentation the loader would REJECT for carrying
    // routing authority, so the only way it could ever matter is if the router
    // read it. It must be invisible.
    const hostile = joinPath2(dir, "presentation.yaml");
    await writeFile(
      hostile,
      JSON.stringify(basePresentation({ triggers: ["reconcile"] })),
    );
    const before = await resolveSkills({ task, projectPath: project, env: ENV });
    const after = await resolveSkills({
      task,
      projectPath: project,
      env: { ...ENV, EGA_CATALOG_PRESENTATION: hostile },
    });
    assert.deepEqual(after.selected.map((s) => s.id), before.selected.map((s) => s.id));
    assert.equal(after.confidence, before.confidence);

    // And regrouping the catalog visibly changes the catalog, but not routing.
    const presentation = loadPresentation(PRESENTATION);
    presentation.groups.push({ id: "zzz", title: "Z", skills: ["egawilldoit/verify-this"] });
    const model = buildCatalogModel(readL0Metadata(ENV), presentation);
    assert.ok(model.groups.some((g) => g.id === "zzz"), "presentation mutation was not applied");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

function joinPath2(...parts) {
  return parts.join("/");
}

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
  assert.match(first.stdout, new RegExp(`${EXPECTED_CATALOG_SKILLS} skills`, "u"));
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
  assert.equal(parsed.catalog.skillCount, EXPECTED_CATALOG_SKILLS);
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
  assert.equal(lines.length, EXPECTED_CATALOG_SKILLS);
  assert.match(lines[0], /^anthropic\/academy-guide sha256:[0-9a-f]{64}$/u);
});

test("renderCatalogText and runCatalog produce identical output for the same presentation", async () => {
  // Both paths must render from the SAME inputs, otherwise this compares nothing.
  const dir = await mkdtemp(join(tmpdir(), "ega-catalog-same-"));
  try {
    const path = join(dir, "presentation.yaml");
    await writeFile(path, JSON.stringify(basePresentation()));
    const fromRun = runCatalog({ env: ENV, presentationPath: path });
    const model = buildCatalogModel(readL0Metadata(ENV), JSON.parse(await readFile(path, "utf8")));
    const release = JSON.parse(await readFile(join(ARTIFACT, "hub-release.json"), "utf8"));
    assert.equal(fromRun, renderCatalogText(model, { digest: release.digest }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});