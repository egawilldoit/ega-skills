#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runImport, runInspect, runList, runResolve } from "../dist/index.js";

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
      "  ega-skills resolve --project <path> --task \"<task>\" [--explicit <id>] [--max-skills 1-3] [--max-tokens 1-1000000]",
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

function readFlag(rest, name) {
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === `--${name}`) {
      return rest[i + 1];
    }
    if (typeof token === "string" && token.startsWith(`--${name}=`)) {
      return token.slice(`--${name}=`.length);
    }
  }
  return undefined;
}

function readRepeatableFlag(rest, name) {
  const values = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === `--${name}`) {
      values.push(rest[i + 1]);
      i += 1;
    } else if (typeof token === "string" && token.startsWith(`--${name}=`)) {
      values.push(token.slice(`--${name}=`.length));
    }
  }
  return values;
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

  if (command === "resolve") {
    const project = readFlag(rest, "project") ?? ".";
    const task = readFlag(rest, "task");
    if (task === undefined || task.length === 0) {
      fail("Missing required --task \"<task>\".");
    }
    const explicit = readRepeatableFlag(rest, "explicit")
      .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const maxSkillsRaw = readFlag(rest, "max-skills");
    const maxTokensRaw = readFlag(rest, "max-tokens");
    const maxSkills = maxSkillsRaw === undefined ? undefined : Number(maxSkillsRaw);
    const maxTokens = maxTokensRaw === undefined ? undefined : Number(maxTokensRaw);
    if (maxSkillsRaw !== undefined && (!Number.isInteger(maxSkills) || maxSkills < 1 || maxSkills > 3)) {
      fail("--max-skills must be an integer in 1–3.");
    }
    if (maxTokensRaw !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1000000)) {
      fail("--max-tokens must be an integer in 1–1000000.");
    }
    const known = new Set(["--project", "--task", "--explicit", "--max-skills", "--max-tokens"]);
    const consumed = new Set();
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      const name = token.split("=")[0];
      if (!known.has(name)) continue;
      consumed.add(i);
      if (!token.includes("=") && i + 1 < rest.length) {
        consumed.add(i + 1);
        i += 1;
      }
    }
    for (let i = 0; i < rest.length; i += 1) {
      if (!consumed.has(i)) {
        fail(`Unknown command or option: ${rest[i]}`);
      }
    }
    try {
      const result = await runResolve({
        project,
        task,
        explicit,
        maxSkills,
        maxTokens,
        env: process.env,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  fail(`Unknown command or option: ${command ?? ""}`);
}

await main();
