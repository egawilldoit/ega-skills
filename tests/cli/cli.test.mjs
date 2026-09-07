import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPackagePath = join(root, "packages", "cli", "package.json");
const cliEntrypoint = join(root, "packages", "cli", "bin", "ega-skills.mjs");
const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));

function runCli(...args) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function runCliFrom(cwd, ...args) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("ega-skills --version prints the package version and exits cleanly", () => {
  const result = runCli("--version");

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, `${cliPackage.version}\n`);
  assert.equal(result.stderr, "");
});

test("ega-skills --help prints the CLI surface and exits cleanly", () => {
  const result = runCli("--help");
  const expectedHelp = [
    "Usage:",
    "  ega-skills --help",
    "  ega-skills --version",
    "  ega-skills import <path> --namespace <namespace>",
    "  ega-skills list",
    "  ega-skills inspect <skill-id>",
    "  ega-skills init [<project-dir>] [--force]",
    "  ega-skills validate <path> [--json]",
    "  ega-skills init-skill <name>",
    "  ega-skills lock [<project-dir>] [--refresh]",
      "  ega-skills resolve --project <path> --task \"<task>\" [--explicit <id>] [--max-skills 1-3] [--max-tokens 1-1000000]",
      "  ega-skills hub build [<hub-dir>]",
      "  ega-skills hub check <source-id> [<hub-dir>] --output <plan.json>",
      "  ega-skills hub update --plan <plan.json> [<hub-dir>]",
    "",
    "Options:",
    "  --help     Show this help.",
    "  --version  Show the installed version.",
    "",
  ].join("\n");

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, expectedHelp);
  assert.equal(result.stderr, "");
});

test("unknown commands fail clearly on stderr with a nonzero exit", () => {
  const result = runCli("sync");

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    'Unknown command or option: sync\nRun "ega-skills --help" for usage.\n',
  );
});

test("the package bin wiring points at the subprocess entrypoint under test", () => {
  assert.equal(cliPackage.bin?.["ega-skills"], "./bin/ega-skills.mjs");
});

test("hub build is available through the real CLI entrypoint", () => {
  const hub = mkdtempSync(join(tmpdir(), "ega-cli-hub-"));
  mkdirSync(join(hub, "owned", "ega"), { recursive: true });
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: cli\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const result = runCli("hub", "build", hub);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.skills, []);
  assert.equal(output.release.object_type, "ega.hub-release");
  assert.equal(output.releasePackage.snapshot_rows, 0);
  for (const path of Object.values(output.artifactPaths)) assert.equal(existsSync(path), true, path);
  assert.deepEqual(JSON.parse(readFileSync(output.artifactPaths.release, "utf8")), output.release);
  assert.deepEqual(JSON.parse(readFileSync(output.artifactPaths.releasePackage, "utf8")), output.releasePackage);
  assert.equal(result.stderr, "");
});

test("hub flag values are not mistaken for positional hub paths", () => {
  const check = runCli("hub", "check", "--output", "plan.json");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /^Missing hub check <source-id>\./);

  const update = runCli("hub", "update", "--plan", "plan.json");
  assert.equal(update.status, 1);
  assert.match(update.stderr, /^ENOENT: no such file or directory/);
});

test("init-skill creates exactly the canonical two-file scaffold", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ega-cli-authoring-"));
  const result = runCliFrom(cwd, "init-skill", "new-skill");
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.created, true);
  assert.deepEqual(output.files, ["SKILL.md", "ega.yaml"]);
  assert.equal(existsSync(join(cwd, "new-skill", "SKILL.md")), true);
  assert.equal(existsSync(join(cwd, "new-skill", "ega.yaml")), true);
  assert.equal(existsSync(join(cwd, "new-skill", "SKILL.core.md")), false);
  assert.equal(result.stderr, "");
});

test("validate is non-mutating, uses the package validator, and reports JSON failures", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ega-cli-validate-"));
  const init = runCliFrom(cwd, "init-skill", "valid-skill");
  assert.equal(init.status, 0);
  const valid = runCliFrom(cwd, "validate", "valid-skill", "--json");
  assert.equal(valid.status, 0);
  assert.deepEqual(JSON.parse(valid.stdout), {
    checked: 1,
    failures: [],
    path: join(cwd, "valid-skill"),
    valid: true,
  });
  writeFileSync(join(cwd, "valid-skill", "SKILL.md"), "---\nname: wrong\ndescription: invalid\n---\n");
  const invalid = runCliFrom(cwd, "validate", "valid-skill", "--json");
  assert.equal(invalid.status, 1);
  const report = JSON.parse(invalid.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0].error, /directory|name/i);
  assert.equal(existsSync(join(cwd, ".ega-skills", "registry.sqlite")), false);
});
