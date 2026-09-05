#!/usr/bin/env node
/**
 * EGA Skills Hub V1 — corpus staging verifier (EGA-598).
 *
 * Verifies a local 70-skill staging directory against the immutable
 * docs/V1-CORPUS.manifest.json: every manifest skill resolves to
 * <staging>/<name>/SKILL.md with the exact recorded SHA-256. Rebuild the
 * staging from the pinned upstream SHAs (see docs/V1-CORPUS.md), then run:
 *
 *   node scripts/corpus/verify-manifest.mjs <staging-root>
 *
 * Exit 0 = staging matches the frozen manifest exactly.
 * Exit 1 = missing skills, hash mismatches, or unexpected extras.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const manifestPath = new URL("../../docs/V1-CORPUS.manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const staging = process.argv[2];
if (!staging || !existsSync(staging) || !readdirSync(staging, { withFileTypes: true }).some((e) => e.isDirectory())) {
  console.error("usage: node scripts/corpus/verify-manifest.mjs <staging-root>");
  process.exit(1);
}

let failures = 0;
const seen = new Set();
for (const skill of manifest.skills) {
  seen.add(skill.name);
  const file = join(staging, skill.name, "SKILL.md");
  if (!existsSync(file)) {
    console.error(`missing: ${skill.name} (${skill.upstream}:${skill.upstream_path})`);
    failures += 1;
    continue;
  }
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== skill.skill_md_sha256) {
    console.error(`mismatch: ${skill.name}\n  manifest: ${skill.skill_md_sha256}\n  staging:  ${actual}`);
    failures += 1;
  }
}
for (const entry of readdirSync(staging, { withFileTypes: true })) {
  if (entry.isDirectory() && !seen.has(entry.name)) {
    console.error(`extra: ${entry.name} (not in manifest)`);
    failures += 1;
  }
}

if (failures === 0) {
  console.log(`CORPUS-OK: ${manifest.skills.length}/${manifest.skills.length} skills match the frozen manifest.`);
} else {
  console.error(`CORPUS-DRIFT: ${failures} problem(s).`);
  process.exit(1);
}
