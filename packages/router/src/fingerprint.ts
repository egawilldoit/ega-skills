// SPEC-004 §5.1.8 project fingerprint detectors (EGA-571).
//
// Manifest/config evidence ONLY: package.json/lockfiles/tsconfig, Next/Vite/
// Angular/Expo markers, Maven/Gradle, Python metadata, Cargo, workspace
// markers. No source crawl, no semantic analysis, no LLM, no guessing beyond
// the frozen matrix. Every record identifies the exact file/property/path
// that caused it; absence of evidence is neutral (never a mismatch).
//
// This module detects evidence for ONE directory. Nearest-package assembly,
// workspace roots and ambiguity are EGA-572 (SPEC-004 §5.1.9).

export interface FingerprintEvidence {
  readonly kind: "LANGUAGE" | "FRAMEWORK" | "PLATFORM" | "WORKSPACE";
  readonly value: string;
  readonly source: string;
}

export interface ProjectFingerprint {
  readonly projectPath: string;
  readonly packageRoot: string | null;
  readonly workspaceRoot: string | null;
  readonly workspaceAmbiguous: boolean;
  readonly languages: string[];
  readonly platforms: string[];
  readonly frameworks: string[];
  readonly evidence: FingerprintEvidence[];
}

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;

interface PackageJson {
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly workspaces?: unknown;
}

function readJsonFile(readFile: (path: string) => string | null, path: string): unknown {
  const text = readFile(path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Unparseable manifests contribute no evidence (absence is neutral).
    return undefined;
  }
}

function asStringMap(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function readPackageJson(readFile: (path: string) => string | null, dir: string): PackageJson | null {
  const parsed = readJsonFile(readFile, `${dir}/package.json`);
  const record = asStringMap(parsed);
  if (record === null) return null;
  const pkg: Record<string, unknown> = {};
  for (const section of DEP_SECTIONS) {
    const map = asStringMap(record[section]);
    if (map !== null) pkg[section] = map;
  }
  if (record["workspaces"] !== undefined) pkg["workspaces"] = record["workspaces"];
  return pkg as PackageJson;
}

function depSource(pkg: PackageJson, dep: string): string | null {
  for (const section of DEP_SECTIONS) {
    const map = asStringMap(pkg[section]);
    if (map !== null && Object.prototype.hasOwnProperty.call(map, dep)) {
      return `package.json#${section}.${dep}`;
    }
  }
  return null;
}

export interface DirectoryScan {
  /** Directory listing (basenames). Need not be sorted; output always is. */
  readonly entries: readonly string[];
  readonly readFile: (path: string) => string | null;
  /** True when the named child exists as a real directory (never a link). */
  readonly isRealDirectory: (path: string) => boolean;
}

function matchConfigFiles(entries: readonly string[], prefix: string): string[] {
  return entries
    .filter((name) => name.length > prefix.length && name.startsWith(prefix))
    .sort();
}

/**
 * Detect frozen-matrix evidence for one directory. Pure given the scan;
 * filesystem access lives in fingerprintDirectory below.
 */
export function detectDirectoryEvidence(dir: string, scan: DirectoryScan): FingerprintEvidence[] {
  const evidence: FingerprintEvidence[] = [];
  const entries = [...scan.entries].sort();
  const has = (name: string): boolean => entries.includes(name);

  const pkg = readPackageJson(scan.readFile, dir);
  if (pkg !== null) {
    evidence.push({ kind: "LANGUAGE", value: "node", source: "package.json" });
    const tsSource = depSource(pkg, "typescript");
    if (tsSource !== null) {
      evidence.push({ kind: "LANGUAGE", value: "typescript", source: tsSource });
    }
    if (pkg.workspaces !== undefined) {
      evidence.push({ kind: "WORKSPACE", value: "package.json#workspaces", source: "package.json#workspaces" });
    }
  }
  if (has("tsconfig.json")) {
    if (!evidence.some((record) => record.kind === "LANGUAGE" && record.value === "typescript")) {
      evidence.push({ kind: "LANGUAGE", value: "typescript", source: "tsconfig.json" });
    }
  }
  for (const lockfile of LOCKFILES) {
    if (has(lockfile)) {
      evidence.push({ kind: "LANGUAGE", value: "node", source: lockfile });
    }
  }

  // Node frameworks: dependency first, then config-file markers (exact matrix).
  const frameworkDeps: Array<{ value: string; dep: string }> = [
    { value: "react", dep: "react" },
    { value: "nextjs", dep: "next" },
    { value: "vite", dep: "vite" },
    { value: "angular", dep: "@angular/core" },
    { value: "expo", dep: "expo" },
    { value: "react-native", dep: "react-native" },
  ];
  const frameworkSources = new Map<string, string>();
  if (pkg !== null) {
    for (const { value, dep } of frameworkDeps) {
      const source = depSource(pkg, dep);
      if (source !== null) {
        evidence.push({ kind: "FRAMEWORK", value, source });
        frameworkSources.set(value, source);
      }
    }
  }
  const configFrameworks: Array<{ value: string; names: (name: string) => boolean }> = [
    { value: "nextjs", names: (name) => name.length > "next.config.".length && name.startsWith("next.config.") },
    { value: "vite", names: (name) => name.length > "vite.config.".length && name.startsWith("vite.config.") },
    { value: "angular", names: (name) => name === "angular.json" },
    {
      value: "expo",
      names: (name) =>
        name === "app.json" ||
        (name.length > "app.config.".length && name.startsWith("app.config.")),
    },
  ];
  for (const { value, names } of configFrameworks) {
    for (const file of entries.filter(names)) {
      if (!frameworkSources.has(value)) {
        frameworkSources.set(value, file);
      }
      evidence.push({ kind: "FRAMEWORK", value, source: file });
    }
  }

  // Platforms: mobile from Expo/RN evidence or android/ios dirs; web from
  // Next/Vite/Angular unless contradicted by package-local mobile evidence.
  const hasExpoOrRn = frameworkSources.has("expo") || frameworkSources.has("react-native");
  const hasAndroid = scan.isRealDirectory(`${dir}/android`);
  const hasIos = scan.isRealDirectory(`${dir}/ios`);
  if (hasExpoOrRn || hasAndroid || hasIos) {
    const cause = hasAndroid
      ? "android/"
      : hasIos
        ? "ios/"
        : (frameworkSources.get("expo") ?? frameworkSources.get("react-native") ?? "package.json");
    evidence.push({ kind: "PLATFORM", value: "mobile", source: cause });
  }
  const hasWebFramework =
    frameworkSources.has("nextjs") || frameworkSources.has("vite") || frameworkSources.has("angular");
  if (hasWebFramework && !hasAndroid && !hasIos && !hasExpoOrRn) {
    const cause =
      frameworkSources.get("nextjs") ?? frameworkSources.get("vite") ?? frameworkSources.get("angular") ?? "package.json";
    evidence.push({ kind: "PLATFORM", value: "web", source: cause });
  }

  // Non-Node manifests contribute LANGUAGE evidence only.
  if (has("pom.xml")) {
    evidence.push({ kind: "LANGUAGE", value: "java", source: "pom.xml" });
  }
  if (has("build.gradle")) {
    evidence.push({ kind: "LANGUAGE", value: "java", source: "build.gradle" });
  }
  if (has("build.gradle.kts")) {
    evidence.push({ kind: "LANGUAGE", value: "java", source: "build.gradle.kts" });
  }
  if (has("pyproject.toml")) {
    evidence.push({ kind: "LANGUAGE", value: "python", source: "pyproject.toml" });
  }
  if (has("setup.py")) {
    evidence.push({ kind: "LANGUAGE", value: "python", source: "setup.py" });
  }
  for (const name of entries.filter((entry) => entry === "requirements.txt" || (entry.startsWith("requirements-") && entry.endsWith(".txt")))) {
    evidence.push({ kind: "LANGUAGE", value: "python", source: name });
  }
  if (has("Cargo.toml")) {
    evidence.push({ kind: "LANGUAGE", value: "rust", source: "Cargo.toml" });
  }

  // Workspace markers: workspace/tooling evidence only, never identity.
  if (has("pnpm-workspace.yaml")) {
    evidence.push({ kind: "WORKSPACE", value: "pnpm-workspace.yaml", source: "pnpm-workspace.yaml" });
  }
  if (has("lerna.json")) {
    evidence.push({ kind: "WORKSPACE", value: "lerna.json", source: "lerna.json" });
  }
  if (has("nx.json")) {
    evidence.push({ kind: "WORKSPACE", value: "nx.json", source: "nx.json" });
  }
  const cargoText = scan.readFile(`${dir}/Cargo.toml`);
  if (cargoText !== null && /^\s*\[workspace\]/m.test(cargoText)) {
    evidence.push({ kind: "WORKSPACE", value: "cargo-workspace", source: "Cargo.toml#[workspace]" });
  }

  return evidence;
}

/** Sorted unique values per evidence kind. */
export function deriveFingerprintSets(evidence: readonly FingerprintEvidence[]): {
  languages: string[];
  platforms: string[];
  frameworks: string[];
} {
  const select = (kind: FingerprintEvidence["kind"]): string[] =>
    [...new Set(evidence.filter((record) => record.kind === kind).map((record) => record.value))].sort();
  return {
    languages: select("LANGUAGE"),
    platforms: select("PLATFORM"),
    frameworks: select("FRAMEWORK"),
  };
}

/**
 * Filesystem detection for one directory: listing, manifest reads and
 * real-directory checks. Sync reads only (small manifests); symlinks and
 * junctions never count as directories.
 */
export function fingerprintDirectory(
  fs: {
    listDirectory(dir: string): string[];
    readFileText(path: string): string | null;
    isRealDirectory(path: string): boolean;
  },
  dir: string,
): FingerprintEvidence[] {
  return detectDirectoryEvidence(dir, {
    entries: fs.listDirectory(dir),
    readFile: (path) => fs.readFileText(path),
    isRealDirectory: (path) => fs.isRealDirectory(path),
  });
}
