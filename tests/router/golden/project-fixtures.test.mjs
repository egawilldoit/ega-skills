// TEST-001 project fixture build tests (§5.1.1.3 table, EGA-580).
//
// Verifies the builder contract for all 17 golden project fixtures:
//   - every fixture builds without error and reports an existing project path;
//   - the §5.1.1.3 evidence markers exist per fixture;
//   - lock fixtures are schema-shaped and pin `ega/systematic-debugging` at
//     its FROZEN version hash (golden-hashes.json), nothing else;
//   - `nextjs-web-via-symlink` resolves through realpath to the real tree
//     (SPEC-005 §5.1.1 rule 1 / TEST-001 G042);
//   - repeated builds are byte-identical (deterministic, no timestamps).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROJECT_FIXTURES } from "./catalog-data.mjs";
import {
  PROJECT_FIXTURE_MARKERS,
  SYSTEMATIC_DEBUGGING_VERSION_HASH,
  buildProjectFixture,
} from "./project-fixtures.mjs";

const GOLDEN_HASHES_PATH = fileURLToPath(new URL("./golden-hashes.json", import.meta.url));

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "ega-project-fixtures-"));
}

/** Sorted relative entries of a build tree; regular files carry their bytes. */
function dumpTree(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel === "" ? dir : join(dir, rel);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        walk(join(rel, name));
      }
    } else if (stat.isFile()) {
      out.push(`${rel} -> ${JSON.stringify(readFileSync(abs, "utf8"))}`);
    } else {
      out.push(`OTHER ${rel}`);
    }
  };
  walk("");
  return out.sort();
}

function readLock(projectPath) {
  return JSON.parse(readFileSync(join(projectPath, ".egaskills.lock"), "utf8"));
}

test("TEST-001: catalog lists exactly the 17 §5.1.1.3 project fixtures", () => {
  assert.equal(PROJECT_FIXTURES.length, 17);
  assert.deepEqual(
    PROJECT_FIXTURES.map((entry) => entry.fixtureId).sort(),
    [
      "angular-web",
      "expo-mobile",
      "generic-empty-lock",
      "generic-project",
      "java-service",
      "mono-api",
      "mono-mobile",
      "mono-root-ambiguous",
      "mono-web",
      "nextjs-deny-experimental",
      "nextjs-lock-debug-only",
      "nextjs-web",
      "nextjs-web-via-symlink",
      "node-api",
      "python-api",
      "react-native-mobile",
      "vite-react-web",
    ],
  );
});

test("TEST-001: all 17 fixtures build without error with their project-path variants", (t) => {
  assert.equal(PROJECT_FIXTURES.length, 17);
  for (const entry of PROJECT_FIXTURES) {
    const root = freshRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let projectPath = null;
    assert.doesNotThrow(() => {
      projectPath = buildProjectFixture(entry.fixtureId, root);
    }, `${entry.fixtureId} must build without throwing`);
    assert.equal(typeof projectPath, "string", `${entry.fixtureId} must return a project path`);
    const stat = statSync(projectPath);
    assert.ok(stat.isDirectory(), `${entry.fixtureId}: project path must be a directory`);
  }
});

test("TEST-001: projectPath variants match their §5.1.1.3 rows", (t) => {
  const cases = [
    ["mono-web", "apps", "web"],
    ["mono-mobile", "apps", "mobile"],
    ["mono-api", "services", "api"],
    ["mono-root-ambiguous", ""],
  ];
  for (const [fixtureId, ...relParts] of cases) {
    const root = freshRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const projectPath = buildProjectFixture(fixtureId, root);
    assert.equal(projectPath, join(root, ...relParts), `${fixtureId} projectPath`);
  }
});

test("TEST-001: unknown fixture ids are rejected deterministically", () => {
  assert.throws(() => buildProjectFixture("not-a-fixture", freshRoot()), RangeError);
});

test("TEST-001: key evidence markers exist per fixture (marker table)", (t) => {
  for (const entry of PROJECT_FIXTURES) {
    const root = freshRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    buildProjectFixture(entry.fixtureId, root);
    for (const marker of PROJECT_FIXTURE_MARKERS[entry.fixtureId]) {
      assert.doesNotThrow(
        () => statSync(join(root, marker)),
        `${entry.fixtureId}: marker ${marker} must exist`,
      );
    }
  }
});

test("TEST-001: nextjs-web evidence is react + next; mono workspace apps carry their frameworks", (t) => {
  const root = freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  buildProjectFixture("nextjs-web", root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok("react" in pkg.dependencies, "nextjs-web must declare react");
  assert.ok("next" in pkg.dependencies, "nextjs-web must declare next");

  const monoRoot = freshRoot();
  t.after(() => rmSync(monoRoot, { recursive: true, force: true }));
  const web = buildProjectFixture("mono-web", monoRoot);
  const webPkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
  assert.ok("react" in webPkg.dependencies && "next" in webPkg.dependencies);
  const mobile = buildProjectFixture("mono-mobile", monoRoot);
  const mobilePkg = JSON.parse(readFileSync(join(mobile, "package.json"), "utf8"));
  assert.ok(
    "react" in mobilePkg.dependencies &&
      "react-native" in mobilePkg.dependencies &&
      "expo" in mobilePkg.dependencies,
  );
  const api = buildProjectFixture("mono-api", monoRoot);
  const apiPkg = JSON.parse(readFileSync(join(api, "package.json"), "utf8"));
  assert.ok("typescript" in apiPkg.devDependencies);
});

test("TEST-001: nextjs-deny-experimental carries namespaces.deny [experimental]", (t) => {
  const root = freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  buildProjectFixture("nextjs-deny-experimental", root);
  const config = readFileSync(join(root, ".egaskills.yaml"), "utf8");
  assert.match(config, /namespaces:/);
  assert.match(config, /deny:\s*\[experimental\]/);
});

test("TEST-001: nextjs-lock-debug-only pins ONLY systematic-debugging at its frozen hash", (t) => {
  const root = freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectPath = buildProjectFixture("nextjs-lock-debug-only", root);
  const golden = JSON.parse(readFileSync(GOLDEN_HASHES_PATH, "utf8"));
  const frozen = golden["skill-systematic-debugging-v1"].versionHash;
  assert.equal(frozen, SYSTEMATIC_DEBUGGING_VERSION_HASH, "builder and golden hashes must agree");

  const lock = readLock(projectPath);
  assert.equal(lock.lockfile_version, 1);
  assert.equal(lock.token_estimator, "ega-o200k-v1");
  assert.match(lock.generated_from.config_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(lock.skills), ["ega/systematic-debugging"]);
  const entry = lock.skills["ega/systematic-debugging"];
  assert.equal(entry.name, "systematic-debugging");
  assert.equal(entry.version_hash, frozen, "lock must pin the frozen version hash");
});

test("TEST-001: generic-empty-lock is a valid active lock with skills: {}", (t) => {
  const root = freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectPath = buildProjectFixture("generic-empty-lock", root);
  const lock = readLock(projectPath);
  assert.equal(lock.lockfile_version, 1);
  assert.equal(lock.token_estimator, "ega-o200k-v1");
  assert.match(lock.generated_from.config_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(lock.skills, {});
});

test("TEST-001: nextjs-web-via-symlink realpath resolves to the real nextjs-web tree", (t) => {
  const root = freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const linkPath = buildProjectFixture("nextjs-web-via-symlink", root);
  assert.equal(linkPath, join(root, "project"));
  // realpathSync resolves the link/junction to the real tree (G042).
  assert.equal(realpathSync(linkPath), realpathSync(join(root, "real")));
  const realPkg = JSON.parse(readFileSync(join(root, "real", "package.json"), "utf8"));
  assert.ok("next" in realPkg.dependencies, "real target must be a full nextjs-web tree");
  // The link itself is a directory symlink (never a copied tree).
  const linkStat = statSync(linkPath);
  assert.ok(linkStat.isDirectory());
});

test("TEST-001: builds are byte-identical across runs (deterministic, no timestamps)", (t) => {
  for (const entry of PROJECT_FIXTURES) {
    const rootA = freshRoot();
    const rootB = freshRoot();
    t.after(() => rmSync(rootA, { recursive: true, force: true }));
    t.after(() => rmSync(rootB, { recursive: true, force: true }));
    buildProjectFixture(entry.fixtureId, rootA);
    buildProjectFixture(entry.fixtureId, rootB);
    assert.deepEqual(dumpTree(rootA), dumpTree(rootB), `${entry.fixtureId} must be byte-identical`);
  }
});