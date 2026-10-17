// Exact source acquisition for intake. This module owns only bounded scratch
// acquisition; it never writes adopted Hub state or a registry.

import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { HubError } from "../hub/errors.js";
import { COMMIT_RE, assertRelativePosix, assertSortedUnique } from "../hub/guards.js";
import { fetchExactCommit, resolveRefToCommit } from "../hub/git.js";
import {
  discoverSelectedSkillsFromGit,
  discoverUnselectedSkills,
  discoverUnselectedSkillsFromGit,
  extractSelectedRoots,
  extractSelectedRootsFromGit,
  type ExtractedTree,
} from "../hub/quarantine.js";
import { discoverSkillDirs } from "../hub/builder.js";

export type IntakeSourceType = "git" | "local";

export interface AcquireSourceOptions {
  readonly source: string;
  readonly sourceType?: IntakeSourceType;
  readonly commit?: string;
  readonly ref?: string;
  readonly roots: readonly string[];
  readonly provenanceFiles?: readonly string[];
  readonly workDir?: string;
}

export interface AcquiredSource {
  readonly sourceType: IntakeSourceType;
  readonly source: string;
  readonly requestedRef?: string;
  readonly resolvedCommit?: string;
  readonly roots: readonly string[];
  readonly provenanceFiles: readonly string[];
  readonly selectedSkills: readonly string[];
  readonly unselectedSkills: readonly string[];
  readonly snapshotDir: string;
  readonly tree: ExtractedTree;
  readonly workspace: string;
}

function sourceTypeFor(options: AcquireSourceOptions): IntakeSourceType {
  if (options.sourceType !== undefined) return options.sourceType;
  if (existsSync(options.source)) return "local";
  return "git";
}

function rejectAmbiguousGitHubUrl(source: string): void {
  try {
    const url = new URL(source);
    if (url.hostname === "github.com" && /\/(tree|blob)\//.test(url.pathname)) {
      throw new HubError("E_SOURCE_SCHEMA", "GitHub tree/blob URLs are ambiguous; supply the repository URL, --ref, and --root separately");
    }
  } catch (error) {
    if (error instanceof HubError) throw error;
  }
}

function normalizePaths(paths: readonly string[], what: string, required: boolean): string[] {
  const normalized = [...new Set(paths.map((path) => path.replaceAll("\\", "/")))];
  if (required && normalized.length === 0) {
    throw new HubError("E_SOURCE_SELECTION", `${what} must contain at least one path`);
  }
  for (const path of normalized) assertRelativePosix(path, what);
  normalized.sort();
  try {
    assertSortedUnique(normalized, what);
  } catch (error) {
    throw new HubError("E_SOURCE_SELECTION", (error as Error).message);
  }
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1] as string;
    const current = normalized[index] as string;
    if (current.startsWith(`${previous}/`)) {
      throw new HubError("E_SOURCE_SELECTION", `${what} may not contain overlapping parent and child roots: ${previous}, ${current}`);
    }
  }
  return normalized;
}

function validateLocalSource(source: string): string {
  const absolute = resolve(source);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new HubError("E_SOURCE_SCHEMA", `local intake source does not exist: ${absolute}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HubError("E_SOURCE_SCHEMA", `local intake source must be a real directory: ${absolute}`);
  }
  return absolute;
}

function validateGitSource(source: string): void {
  rejectAmbiguousGitHubUrl(source);
  if (source.length === 0) throw new HubError("E_SOURCE_SCHEMA", "Git repository must not be empty");
}

/** Acquire one immutable source snapshot into a caller-owned scratch workspace. */
export function acquireSource(options: AcquireSourceOptions): AcquiredSource {
  const sourceType = sourceTypeFor(options);
  const roots = normalizePaths(options.roots, "selected roots", true);
  const provenanceFiles = normalizePaths(options.provenanceFiles ?? [], "provenance files", false);
  const workspace = mkdtempSync(join(options.workDir ?? tmpdir(), "ega-intake-"));
  const snapshotDir = join(workspace, "snapshot");
  try {
    if (sourceType === "local") {
      const localSource = validateLocalSource(options.source);
      const tree = extractSelectedRoots(localSource, roots, provenanceFiles, snapshotDir);
      return {
        provenanceFiles,
        roots,
        selectedSkills: discoverSkillDirs(snapshotDir, roots),
        snapshotDir,
        source: localSource,
        sourceType,
        tree,
        unselectedSkills: discoverUnselectedSkills(localSource, roots),
        workspace,
      };
    }

    validateGitSource(options.source);
    const requestedRef = options.ref ?? options.commit;
    if (requestedRef === undefined || requestedRef.length === 0) {
      throw new HubError("E_PLAN_RESOLVE", "Git intake requires --commit <sha> or --ref <ref>");
    }
    const resolvedCommit = options.commit ?? resolveRefToCommit(options.source, requestedRef);
    if (!COMMIT_RE.test(resolvedCommit)) {
      throw new HubError("E_PLAN_COMMIT", "approved Git commit must be 40 lowercase hex");
    }
    const fetchedDir = join(workspace, "git");
    const fallbackRef = options.ref === undefined || options.ref === options.commit ? undefined : options.ref;
    fetchExactCommit(options.source, resolvedCommit, fetchedDir, fallbackRef === undefined ? {} : { fallbackRef });
    const selectedSkills = discoverSelectedSkillsFromGit(fetchedDir, resolvedCommit, roots);
    const unselectedSkills = discoverUnselectedSkillsFromGit(fetchedDir, resolvedCommit, roots);
    const tree = extractSelectedRootsFromGit(fetchedDir, resolvedCommit, roots, provenanceFiles, snapshotDir);
    return {
      provenanceFiles,
      requestedRef,
      resolvedCommit,
      roots,
      selectedSkills,
      snapshotDir,
      source: options.source,
      sourceType,
      tree,
      unselectedSkills,
      workspace,
    };
  } catch (error) {
    rmSync(workspace, { force: true, recursive: true });
    throw error;
  }
}

export function releaseAcquiredSource(source: AcquiredSource): void {
  rmSync(source.workspace, { force: true, recursive: true });
}
