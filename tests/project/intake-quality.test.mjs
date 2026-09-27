import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createQualityReport } from "../../packages/project/dist/index.js";
import { importSkills, openRegistry } from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

async function skill(source, name, options = {}) {
  const root = join(source, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    options.body ?? `---\nname: ${name}\ndescription: ${name} guidance\n---\n# Shared guidance\n\nUse the shared workflow.\n`,
  );
  await writeFile(join(root, "ega.yaml"), options.ega ?? "schema_version: 1\ndomains: [engineering]\n");
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

async function sourceWorld(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-quality-"));
  const source = join(base, "source");
  await mkdir(source, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, source };
}

function diagnostics(report, code) {
  return report.payload.candidates.flatMap((candidate) => candidate.diagnostics.filter((item) => item.code === code));
}

const FEATURE_MAP_GUIDE = readFileSync(
  fileURLToPath(new URL("./fixtures/feature-map-guide.md", import.meta.url)),
  "utf8",
);

test("QL-01: generic platform is diagnosed with the safe empty-list replacement", async (t) => {
  const world = await sourceWorld(t);
  await skill(world.source, "generic-platform", {
    ega: "schema_version: 1\nplatforms: [generic]\ntriggers: [build widget]\n",
  });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_PLATFORM_GENERIC");
  assert.equal(found.length, 1);
  assert.equal(found[0].details.replacement, "empty");
  assert.match(found[0].suggested_action, /empty platform list/iu);
  assert.equal(report.payload.summary.blocked_count, 0);

  const env = { ...process.env, EGA_SKILLS_HOME: join(world.base, "home") };
  const registry = openRegistry({ env });
  try {
    await importSkills(registry, { path: world.source, namespace: "ega" });
  } finally {
    registry.close();
  }
  const project = join(world.base, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { next: "^15.0.0" } }));
  const resolved = await resolveSkills({ task: "build widget", projectPath: project, env });
  assert.equal(resolved.selected.length, 0);
  assert.equal(resolved.rejected.find((item) => item.id === "ega/generic-platform")?.reasons[0], "PLATFORM_MISMATCH");
});

test("QL-03: duplicate main bodies stay distinct when companion files differ", async (t) => {
  const world = await sourceWorld(t);
  const body = "---\nname: shared\ndescription: shared guidance\n---\n# Shared guidance\n\nUse the shared workflow.\n";
  await skill(world.source, "one/shared", { body, files: { "references/one.md": "one\n" } });
  await skill(world.source, "two/shared", { body, files: { "references/two.md": "two\n" } });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const candidates = report.payload.candidates;
  assert.equal(candidates.length, 2);
  assert.equal(new Set(candidates.map((candidate) => candidate.version_hash)).size, 2);
  assert.equal(diagnostics(report, "Q_DUPLICATE_CANONICAL_BODY").length, 2);
  assert.equal(report.payload.summary.warning_count >= 2, true);
  assert.equal(JSON.stringify(report).includes("one\n"), false);
});

test("Q1 CLI writes a stable report outside the source tree", async (t) => {
  const world = await sourceWorld(t);
  await skill(world.source, "cli-quality");
  const output = join(world.base, "report.json");
  const { spawn } = await import("node:child_process");
  const result = await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [
      "packages/cli/bin/ega-skills.mjs",
      "intake",
      "quality",
      world.source,
      "--namespace",
      "ega",
      "--output",
      output,
    ], { cwd: new URL("../..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(summary.digest, report.digest);
  assert.equal(report.object_type, "ega.intake-quality-report");
});

test("Q1-116: fenced example links are not companion references", async (t) => {
  const world = await sourceWorld(t);
  await skill(world.source, "create-verification-workflow", {
    files: { "references/feature-map-guide.md": FEATURE_MAP_GUIDE },
  });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE");
  assert.equal(found.length, 0, JSON.stringify(found, null, 2));
});

test("Q1-116: real broken link outside a fence is still flagged", async (t) => {
  const world = await sourceWorld(t);
  await skill(world.source, "real-broken", {
    body: "---\nname: real-broken\ndescription: real broken link\n---\n# Real broken\n\nSee [missing](./missing-companion.md) for details.\n",
  });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE");
  assert.equal(found.length, 1);
  assert.equal(found[0].relative_file, "SKILL.md");
  assert.equal(found[0].details.target, "./missing-companion.md");
});

test("Q1-116: fence variants keep example links inert and prose links live", async (t) => {
  const world = await sourceWorld(t);
  const body = [
    "---",
    "name: fence-variants",
    "description: fence variants",
    "---",
    "# Fence variants",
    "",
    "Before [before-missing](./before-missing.md) the fence.",
    "",
    "```text",
    "first [first-missing](./first-missing.md) example",
    "```",
    "",
    "~~~markdown",
    "tilde [tilde-missing](./tilde-missing.md) example",
    "~~~",
    "",
    "After [after-missing](./after-missing.md) the fences.",
    "",
    "````text",
    "long [long-missing](./long-missing.md) fence",
    "```",
    "not a close",
    "````",
    "",
    "Tail [tail-missing](./tail-missing.md) link.",
    "",
  ].join("\n");
  await skill(world.source, "fence-variants", { body });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE");
  const targets = found.map((item) => item.details.target).sort();
  assert.deepEqual(targets, ["./after-missing.md", "./before-missing.md", "./tail-missing.md"]);
});

test("Q1-116: multiple fences each shield their example links", async (t) => {
  const world = await sourceWorld(t);
  const body = [
    "---",
    "name: multi-fence",
    "description: multiple fences",
    "---",
    "# Multiple fences",
    "",
    "```text",
    "first [first-missing](./first-missing.md) example",
    "```",
    "",
    "Prose between fences is checked: [between-missing](./between-missing.md).",
    "",
    "~~~",
    "second [second-missing](./second-missing.md) example",
    "~~~",
    "",
  ].join("\n");
  await skill(world.source, "multi-fence", { body });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE");
  assert.deepEqual(found.map((item) => item.details.target), ["./between-missing.md"]);
});

test("Q1-116: unclosed fence fails safe and shields the rest of the document", async (t) => {
  const world = await sourceWorld(t);
  const body = [
    "---",
    "name: unclosed-fence",
    "description: unclosed fence",
    "---",
    "# Unclosed fence",
    "",
    "```text",
    "example [example-missing](./example-missing.md) link",
    "",
    "Trailing prose with [trailing-missing](./trailing-missing.md) link.",
    "",
  ].join("\n");
  await skill(world.source, "unclosed-fence", { body });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  assert.equal(diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE").length, 0);
});

test("Q1-116: stray closing fence fails safe", async (t) => {
  const world = await sourceWorld(t);
  const body = [
    "---",
    "name: stray-fence",
    "description: stray closing fence",
    "---",
    "# Stray fence",
    "",
    "Prose before the stray fence: [before-missing](./before-missing.md).",
    "",
    "```",
    "stray closing fence shields the rest",
    "",
    "Prose after: [after-missing](./after-missing.md).",
    "",
  ].join("\n");
  await skill(world.source, "stray-fence", { body });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE");
  assert.deepEqual(found.map((item) => item.details.target), ["./before-missing.md"]);
});

test("Q1-116: inline-code spans are still validated (known limitation, deferred)", async (t) => {
  const world = await sourceWorld(t);
  const body = [
    "---",
    "name: inline-code",
    "description: inline code behavior",
    "---",
    "# Inline code",
    "",
    "Run `verify [inline-missing](./inline-missing.md)` to check.",
    "",
  ].join("\n");
  await skill(world.source, "inline-code", { body });
  const report = await createQualityReport({ sourcePath: world.source, namespace: "ega" });
  const found = diagnostics(report, "Q_BROKEN_COMPANION_REFERENCE");
  assert.deepEqual(found.map((item) => item.details.target), ["./inline-missing.md"]);
});
