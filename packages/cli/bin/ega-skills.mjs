#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runImport, runInit, runInspect, runList, runLock, runRemoteLockApply, runRemoteLockPlan, runContextPublish, runResolve, runHubBuild, runHubCheck, runHubUpdate } from "../dist/index.js";

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
      "  ega-skills init [<project-dir>] [--force]",
      "  ega-skills lock [<project-dir>] [--refresh]",
      "  ega-skills remote-lock plan --release <release.json> --workspace-id <id> --project-id <id> [--output <plan.json>]",
      "  ega-skills remote-lock apply --plan <plan.json> --yes [--project <project-dir>]",
      "  ega-skills context publish --release <release.json> --workspace-id <id> --project-id <id> [--project <project-dir>]",
      "  ega-skills resolve --project <path> --task \"<task>\" [--explicit <id>] [--max-skills 1-3] [--max-tokens 1-1000000]",
      "  ega-skills hub build [<hub-dir>]",
      "  ega-skills hub check <source-id> [<hub-dir>] --output <plan.json>",
      "  ega-skills hub update --plan <plan.json> [<hub-dir>]",
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

function readHubPositionals(rest, valueFlags) {
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = token.slice(2, equals === -1 ? undefined : equals);
      if (!valueFlags.has(name)) fail(`Unknown command or option: ${token}`);
      if (equals === -1) {
        const value = rest[i + 1];
        if (typeof value !== "string" || value.startsWith("--")) {
          fail(`Missing value for --${name}.`);
        }
        i += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return positional;
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

  if (command === "init") {
    let force = false;
    const positional = [];
    for (const token of rest) {
      if (token === "--force") {
        force = true;
      } else if (typeof token === "string" && token.startsWith("-")) {
        fail(`Unknown command or option: ${token}`);
      } else {
        positional.push(token);
      }
    }
    if (positional.length > 1) {
      fail(`Unknown command or option: ${positional[1]}`);
    }
    try {
      const result = await runInit({ project: positional[0] ?? ".", force });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "lock") {
    let refresh = false;
    const positional = [];
    for (const token of rest) {
      if (token === "--refresh") {
        refresh = true;
      } else if (typeof token === "string" && token.startsWith("-")) {
        fail(`Unknown command or option: ${token}`);
      } else {
        positional.push(token);
      }
    }
    if (positional.length > 1) {
      fail(`Unknown command or option: ${positional[1]}`);
    }
    try {
      const result = await runLock({
        project: positional[0] ?? ".",
        refresh,
        env: process.env,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
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

  if (command === "remote-lock") {
    const [subcommand, ...remoteRest] = rest;
    if (subcommand !== "apply" && subcommand !== "plan") fail(`Unknown remote-lock command: ${subcommand ?? ""}`);
    if (subcommand === "plan") {
      let release;
      let workspaceId;
      let projectId;
      let project = ".";
      let repositoryRoot;
      let output;
      let withoutFingerprint = false;
      for (let i = 0; i < remoteRest.length; i += 1) {
        const token = remoteRest[i];
        if (token === "--without-fingerprint") {
          withoutFingerprint = true;
        } else if (token === "--release" || token === "--workspace-id" || token === "--project-id" || token === "--project" || token === "--repository-root" || token === "--output") {
          const value = remoteRest[++i];
          if (typeof value !== "string" || value.startsWith("--")) fail(`Missing value for ${token}.`);
          if (token === "--release") release = value;
          else if (token === "--workspace-id") workspaceId = value;
          else if (token === "--project-id") projectId = value;
          else if (token === "--project") project = value;
          else if (token === "--repository-root") repositoryRoot = value;
          else output = value;
        } else {
          fail(`Unknown command or option: ${token}`);
        }
      }
      if (release === undefined || workspaceId === undefined || projectId === undefined) fail("remote-lock plan requires --release, --workspace-id, and --project-id.");
      try {
        const result = runRemoteLockPlan({ release, workspaceId, projectId, project, repositoryRoot, output, withoutFingerprint });
        process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    let plan;
    let project = ".";
    let approve = false;
    for (let i = 0; i < remoteRest.length; i += 1) {
      const token = remoteRest[i];
      if (token === "--yes") {
        approve = true;
      } else if (token === "--plan") {
        plan = remoteRest[++i];
        if (typeof plan !== "string" || plan.startsWith("--")) fail("Missing value for --plan <plan.json>.");
      } else if (token === "--project") {
        project = remoteRest[++i];
        if (typeof project !== "string" || project.startsWith("--")) fail("Missing value for --project <project-dir>.");
      } else {
        fail(`Unknown command or option: ${token}`);
      }
    }
    if (plan === undefined) fail("Missing required --plan <plan.json>.");
    try {
      const result = runRemoteLockApply({ project, plan, approve });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "context") {
    const [subcommand, ...contextRest] = rest;
    if (subcommand !== "publish") fail(`Unknown context command: ${subcommand ?? ""}`);
    let release;
    let workspaceId;
    let projectId;
    let contextId;
    let project = ".";
    let repositoryRoot;
    let withoutFingerprint = false;
    for (let i = 0; i < contextRest.length; i += 1) {
      const token = contextRest[i];
      if (token === "--without-fingerprint") {
        withoutFingerprint = true;
      } else if (token === "--release" || token === "--workspace-id" || token === "--project-id" || token === "--context-id" || token === "--project" || token === "--repository-root") {
        const value = contextRest[++i];
        if (typeof value !== "string" || value.startsWith("--")) fail(`Missing value for ${token}.`);
        if (token === "--release") release = value;
        else if (token === "--workspace-id") workspaceId = value;
        else if (token === "--project-id") projectId = value;
        else if (token === "--context-id") contextId = value;
        else if (token === "--project") project = value;
        else repositoryRoot = value;
      } else {
        fail(`Unknown command or option: ${token}`);
      }
    }
    if (release === undefined || workspaceId === undefined || projectId === undefined) fail("context publish requires --release, --workspace-id, and --project-id.");
    try {
      const result = runContextPublish({ release, workspaceId, projectId, contextId, project, repositoryRoot, withoutFingerprint });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "hub") {
    const [subcommand, ...hubRest] = rest;
    if (subcommand === "build") {
      if (hubRest.length > 1 || hubRest.some((token) => token.startsWith("-"))) {
        fail(`Unknown command or option: ${hubRest[1] ?? hubRest[0]}`);
      }
      try {
        const result = await runHubBuild({ hub: hubRest[0] ?? "." });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (subcommand === "check") {
      const output = readFlag(hubRest, "output");
      const positional = readHubPositionals(hubRest, new Set(["output"]));
      const [sourceId, hub] = positional;
      if (sourceId === undefined) fail("Missing hub check <source-id>.");
      if (output === undefined) fail("Missing required --output <plan.json>.");
      if (positional.length > 2) fail(`Unknown command or option: ${positional[2]}`);
      try {
        const result = await runHubCheck({ sourceId, output, hub: hub ?? "." });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (subcommand === "update") {
      const plan = readFlag(hubRest, "plan");
      const positional = readHubPositionals(hubRest, new Set(["plan"]));
      if (plan === undefined) fail("Missing required --plan <plan.json>.");
      if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
      try {
        const result = runHubUpdate({ plan, hub: positional[0] ?? "." });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    fail(`Unknown hub command: ${subcommand ?? ""}`);
  }

  fail(`Unknown command or option: ${command ?? ""}`);
}

await main();
