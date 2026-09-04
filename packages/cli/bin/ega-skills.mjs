#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runImport, runInspect, runList } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

const args = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
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
    ].join("\n"),
  );
}

function fail(message) {
  process.stderr.write(`${message}\nRun "ega-skills --help" for usage.\n`);
  process.exit(1);
}

function readNamespace(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--namespace") {
      const value = rest[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        fail("Missing value for --namespace <namespace>.");
      }
      return value;
    }
    if (typeof token === "string" && token.startsWith("--namespace=")) {
      const value = token.slice("--namespace=".length);
      if (value.length === 0) {
        fail("Missing value for --namespace <namespace>.");
      }
      return value;
    }
  }
  return undefined;
}

async function main() {
  const [command, ...rest] = args;

  if (args.length === 1 && command === "--help") {
    printHelp();
    return;
  }
  if (args.length === 1 && command === "--version") {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (command === "import") {
    const target = rest.find((token) => !token.startsWith("--"));
    if (target === undefined) {
      fail("Missing import <path>.");
    }
    const namespace = readNamespace(rest);
    if (namespace === undefined) {
      fail("Missing required --namespace <namespace>.");
    }
    const extra = rest.filter((token) => token !== target && token !== "--namespace" && token !== namespace && !token.startsWith("--namespace="));
    if (extra.length > 0) {
      fail(`Unknown command or option: ${extra[0]}`);
    }
    try {
      const summary = await runImport(target, namespace, process.env);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "list") {
    if (rest.length > 0) {
      fail(`Unknown command or option: ${rest[0]}`);
    }
    try {
      const entries = await runList(process.env);
      for (const entry of entries) {
        process.stdout.write(`${entry.skillId} ${entry.currentVersionHash}\n`);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "inspect") {
    const [skillId, ...extra] = rest;
    if (skillId === undefined) {
      fail("Missing inspect <skill-id>.");
    }
    if (extra.length > 0) {
      fail(`Unknown command or option: ${extra[0]}`);
    }
    try {
      const result = await runInspect(skillId, process.env);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  fail(`Unknown command or option: ${command ?? ""}`);
}

await main();
