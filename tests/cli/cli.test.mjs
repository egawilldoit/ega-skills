import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

test("ega-skills --version prints the package version and exits cleanly", () => {
  const result = runCli("--version");

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, `${cliPackage.version}\n`);
  assert.equal(result.stderr, "");
});

test("ega-skills --help prints the Wave-3 CLI surface and exits cleanly", () => {
  const result = runCli("--help");
  const expectedHelp = [
    "Usage:",
    "  ega-skills --help",
    "  ega-skills --version",
    "  ega-skills import <path> --namespace <namespace>",
    "  ega-skills list",
    "  ega-skills inspect <skill-id>",
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
  const result = runCli("resolve");

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    'Unknown command or option: resolve\nRun "ega-skills --help" for usage.\n',
  );
});

test("the package bin wiring points at the subprocess entrypoint under test", () => {
  assert.equal(cliPackage.bin?.["ega-skills"], "./bin/ega-skills.mjs");
});
