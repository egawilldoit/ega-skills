// TEST-001 project fixture builder (§5.1.1.3 exact table, EGA-580).
//
// Builds REAL minimal directory trees on disk (node:fs sync only) for the 17
// golden project fixtures. Layout contract:
//
//   buildProjectFixture(fixtureId, rootDir) -> string | null
//     - Creates the fixture tree under `rootDir` (created if missing).
//     - Returns the absolute EFFECTIVE PROJECT PATH per the table's
//       `projectPath` column, or `rootDir` itself when the table lists no
//       explicit projectPath. `null` is never returned for a known fixture.
//     - Throws RangeError for a fixtureId absent from PROJECT_FIXTURES.
//
//   nextjs-web-via-symlink
//     - Creates `rootDir/real/` (byte-identical to the `nextjs-web` tree) and
//       `rootDir/project` as a directory symlink/junction pointing at it; the
//       returned project path is the SYMLINK `rootDir/project` (the resolver
//       works on the realpath, SPEC-005 §5.1.1 rule 1 / TEST-001 G042).
//
// Every file is byte-deterministic: fixed contents, sorted lock serialization,
// no timestamps. The lock `generated_from.config_hash` is the live SHA-256 of
// the RFC8785 JCS canonicalized built-in DEFAULT ProjectConfigV1 (SPEC-005
// §5.1.5 rule 2), because lock fixtures carry no `.egaskills.yaml`.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { PROJECT_FIXTURES } from "./catalog-data.mjs";

/** Frozen current-version hash of `ega/systematic-debugging` (golden-hashes.json). */
export const SYSTEMATIC_DEBUGGING_VERSION_HASH =
  "sha256:07ddeac0f417a7b6a712b820cfc44c42c4dd500b3922ec43831f44b711144ca9";

/**
 * Marker-table mirror of the §5.1.1.3 evidence column: fixtureId -> relative
 * paths (files or directories) that MUST exist after a build. The symlink
 * fixture lists `project` (a directory symlink/junction).
 * @type {Object<string, string[]>}
 */
export const PROJECT_FIXTURE_MARKERS = {
  "nextjs-web": ["package.json"],
  "vite-react-web": ["package.json"],
  "angular-web": ["package.json", "angular.json"],
  "expo-mobile": ["package.json"],
  "react-native-mobile": ["package.json", "android", "ios"],
  "node-api": ["package.json", "tsconfig.json"],
  "java-service": ["pom.xml"],
  "python-api": ["pyproject.toml"],
  "generic-project": ["README.md"],
  "nextjs-deny-experimental": ["package.json", ".egaskills.yaml"],
  "nextjs-lock-debug-only": ["package.json", ".egaskills.lock"],
  "mono-web": ["package.json", "apps/web/package.json", "apps/mobile/package.json"],
  "mono-mobile": ["package.json", "apps/web/package.json", "apps/mobile/package.json"],
  "mono-api": [
    "package.json",
    "apps/web/package.json",
    "apps/mobile/package.json",
    "services/api/package.json",
  ],
  "mono-root-ambiguous": [
    "package.json",
    "apps/web/package.json",
    "apps/mobile/package.json",
    "services/api/package.json",
  ],
  "generic-empty-lock": ["README.md", ".egaskills.lock"],
  "nextjs-web-via-symlink": ["project"],
};

const KNOWN_FIXTURE_IDS = new Set(PROJECT_FIXTURES.map((entry) => entry.fixtureId));

/** True when the lock entry key is a canonical `<namespace>/<portable-name>` ID. */
function isCanonicalSkillId(id) {
  return /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

/**
 * Minimal RFC8785 (JCS) serialization for the fixed normalized-default
 * ProjectConfigV1 object: sorted object keys, no insignificant whitespace.
 * This object graph contains only strings/booleans/integers/arrays/objects,
 * so plain JSON semantics match JCS here (no floats, no non-ASCII).
 */
function jcs(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * SPEC-005 §5.1.8/§5.1.9 config hash of the built-in DEFAULT config (§5.1.5
 * rule 2): `sha256:` + SHA-256 of the JCS-canonicalized normalized object.
 */
function defaultConfigHash() {
  const normalized = {
    schema_version: 1,
    routing: { mode: "suggest", max_skills: 3, max_tokens: 5000 },
    namespaces: { allow: [], deny: [] },
    skills: { prefer: [], deny: [] },
    locking: { required: false },
  };
  const digest = createHash("sha256").update(jcs(normalized), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** @type {string} Frozen computed at module load (constant input => constant output). */
const DEFAULTS_CONFIG_HASH = defaultConfigHash();

/** Deterministic 2-space-indented JSON + trailing newline (parents created). */
function writeJsonFile(relDir, fileName, record) {
  mkdirSync(relDir, { recursive: true });
  writeFileSync(join(relDir, fileName), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Deterministic YAML config for `nextjs-deny-experimental` (SPEC-005 §5.1.7). */
function writeDenyExperimentalConfig(dir) {
  writeFileSync(
    join(dir, ".egaskills.yaml"),
    [
      "schema_version: 1",
      "routing:",
      "  mode: suggest",
      "namespaces:",
      "  deny: [experimental]",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Deterministic active lock: `_skills` entries in sorted canonical-ID order. */
function writeLockFile(dir, skills) {
  const record = {
    generated_from: { config_hash: DEFAULTS_CONFIG_HASH },
    lockfile_version: 1,
    skills,
    token_estimator: "ega-o200k-v1",
  };
  writeJsonFile(dir, ".egaskills.lock", record);
}

/** `nextjs-web` table evidence: package.json with `react` + `next`. */
function buildNextjsWeb(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "nextjs-web",
    version: "1.0.0",
    private: true,
    dependencies: { next: "14.2.5", react: "18.3.1", "react-dom": "18.3.1" },
  });
}

/** `vite-react-web` evidence: package.json with `react` + `vite`. */
function buildViteReactWeb(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "vite-react-web",
    version: "1.0.0",
    private: true,
    dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
    devDependencies: { vite: "5.4.2" },
  });
}

/** `angular-web` evidence: package.json with `@angular/core` + `angular.json`. */
function buildAngularWeb(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "angular-web",
    version: "1.0.0",
    private: true,
    dependencies: { "@angular/core": "17.3.0", "@angular/common": "17.3.0" },
  });
  writeJsonFile(dir, "angular.json", {
    version: 1,
    newProjectRoot: "projects",
    projects: { "angular-web": { projectType: "application", root: "", sourceRoot: "src" } },
    defaultProject: "angular-web",
  });
}

/** `expo-mobile` evidence: package.json with `react`, `react-native`, `expo`. */
function buildExpoMobile(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "expo-mobile",
    version: "1.0.0",
    private: true,
    dependencies: { expo: "51.0.0", react: "18.3.1", "react-native": "0.74.3" },
  });
}

/** `react-native-mobile` evidence: react + react-native + REAL android/ and ios/. */
function buildReactNativeMobile(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "react-native-mobile",
    version: "1.0.0",
    private: true,
    dependencies: { react: "18.3.1", "react-native": "0.74.3" },
  });
  // Real directories (never links): isRealDirectory must see genuine dirs.
  mkdirSync(join(dir, "android"), { recursive: true });
  mkdirSync(join(dir, "ios"), { recursive: true });
  writeFileSync(join(dir, "android", ".gitkeep"), "", "utf8");
  writeFileSync(join(dir, "ios", ".gitkeep"), "", "utf8");
}

/** `node-api` evidence: Node/TS manifest, no web/mobile framework deps. */
function buildNodeApi(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "node-api",
    version: "1.0.0",
    private: true,
    dependencies: {},
    devDependencies: { typescript: "5.5.3" },
  });
  writeJsonFile(dir, "tsconfig.json", {
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
  });
}

/** `java-service` evidence: nearest pom.xml; language java; no Spring markers. */
function buildJavaService(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pom.xml"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>ega.fixture</groupId>",
      "  <artifactId>java-service</artifactId>",
      "  <version>1.0.0</version>",
      "</project>",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** `python-api` evidence: nearest pyproject.toml; language python. */
function buildPythonApi(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pyproject.toml"),
    ["[project]", 'name = "python-api"', 'version = "1.0.0"', ""].join("\n"),
    "utf8",
  );
}

/** `generic-project` evidence: no recognized framework/platform manifest at all. */
function buildGenericProject(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# generic-project\n", "utf8");
}

/**
 * Shared mono workspace tree (task fixture spec): root workspace package,
 * `apps/web` Next.js (`react` + `next`), `apps/mobile` Expo (`react` +
 * `react-native` + `expo`), `services/api` Node/TS. Root package is private
 * with no framework deps => no deterministic application package at the root.
 */
function buildMonoWorkspace(dir) {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(dir, "package.json", {
    name: "mono",
    version: "1.0.0",
    private: true,
    workspaces: ["apps/*", "services/*"],
  });
  buildNextjsWeb(join(dir, "apps", "web"));
  writeJsonFile(join(dir, "apps", "mobile"), "package.json", {
    name: "mono-mobile",
    version: "1.0.0",
    private: true,
    dependencies: { expo: "51.0.0", react: "18.3.1", "react-native": "0.74.3" },
  });
  writeJsonFile(join(dir, "services", "api"), "package.json", {
    name: "mono-api",
    version: "1.0.0",
    private: true,
    dependencies: {},
    devDependencies: { typescript: "5.5.3" },
  });
}

/** `nextjs-web-via-symlink`: real `nextjs-web` tree + directory symlink/junction. */
function buildNextjsWebViaSymlink(rootDir) {
  const realDir = join(rootDir, "real");
  buildNextjsWeb(realDir);
  const linkPath = join(rootDir, "project");
  // Windows supports directory links only via "junction"; elsewhere plain "dir".
  symlinkSync(resolve(realDir), linkPath, process.platform === "win32" ? "junction" : "dir");
  return linkPath;
}

/**
 * Build a golden project fixture (§5.1.1.3) under `rootDir`.
 * @param {string} fixtureId Logical fixture ID from PROJECT_FIXTURES.
 * @param {string} rootDir   Absolute directory to create the tree into.
 * @returns {string} Absolute effective project path (projectPath column).
 */
export function buildProjectFixture(fixtureId, rootDir) {
  if (!KNOWN_FIXTURE_IDS.has(fixtureId)) {
    throw new RangeError(`Unknown project fixture id: ${fixtureId}`);
  }
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });

  switch (fixtureId) {
    case "nextjs-web":
      buildNextjsWeb(root);
      return root;
    case "vite-react-web":
      buildViteReactWeb(root);
      return root;
    case "angular-web":
      buildAngularWeb(root);
      return root;
    case "expo-mobile":
      buildExpoMobile(root);
      return root;
    case "react-native-mobile":
      buildReactNativeMobile(root);
      return root;
    case "node-api":
      buildNodeApi(root);
      return root;
    case "java-service":
      buildJavaService(root);
      return root;
    case "python-api":
      buildPythonApi(root);
      return root;
    case "generic-project":
      buildGenericProject(root);
      return root;
    case "nextjs-deny-experimental":
      buildNextjsWeb(root);
      writeDenyExperimentalConfig(root);
      return root;
    case "nextjs-lock-debug-only":
      buildNextjsWeb(root);
      writeLockFile(root, {
        "ega/systematic-debugging": {
          name: "systematic-debugging",
          version_hash: SYSTEMATIC_DEBUGGING_VERSION_HASH,
        },
      });
      return root;
    case "mono-web":
      buildMonoWorkspace(root);
      return join(root, "apps", "web");
    case "mono-mobile":
      buildMonoWorkspace(root);
      return join(root, "apps", "mobile");
    case "mono-api":
      buildMonoWorkspace(root);
      return join(root, "services", "api");
    case "mono-root-ambiguous":
      buildMonoWorkspace(root);
      return root;
    case "generic-empty-lock":
      buildGenericProject(root);
      writeLockFile(root, {});
      return root;
    case "nextjs-web-via-symlink":
      return buildNextjsWebViaSymlink(root);
    default:
      // Unreachable: fixtureId already validated against the catalog.
      throw new RangeError(`Unknown project fixture id: ${fixtureId}`);
  }
}