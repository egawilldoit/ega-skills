// EGA-827: discovery -> exact pinned content handoff.
//
// Proves the guidance added to the four tool descriptions is true behavior:
// `search` and `resolve` return L0 metadata plus an exact `version_hash`
// without returning or executing instruction bodies, `inspect` re-reads that
// exact version without L1/L2 bodies, and `get_content` returns the exact
// pinned body with no version fallback or silent truncation.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  McpContextError,
  resolveMcpProjectContext,
} from "../../packages/mcp/dist/project-context.js";
import { runSearchTool } from "../../packages/mcp/dist/search.js";
import { runResolveTool } from "../../packages/mcp/dist/resolve.js";
import {
  runInspectTool,
  toInspectSuccessResult,
} from "../../packages/mcp/dist/inspect.js";
import { runGetContentTool } from "../../packages/mcp/dist/get-content.js";
import {
  getCurrentVersionHash,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";

const SKILL_ID = "ega/discovery-probe";
const BODY_MARKER = "DISCOVERY-BODY-827";
const SKILL_BODY =
  "---\nname: discovery-probe\ndescription: probe skill for the discovery handoff\n---\n\n" +
  `# discovery-probe\n\n${BODY_MARKER} appears only in the L2 body.\n`;
const SKILL_CORE =
  "# discovery-probe core\n\nCondensed core guidance for the discovery probe.\n";
const EGA_YAML =
  "schema_version: 1\n" +
  "domains: [engineering]\n" +
  "triggers: [probe discovery workflow]\n" +
  "anti_triggers: [unrelated chores]\n" +
  "aliases: [probe]\n";

const tempRoots = new Set();
async function makeTempRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `ega-mcp-discovery-${name}-`));
  tempRoots.add(root);
  return root;
}
test.after(async () => {
  for (const root of tempRoots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tempRoots.clear();
});

async function setupFixture() {
  const base = await makeTempRoot("fixture");
  const home = join(base, "home");
  const src = join(base, "src");
  const skillDir = join(src, "discovery-probe");
  const project = join(base, "project");
  await mkdir(skillDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), SKILL_BODY);
  await writeFile(join(skillDir, "SKILL.core.md"), SKILL_CORE);
  await writeFile(join(skillDir, "ega.yaml"), EGA_YAML);

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    const summary = await importSkills(registry, { path: src, namespace: "ega" });
    assert.equal(
      summary.failed,
      0,
      `fixture import must not fail: ${JSON.stringify(summary.failures)}`,
    );
    return {
      ctx: resolveMcpProjectContext(project, {
        env: { ...process.env, EGA_SKILLS_HOME: home },
      }),
      currentHash: getCurrentVersionHash(registry.db, SKILL_ID),
    };
  } finally {
    registry.close();
  }
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof McpContextError, `expected McpContextError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`expected ${code} but nothing threw`);
}

test("search and resolve expose L0 routing metadata without bodies or execution", async () => {
  const { ctx, currentHash } = await setupFixture();

  const search = runSearchTool({ query: "probe discovery" }, ctx);
  assert.equal(search.isError, false);
  const row = search.structuredContent.results.find((hit) => hit.skill_id === SKILL_ID);
  assert.ok(row, "search finds the imported probe skill");
  assert.equal(row.version_hash, currentHash, "search returns the exact current version");
  assert.deepEqual([...row.triggers], ["probe discovery workflow"]);
  assert.deepEqual([...row.anti_triggers], ["unrelated chores"]);
  assert.ok(!("content" in row), "search rows carry no content field");
  assert.ok(!JSON.stringify(search).includes(BODY_MARKER), "search never returns the L2 body");
  for (const part of search.content) {
    assert.ok(!part.text.includes(BODY_MARKER), "search text fallback carries no L2 body");
    assert.ok(part.text.includes(SKILL_ID), "search text fallback carries the skill id");
    assert.ok(part.text.includes(currentHash), "search text fallback carries the version hash");
  }

  const resolved = await runResolveTool(
    { task: "probe discovery workflow", explicit_skills: [SKILL_ID] },
    ctx,
  );
  assert.equal(resolved.isError, false);
  const routed = [
    ...resolved.structuredContent.explicit,
    ...resolved.structuredContent.selected,
  ].filter((skill) => skill.id === SKILL_ID);
  assert.ok(routed.length > 0, "resolve routes the explicitly requested skill");
  assert.equal(
    routed[0].version_hash,
    row.version_hash,
    "resolve hands off the same exact version as search",
  );
  assert.ok(!JSON.stringify(resolved).includes(BODY_MARKER), "resolve never returns the L2 body");
  for (const part of resolved.content) {
    assert.ok(!part.text.includes(BODY_MARKER), "resolve text fallback carries no L2 body");
  }
});

test("inspect re-reads the discovered version without L1/L2 bodies", async () => {
  const { ctx, currentHash } = await setupFixture();
  const search = runSearchTool({ query: "probe discovery" }, ctx);
  const row = search.structuredContent.results.find((hit) => hit.skill_id === SKILL_ID);
  assert.ok(row);

  const inspected = runInspectTool(
    { skill_id: SKILL_ID, version_hash: row.version_hash },
    ctx,
  );
  assert.equal(inspected.skill_id, SKILL_ID);
  assert.equal(inspected.version_hash, currentHash, "inspect pins the discovered version");
  assert.deepEqual([...inspected.l0.triggers], ["probe discovery workflow"]);
  assert.deepEqual([...inspected.l0.anti_triggers], ["unrelated chores"]);
  assert.ok(
    !JSON.stringify(inspected).includes(BODY_MARKER),
    "inspect never returns the L2 body",
  );

  const fallback = toInspectSuccessResult(inspected);
  assert.equal(fallback.structuredContent.version_hash, currentHash);
  for (const part of fallback.content) {
    assert.ok(!part.text.includes(BODY_MARKER), "inspect text fallback carries no L2 body");
  }
});

test("get_content returns the exact pinned body and never falls forward", async () => {
  const { ctx, currentHash } = await setupFixture();
  const search = runSearchTool({ query: "probe discovery" }, ctx);
  const row = search.structuredContent.results.find((hit) => hit.skill_id === SKILL_ID);
  assert.ok(row);
  const resolved = await runResolveTool(
    { task: "probe discovery workflow", explicit_skills: [SKILL_ID] },
    ctx,
  );
  const routed = [
    ...resolved.structuredContent.explicit,
    ...resolved.structuredContent.selected,
  ].find((skill) => skill.id === SKILL_ID);
  assert.ok(routed);

  const content = runGetContentTool(
    {
      skill_id: SKILL_ID,
      version_hash: routed.version_hash,
      level: "L2",
      max_tokens: 100_000,
    },
    ctx,
  );
  assert.equal(content.isError, false);
  const output = content.structuredContent;
  assert.equal(output.skill_id, SKILL_ID);
  assert.equal(output.version_hash, currentHash);
  assert.equal(output.level, "L2");
  assert.equal(output.content, SKILL_BODY, "L2 is the exact canonical body");
  assert.ok(output.token_count > 0);
  const text = content.content.map((part) => part.text).join("\n");
  assert.ok(text.includes(BODY_MARKER), "get_content text fallback carries the exact body");

  // A well-formed but absent version is an error, never a fall-forward.
  expectCode(
    () =>
      runGetContentTool(
        {
          skill_id: SKILL_ID,
          version_hash: `sha256:${"0".repeat(64)}`,
          level: "L2",
          max_tokens: 100_000,
        },
        ctx,
      ),
    "E_VERSION_NOT_FOUND",
  );

  // Over-budget is an error, never silently truncated content.
  expectCode(
    () =>
      runGetContentTool(
        {
          skill_id: SKILL_ID,
          version_hash: row.version_hash,
          level: "L2",
          max_tokens: 1,
        },
        ctx,
      ),
    "E_CONTENT_TOKEN_BUDGET",
  );
});
