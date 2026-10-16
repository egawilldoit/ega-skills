/**
 * Properties of the web deployment's artifact staging step.
 *
 * `scripts/web/stage-artifact.mjs` is what makes `apps/web/vercel.json`'s
 * `artifact` include path resolve to anything at all. Before it existed, the
 * console deployed with no verified release, because the committed artifact
 * lives at `packages/mcp/artifact` — outside the directory Vercel collects.
 *
 * These tests pin the properties that make the step safe rather than merely
 * present: it refuses a bad artifact, it copies rather than regenerates, it is
 * deterministic, and it does not leave stale files behind.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";

import {
  COMMITTED_RELEASE_DIGEST,
  COMMITTED_SQLITE_DIGEST,
} from "../helpers/committed-artifact.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "web", "stage-artifact.mjs");
const ARTIFACT = join(REPO_ROOT, "packages", "mcp", "artifact");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");

const tempDirs = [];
function scratchCopy() {
  const dir = mkdtempSync(join(tmpdir(), "ega-stage-"));
  tempDirs.push(dir);
  cpSync(ARTIFACT, dir, { recursive: true });
  return dir;
}

/** Run the script and return `{ status, stdout, stderr }`. */
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("the committed artifact is servable", () => {
  test("verification passes against the committed artifact", () => {
    const result = run(["--check-only"]);
    assert.equal(result.status, 0, `refused a valid artifact: ${result.stderr}`);
    // The identity it prints must be the artifact's own, read from the artifact.
    assert.match(result.stdout, /116|skill/);
  });

  test("verification prints the artifact's real identity", () => {
    const result = run(["--check-only"]);
    assert.equal(result.stdout.includes(COMMITTED_RELEASE_DIGEST), true, "hub release digest");
    assert.equal(result.stdout.includes(COMMITTED_SQLITE_DIGEST), true, "sqlite artifact digest");
  });
});

describe("a bad artifact is refused, not deployed", () => {
  test("tampered SQLite bytes are refused", () => {
    const dir = scratchCopy();
    writeFileSync(join(dir, "registry.sqlite"), readFileSync(join(dir, "registry.sqlite")));
    // Append a single byte: the file is still a plausible sqlite file, but its
    // digest no longer matches the declared physical identity.
    const original = readFileSync(join(dir, "registry.sqlite"));
    writeFileSync(join(dir, "registry.sqlite"), Buffer.concat([original, Buffer.from("x")]));

    const result = run(["--from", dir, "--check-only"]);
    assert.equal(result.status, 1, "a tampered artifact must fail the build");
    assert.match(result.stderr, /REFUSED/);
  });

  test("a tampered envelope is refused", () => {
    const dir = scratchCopy();
    const envelopePath = join(dir, "hub-release.json");
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
    const lastKey = Object.keys(envelope.payload.skill_versions).pop();
    delete envelope.payload.skill_versions[lastKey];
    writeFileSync(envelopePath, JSON.stringify(envelope));

    const result = run(["--from", dir, "--check-only"]);
    assert.equal(result.status, 1, "a tampered envelope must fail the build");
    assert.match(result.stderr, /REFUSED/);
  });

  test("a missing required file is refused", () => {
    const dir = scratchCopy();
    rmSync(join(dir, "hub-release.json"));
    const result = run(["--from", dir, "--check-only"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required files/);
  });
});

describe("staging copies rather than regenerates", () => {
  test("the staged tree is byte-identical to the committed artifact", () => {
    const target = mkdtempSync(join(tmpdir(), "ega-stage-out-"));
    tempDirs.push(target);
    const result = run(["--to", target]);
    assert.equal(result.status, 0, result.stderr);

    // Compare digests rather than file listings alone: identical names with
    // different bytes is exactly the failure worth catching.
    for (const name of ["hub-release.json", "release-package.json", "registry.sqlite"]) {
      assert.deepEqual(
        readFileSync(join(target, name)),
        readFileSync(join(ARTIFACT, name)),
        `${name} must be staged byte-for-byte`,
      );
    }
  });

  test("the committed artifact is not modified by staging", () => {
    const before = readFileSync(join(ARTIFACT, "registry.sqlite"));
    run(["--to", mkdtempSync(join(tmpdir(), "ega-stage-out-"))]);
    assert.deepEqual(readFileSync(join(ARTIFACT, "registry.sqlite")), before);
  });

  test("staging is deterministic across runs", () => {
    const a = mkdtempSync(join(tmpdir(), "ega-stage-a-"));
    const b = mkdtempSync(join(tmpdir(), "ega-stage-b-"));
    tempDirs.push(a, b);
    assert.equal(run(["--to", a]).status, 0);
    assert.equal(run(["--to", b]).status, 0);
    for (const name of ["hub-release.json", "registry.sqlite", "release-package.json"]) {
      assert.deepEqual(readFileSync(join(a, name)), readFileSync(join(b, name)), name);
    }
  });

  test("a file left by an earlier staging does not survive into the next", () => {
    // A merge would let a file deleted upstream linger, so the deployment would
    // serve bytes that no longer exist in the repository.
    const target = mkdtempSync(join(tmpdir(), "ega-stage-out-"));
    tempDirs.push(target);
    assert.equal(run(["--to", target]).status, 0);

    const stale = join(target, "STALE-FROM-PREVIOUS-STAGING.txt");
    writeFileSync(stale, "left over\n");
    assert.equal(existsSync(stale), true);

    assert.equal(run(["--to", target]).status, 0);
    assert.equal(existsSync(stale), false, "staging must replace, not merge");
  });
});

describe("the deployment is wired to stage", () => {
  test("vercel.json runs the staging step before the build", () => {
    const vercel = JSON.parse(readFileSync(join(WEB_ROOT, "vercel.json"), "utf8"));
    assert.match(
      vercel.buildCommand,
      /stage-artifact\.mjs/,
      "the build command must stage the artifact or the include path resolves to nothing",
    );
    assert.equal(
      vercel.builds[0].config.includeFiles.includes("artifact/**/*"),
      true,
      "the staged directory must be the one that is bundled",
    );
  });

  test("the staged directory is not committed", () => {
    const ignored = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
    assert.match(ignored, /apps\/web\/artifact\//);
  });

  test("every server environment variable is documented without a value", () => {
    const envSource = readFileSync(join(WEB_ROOT, "server", "env.ts"), "utf8");
    const example = readFileSync(join(WEB_ROOT, ".env.example"), "utf8");
    const keys = [...new Set([...envSource.matchAll(/"(EGA_[A-Z_]+)"/g)].map((m) => m[1]))];

    assert.ok(keys.length > 0, "the env module declares keys");
    for (const key of keys) {
      const line = example.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      assert.ok(line, `${key} must be documented in .env.example`);
      // A recorded value is either a credential or a stale claim about the
      // release. Both are wrong in an example file.
      assert.equal(line.slice(key.length + 1).trim(), "", `${key} must be documented with no value`);
    }
  });
});