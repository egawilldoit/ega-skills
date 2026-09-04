// SPEC-005 §5.1.1–§5.1.4 exact project discovery (EGA-582).
//
// Two functions, independently testable:
//
// - resolveEffectiveProjectPath(input?): the effective `projectPath` is the
//   realpath of the supplied path (symlinks/junctions resolved); a symlinked
//   cwd and its real path MUST resolve identically (§5.1.1 rule 1, TEST-001
//   G042). If the supplied path is a file, its parent directory is used
//   (§5.1.1 rule 2). An omitted path means realpath(process.cwd()) (§5.1.1
//   rule 3). A path that does not exist throws a plain Error (mapping to the
//   frozen E_PROJECT_NOT_FOUND code belongs to the resolver integration layer,
//   not here).
//
// - discoverConfig(startDir): walks upward from the effective project
//   directory. The NEAREST `.egaskills.yaml` wins (§5.1.2 rule 1); when no
//   config is found the walk stops at a `.git` file OR directory (normal
//   repos, worktrees, submodules) or at the filesystem root (§5.1.2 rule 2),
//   so a nested repo NEVER leaks an outer config (§5.1.2 rule 3). Workspace
//   markers (`pnpm-workspace.yaml`, `package.json#workspaces`, `lerna.json`,
//   `nx.json`, Cargo `[workspace]`) are NEVER consulted — config discovery is
//   independent from fingerprint workspace discovery (SPEC-004 §5.1.9) and
//   they cannot stop the walk (§5.1.2 rule 4). The lock in force is the
//   `.egaskills.lock` ADJACENT to the selected config ONLY; a stray
//   `.egaskills.lock` without a selected config is IGNORED (§5.1.2 rule 5).
//
// Result shape (deterministic for a given filesystem state):
//
//   { projectPath: string;        // real effective project directory the walk started from
//     configPath: string | null;  // absolute path of the nearest .egaskills.yaml, else null
//     lockPath:   string | null;  // absolute path of the .egaskills.lock adjacent to the
//                                 //   selected config only, else null
//   }
//
// Discovery is presence-based by design: it reports what is adjacent without
// judging kind (file/dir/symlink). Config/lock symlink, non-text, parse, and
// schema rejection belongs to the validation layer (§5.1.14) so failures map
// to the frozen E_PROJECT_CONFIG_INVALID / E_PROJECT_LOCK_INVALID codes.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const CONFIG_FILE_NAME = ".egaskills.yaml";
const LOCK_FILE_NAME = ".egaskills.lock";
const GIT_MARKER_NAME = ".git";

export interface ProjectDiscovery {
  /** Real (symlink-resolved) effective project directory the walk started from. */
  readonly projectPath: string;
  /** Absolute path of the selected nearest `.egaskills.yaml`, or null when none is selected. */
  readonly configPath: string | null;
  /**
   * Absolute path of the `.egaskills.lock` ADJACENT to the selected config,
   * or null when no config is selected or no adjacent lock exists. A stray
   * lock without a selected config is never reported (SPEC-005 §5.1.2 rule 5).
   */
  readonly lockPath: string | null;
}

type LstatKind = "file" | "directory" | "other" | "missing";

/** lstat classification; symlinks and exotic types are "other". Never throws. */
function lstatKind(path: string): LstatKind {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Effective project path per SPEC-005 §5.1.1: realpath of the supplied path
 * (or `process.cwd()` when omitted); file inputs resolve to their parent
 * directory. Throws when the path does not exist.
 */
export function resolveEffectiveProjectPath(input?: string): string {
  const supplied = input ?? process.cwd();
  let real: string;
  try {
    real = realpathSync(resolve(supplied));
  } catch {
    throw new Error(`Project path does not exist: ${supplied}`);
  }
  return lstatKind(real) === "directory" ? real : dirname(real);
}

/**
 * Nearest `.egaskills.yaml` discovery per SPEC-005 §5.1.2, starting from the
 * effective project directory (the input is normalized through
 * `resolveEffectiveProjectPath`, so symlinked directories and file inputs are
 * handled identically here).
 */
export function discoverConfig(startDir: string): ProjectDiscovery {
  const projectPath = resolveEffectiveProjectPath(startDir);
  let current = projectPath;
  for (;;) {
    const configPath = join(current, CONFIG_FILE_NAME);
    if (lstatKind(configPath) !== "missing") {
      const lockPath = join(current, LOCK_FILE_NAME);
      return {
        projectPath,
        configPath,
        lockPath: lstatKind(lockPath) !== "missing" ? lockPath : null,
      };
    }
    // No config here: the `.git` marker (file for worktrees/submodules,
    // directory for normal repos) is the repository boundary — never walk
    // past it into an outer repo. Symlinked `.git` markers are NOT a
    // boundary (lstat kind "other"), matching the literal §5.1.2 rule 2.
    const gitKind = lstatKind(join(current, GIT_MARKER_NAME));
    if (gitKind === "file" || gitKind === "directory") break;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return { projectPath, configPath: null, lockPath: null };
}