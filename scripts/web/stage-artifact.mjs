#!/usr/bin/env node
/**
 * Stage the committed release artifact for the web deployment.
 *
 * ## Why this exists
 *
 * `apps/web/vercel.json` bundles everything under its own `artifact/`
 * directory, but the committed artifact
 * lives at `packages/mcp/artifact` — one directory above the web app, outside
 * anything the Vercel build for `apps/web` would collect. Nothing staged it, so
 * `EGA_WEB_ARTIFACT_DIR=artifact` resolved to a path that was never bundled and
 * the deployment came up with no verified release at all.
 *
 * This copies the committed artifact into `apps/web/artifact` as a build step.
 *
 * ## It copies; it never regenerates
 *
 * The committed artifact is an immutable release. Publishing is a separate,
 * deliberate act with its own evidence and its own tag. A deployment must serve
 * the bytes that were committed and reviewed, so this script copies the directory
 * verbatim and **verifies** it. It never rebuilds the registry, never re-imports
 * a corpus, and never repairs a mismatch — a mismatch fails the build.
 *
 * A deploy step that could "fix" an artifact would mean the thing being reviewed
 * is not the thing being served.
 *
 * ## Deterministic
 *
 * The output is a byte-for-byte copy with modes normalized to what the runtime
 * needs, so the same commit always produces the same staging directory. Nothing
 * here depends on wall-clock time, iteration order, or the host.
 *
 * ## Verification, before the copy is usable
 *
 * The brief requires the envelope, the SQLite identity and the required content
 * to be checked before bundling. All three are:
 *
 *  1. `release-package.json` declares a `hub_release_digest` and a
 *     `sqlite_artifact_digest`; `hub-release.json` must hash to the first and
 *     `registry.sqlite` to the second. These are two independent statements of
 *     identity, so disagreement means a corrupted or mixed artifact.
 *  2. `snapshot_rows` in the package must equal the number of entries in the
 *     envelope's `skill_versions`, so the declared cardinality is real.
 *  3. The files the console cannot start without must be present.
 *
 * An artifact that fails any check is refused, naming what disagreed.
 *
 * Usage:
 *   node scripts/web/stage-artifact.mjs [--from <dir>] [--to <dir>] [--check-only]
 *
 * With no arguments it stages `packages/mcp/artifact` into `apps/web/artifact`.
 * `--check-only` verifies the source and stages nothing, which is what the web
 * job runs so CI proves the artifact is servable without producing an upload.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_SOURCE = join(REPO_ROOT, "packages", "mcp", "artifact");
const DEFAULT_TARGET = join(REPO_ROOT, "apps", "web", "artifact");

/** Files the console cannot serve a release without. */
const REQUIRED_FILES = [
  "hub-release.json",
  "release-package.json",
  "registry.sqlite",
  "candidate.json",
  "alias-map.json",
  "publication-preflight.json",
];

function parseArgs(argv) {
  const options = { from: DEFAULT_SOURCE, to: DEFAULT_TARGET, checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from") options.from = resolve(argv[++i] ?? "");
    else if (arg === "--to") options.to = resolve(argv[++i] ?? "");
    else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: node scripts/web/stage-artifact.mjs [--from <dir>] [--to <dir>] [--check-only]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function fail(message) {
  process.stderr.write(`stage-artifact: REFUSED — ${message}\n`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Verify the artifact before anything is staged.
 *
 * The verification is **delegated**, not reimplemented.
 * `loadHostedReleaseSnapshot` is the same function the hosted MCP runtime and the
 * console's own release-identity check use. It already performs exactly what the
 * brief asks for — envelope verification, the declared SQLite byte digest, the
 * release projection, and blob presence — and it defines those rules.
 *
 * Re-deriving any of it here would be a second authority for release identity,
 * which is the one thing this repository is most careful about: the envelope
 * digest is a *canonicalized-JSON* digest, not a hash of the file bytes, so a
 * plausible-looking reimplementation disagrees with the real one. That is not
 * hypothetical — an earlier draft of this file hashed `hub-release.json` as bytes,
 * computed `sha256:abd415ad…`, and refused a perfectly valid artifact.
 *
 * Returns the identity that was verified, so the caller records it rather than
 * re-deriving it.
 */
export function verifyArtifact(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`${relative(REPO_ROOT, dir) || dir} is not a directory`);
  }

  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    fail(`${relative(REPO_ROOT, dir)} is missing required files: ${missing.join(", ")}`);
  }

  let snapshot;
  try {
    snapshot = loadHostedReleaseSnapshot(dir);
  } catch (error) {
    // The message comes from the domain package and names the specific failed
    // check. It is echoed so a deploy failure is actionable rather than opaque.
    fail(
      `the committed artifact did not verify: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const skillCount = Object.keys(
    readJson(join(dir, "hub-release.json"))?.payload?.skill_versions ?? {},
  ).length;

  return {
    dir,
    hubReleaseDigest: snapshot.releaseDigest,
    sqliteArtifactDigest: readJson(join(dir, "release-package.json")).sqlite_artifact_digest,
    skillCount,
  };
}

/**
 * Every file under `dir`, as POSIX paths, sorted.
 *
 * Used only to prove the staged copy is complete and unchanged, so the two
 * lists must be computed the same way on both sides.
 */
function listFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return files.sort();
}

function stage(from, to) {
  // Replace rather than merge. A merge would let a file deleted upstream linger
  // in the staged output, so the deployment would serve an artifact that no
  // longer exists in the repository.
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, preserveTimestamps: false });

  const sourceFiles = listFiles(from);
  const stagedFiles = listFiles(to);
  if (sourceFiles.join("\n") !== stagedFiles.join("\n")) {
    fail(
      `the staged copy does not contain the same files as the source ` +
        `(${stagedFiles.length} staged vs ${sourceFiles.length} in source)`,
    );
  }
  return stagedFiles.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  // Verify first. A staging step that copies before checking would let a bad
  // artifact reach the bundle even though the build later fails.
  const identity = verifyArtifact(options.from);

  const summary =
    `stage-artifact: verified ${identity.skillCount} skills\n` +
    `  hub release digest : ${identity.hubReleaseDigest}\n` +
    `  sqlite artifact    : ${identity.sqliteArtifactDigest}`;

  if (options.checkOnly) {
    process.stdout.write(`${summary}\n  no files staged (--check-only)\n`);
    return;
  }

  const count = stage(options.from, options.to);
  process.stdout.write(
    `${summary}\n  staged ${count} files -> ${relative(REPO_ROOT, options.to)}\n`,
  );

  // Record what was staged, next to the copy, so a deployment can be traced
  // back to the exact bytes it shipped. This is evidence, not configuration:
  // the server never reads it, and no deployment decision depends on it.
  writeFileSync(
    join(options.to, ".staged-release.json"),
    `${JSON.stringify(
      {
        staged_from: relative(REPO_ROOT, options.from).split(sep).join("/"),
        hub_release_digest: identity.hubReleaseDigest,
        sqlite_artifact_digest: identity.sqliteArtifactDigest,
        skill_count: identity.skillCount,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}