// SPEC-003 §5.1.10 collection discovery (EGA-566).
//
// Depth applies ONLY to locating candidate skill-root directories, never to
// files inside an identified skill package (SPEC-002 owns package hashing).
// Rules: explicit path containing SKILL.md is ONE root (stop); otherwise
// recurse to DEFAULT_DISCOVERY_DEPTH, treating any directory containing
// SKILL.md as a root with no descent beneath it; skip exactly the frozen
// discovery exclusions; never follow symlink/junction directories; explicit
// symlinked roots are resolved by SPEC-002 traversal AFTER selection.
// Returned roots are absolute paths in deterministic lexical order.

import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEFAULT_DISCOVERY_DEPTH = 5;

export const DISCOVERY_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "__pycache__",
]);

const SKILL_MD = "SKILL.md";

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function containsSkillMd(directory: string): Promise<boolean> {
  return isRegularFile(join(directory, SKILL_MD));
}

/**
 * Locate candidate skill roots under startPath. Throws a plain Error for
 * caller errors (missing path, non-directory); an existing but empty
 * directory deterministically yields [].
 */
export async function discoverSkillRoots(
  startPath: string,
  maxDepth: number = DEFAULT_DISCOVERY_DEPTH,
): Promise<string[]> {
  const start = resolve(startPath);
  let startStat;
  try {
    startStat = await stat(start);
  } catch {
    throw new Error(`Import path does not exist: ${start}`);
  }
  if (!startStat.isDirectory()) {
    throw new Error(`Import path is not a directory: ${start}`);
  }

  // Explicit skill root: ONE root, no nested discovery beneath it.
  if (await containsSkillMd(start)) return [start];

  const roots: string[] = [];
  const ancestorReals = new Set<string>();

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // Never follow symlink/junction directories during traversal.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (DISCOVERY_EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
      const full = join(directory, entry.name);
      let linkStat;
      try {
        linkStat = await lstat(full);
      } catch {
        continue;
      }
      if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) continue;
      // readlink succeeds for symlinks AND junctions (both are reparse
      // points); normal directories fail. Never follow either kind.
      try {
        await readlink(full);
        continue;
      } catch {
        // Not a link: proceed with root/descent checks below.
      }
      if (await containsSkillMd(full)) {
        roots.push(full);
        continue;
      }
      // Cycle guard: never revisit an ancestor realpath (junction backlinks).
      let real: string;
      try {
        real = await realpath(full);
      } catch {
        continue;
      }
      if (ancestorReals.has(real)) continue;
      ancestorReals.add(real);
      try {
        await visit(full, depth + 1);
      } finally {
        ancestorReals.delete(real);
      }
    }
  }

  await visit(start, 0);
  return roots.sort();
}
