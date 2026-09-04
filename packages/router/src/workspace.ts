// SPEC-004 §5.1.9 nearest-package monorepo isolation (EGA-572).
//
// Exactly ONE directory supplies app evidence: the nearest ancestor-or-self
// of the real project path containing a recognized manifest. The workspace
// root contributes WORKSPACE/tooling evidence only — sibling package
// identities are NEVER scanned or merged. Starting at a workspace root with
// no framework evidence of its own sets workspaceAmbiguous=true (no confident
// app fingerprint from merged siblings). All paths resolve through realpath
// so symlinked project inputs are deterministic.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import {
  deriveFingerprintSets,
  detectDirectoryEvidence,
  type FingerprintEvidence,
  type ProjectFingerprint,
} from "./fingerprint.js";

const RECOGNIZED_MANIFESTS = [
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
] as const;

function isRequirementsFile(name: string): boolean {
  return name === "requirements.txt" || (name.startsWith("requirements-") && name.endsWith(".txt"));
}

function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasRecognizedManifest(entries: readonly string[]): boolean {
  if (RECOGNIZED_MANIFESTS.some((name) => entries.includes(name))) return true;
  return entries.some(isRequirementsFile);
}

function hasWorkspaceMarker(dir: string, entries: readonly string[]): boolean {
  if (
    entries.includes("pnpm-workspace.yaml") ||
    entries.includes("lerna.json") ||
    entries.includes("nx.json")
  ) {
    return true;
  }
  if (entries.includes("package.json")) {
    try {
      const parsed: unknown = JSON.parse(readFileText(`${dir}/package.json`) ?? "");
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)["workspaces"] !== undefined
      ) {
        return true;
      }
    } catch {
      // Malformed manifests are neutral absence, never markers.
    }
  }
  const cargo = readFileText(`${dir}/Cargo.toml`);
  if (cargo !== null && /^\s*\[workspace\]/m.test(cargo)) return true;
  return false;
}

/** Ancestor chain from start up to the filesystem root (bounded). */
function ancestorChain(start: string): string[] {
  const chain = [start];
  let current = start;
  for (let i = 0; i < 100; i += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Project-relative POSIX source: portable across Linux/Windows. */
function rebaseSource(source: string, evidenceDir: string, baseDir: string): string {
  if (evidenceDir === baseDir) return source;
  const prefix = relative(baseDir, evidenceDir).split(sep).join("/");
  return `${prefix}/${source}`;
}

function scanDirectory(dir: string) {
  return {
    entries: [...listDirectory(dir)].sort(),
    readFile: readFileText,
    isRealDirectory,
  };
}

/**
 * Resolve the full project fingerprint for a project path. Throws a plain
 * Error for caller errors (missing path); empty/unknown directories yield a
 * neutral fingerprint with null roots (absence is never mismatch).
 */
export function resolveProjectFingerprint(projectPath: string): ProjectFingerprint {
  let realStart: string;
  try {
    realStart = realpathSync(resolve(projectPath));
  } catch {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  let packageRoot: string | null = null;
  let workspaceRoot: string | null = null;
  for (const dir of ancestorChain(realStart)) {
    const entries = listDirectory(dir);
    if (packageRoot === null && hasRecognizedManifest(entries)) {
      packageRoot = dir;
    }
    if (workspaceRoot === null && hasWorkspaceMarker(dir, entries)) {
      workspaceRoot = dir;
    }
    if (packageRoot !== null && workspaceRoot !== null) break;
  }

  const packageEvidence: FingerprintEvidence[] =
    packageRoot === null ? [] : detectDirectoryEvidence(packageRoot, scanDirectory(packageRoot));
  // Same dir contributes both app and workspace records once; a distinct
  // workspace root contributes WORKSPACE records only — never app identity.
  const workspaceEvidence: FingerprintEvidence[] =
    workspaceRoot === null || workspaceRoot === packageRoot
      ? []
      : detectDirectoryEvidence(workspaceRoot, scanDirectory(workspaceRoot)).filter(
          (record) => record.kind === "WORKSPACE",
        );

  const evidence = [...packageEvidence, ...workspaceEvidence]
    .map((record) => ({
      ...record,
      source: rebaseSource(
        record.source,
        workspaceEvidence.includes(record) && workspaceRoot !== null ? workspaceRoot : (packageRoot ?? realStart),
        realStart,
      ),
    }))
    .sort((a, b) =>
      a.kind < b.kind
        ? -1
        : a.kind > b.kind
          ? 1
          : a.value < b.value
            ? -1
            : a.value > b.value
              ? 1
              : a.source < b.source
                ? -1
                : a.source > b.source
                  ? 1
                  : 0,
    );
  const sets = deriveFingerprintSets(evidence);

  return {
    projectPath: realStart,
    packageRoot,
    workspaceRoot,
    workspaceAmbiguous:
      workspaceRoot !== null &&
      realStart === workspaceRoot &&
      !packageEvidence.some((record) => record.kind === "FRAMEWORK"),
    languages: sets.languages,
    platforms: sets.platforms,
    frameworks: sets.frameworks,
    evidence,
  };
}
