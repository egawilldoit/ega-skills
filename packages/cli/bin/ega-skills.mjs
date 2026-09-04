#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

const args = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  ega-skills --help",
      "  ega-skills --version",
      "",
      "Options:",
      "  --help     Show this help.",
      "  --version  Show the installed version.",
      "",
    ].join("\n"),
  );
}

if (args.length === 1 && args[0] === "--help") {
  printHelp();
  process.exit(0);
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
} else {
  const token = args[0] ?? "";
  process.stderr.write(
    `Unknown command or option: ${token}\nRun "ega-skills --help" for usage.\n`,
  );
  process.exit(1);
}
