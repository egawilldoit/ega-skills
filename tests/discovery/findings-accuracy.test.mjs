import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { openRegistry } from "../../packages/registry/dist/index.js";

const ENV = { ...process.env, EGA_SKILLS_HOME: join(process.cwd(), "packages/mcp/artifact") };
const FINDINGS = join(process.cwd(), "docs/DISCOVERY-FINDINGS.md");

/** Every declared trigger for every skill, straight from the verified registry. */
function triggersBySkill() {
  const handle = openRegistry({ env: ENV, readonly: true });
  try {
    return new Map(
      handle.db
        .prepare(
          `SELECT s.skill_id AS id, v.manifest_json AS manifest
             FROM skills s
             JOIN skill_versions v
               ON v.skill_id = s.skill_id
              AND v.version_hash = s.current_version_hash`,
        )
        .all()
        .map((row) => [row.id, JSON.parse(row.manifest).routing?.triggers ?? []]),
    );
  } finally {
    handle.close();
  }
}

/**
 * A skill is "name-only" when EVERY declared trigger is a contiguous slice of
 * its own name. Such a skill cannot be discovered by natural language, because
 * no user types the skill's own name back at the router.
 */
function isNameOnly(id, triggers) {
  if (triggers.length === 0) return false;
  const words = id.split("/")[1].replace(/-/gu, " ");
  return triggers.every((trigger) => words.includes(trigger.toLowerCase()));
}

test("docs/DISCOVERY-FINDINGS.md quotes triggers exactly as the registry declares them", async () => {
  // The findings document is a cross-repo handoff. If it misquotes a skill's
  // declared triggers, whoever applies the fix in egawilldoit/skills works from
  // wrong data — and nothing else in the repo would catch it.
  const findings = await readFile(FINDINGS, "utf8");
  const start = findings.indexOf("| Skill | Declared triggers |");
  const end = findings.indexOf("Intents whose expected skill does not appear");
  assert.ok(start > 0 && end > start, "could not locate the declared-triggers table");

  const triggers = triggersBySkill();
  const rows = [
    ...findings
      .slice(start, end)
      .matchAll(/^\| `(principle-[a-z-]+)` \| (.+?) \|$/gmu),
  ];
  assert.ok(rows.length > 0, "declared-triggers table is empty");

  for (const [, name, cell] of rows) {
    const id = `egawilldoit/${name}`;
    const declared = triggers.get(id);
    assert.ok(declared !== undefined, `${id} is quoted in the findings but absent from the release`);
    // Strip Markdown backticks and any "(N)" count annotation, then compare as sets.
    const quoted = cell
      .replace(/`/gu, "")
      .replace(/\s*\(\d+\)$/u, "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .sort();
    assert.deepEqual(quoted, [...declared].sort(), `${id}: findings doc disagrees with the registry`);
  }
});

test("the name-only count quoted in the findings is still exact", async () => {
  const findings = await readFile(FINDINGS, "utf8");
  const triggers = triggersBySkill();
  const egawilldoit = [...triggers.keys()].filter((id) => id.startsWith("egawilldoit/"));
  const nameOnly = egawilldoit.filter((id) => isNameOnly(id, triggers.get(id) ?? []));

  const quoted = findings.match(/(\d+) of the (\d+) `egawilldoit` skills have a trigger set/u);
  assert.ok(quoted !== null, "findings doc no longer states the name-only count");
  const [, nameOnlyCount, totalCount] = quoted;
  assert.equal(Number(totalCount), egawilldoit.length, "total egawilldoit count drifted");
  assert.equal(
    Number(nameOnlyCount),
    nameOnly.length,
    `name-only count drifted; now ${nameOnly.length}: ${nameOnly.map((id) => id.split("/")[1]).join(", ")}`,
  );
});