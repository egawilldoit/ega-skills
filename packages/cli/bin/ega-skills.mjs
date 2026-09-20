#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runImport, runImportPlan, runIntakeQuality, runInit, runInitSkill, runInspect, runList, runLock, runResolve, runValidate, runHubBuild, runHubValidate, runHubCheck, runHubUpdate, runHubIntakePlan, runHubIntakeStage, runHubIntakeApply, runHubIntakeDerive, runHubIntakeReview, runHubReleasePreflight, runHubReleasePreview, runHubReleaseExport, runHubCollectionsValidate, runRemoteLockPlan, runRemoteLockApply, runContextPublish } from "../dist/index.js";

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
      "  ega-skills import-plan <path> --namespace <namespace> --output <plan.json>",
      "  ega-skills intake quality <path> --namespace <namespace> --output <report.json>",
      "  ega-skills list",
      "  ega-skills inspect <skill-id>",
      "  ega-skills init [<project-dir>] [--force]",
      "  ega-skills validate <path> [--json]",
      "  ega-skills init-skill <name>",
      "  ega-skills lock [<project-dir>] [--refresh]",
      "  ega-skills resolve --project <path> --task \"<task>\" [--explicit <id>] [--max-skills 1-3] [--max-tokens 1-1000000]",
      "  ega-skills hub build [<hub-dir>]",
      "  ega-skills hub validate [<hub-dir>]",
      "  ega-skills hub check <source-id> [<hub-dir>] --output <plan.json>",
      "  ega-skills hub intake plan <repository-or-folder> --namespace <namespace> --source-id <id> --commit <sha> --root <path> --output <plan.json>",
      "  ega-skills hub intake stage --plan <plan.json> [<hub-dir>]",
      "  ega-skills hub intake apply (--plan <plan.json>|--candidate <candidate.json|digest>) [<hub-dir>]",
      "  ega-skills hub intake review --candidate <plan.json|digest> --decision <approve|reject> (--expected-revision <N>|--expected-revisions <json-file>) [<hub-dir>]",
      "  ega-skills hub intake derive --candidate <plan.json|digest> --patch <patch.json> --owned-id <namespace/name> [<hub-dir>]",
      "  ega-skills hub release preflight [<hub-dir>]",
      "  ega-skills hub release preview --hub <hub-dir> --against <release.json|artifact-dir> --output-dir <candidate-dir>",
      "  ega-skills hub release export --candidate <candidate.json> --out <artifact-dir> [--legacy]",
      "  ega-skills hub collections validate [<hub-dir>] [--hub <hub-dir>]",
      "  ega-skills remote-lock plan --project <project-dir> --release <sha256:release> --release-file <hub-release.json> --output <lock-plan.json>",
      "  ega-skills remote-lock apply --plan <lock-plan.json> [<project-dir>]",
      "  ega-skills context publish --workspace <id> --project-id <id> --release <hub-release.json> [<project-dir>] [--output <context.json>] [--fingerprint <digest>]",
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

function failWithCode(message, code) {
  process.stderr.write(`${message}\nRun "ega-skills --help" for usage.\n`);
  process.exitCode = code;
}

function readImportPlanArgs(rest) {
  const positional = [];
  let namespace;
  let output;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--namespace" || token === "--output") {
      const value = rest[i + 1];
      if (typeof value !== "string" || value.startsWith("--") || value.length === 0) {
        failWithCode(`Missing value for ${token}.`, 2);
        return null;
      }
      if (token === "--namespace") namespace = value;
      else output = value;
      i += 1;
    } else if (typeof token === "string" && token.startsWith("--namespace=")) {
      namespace = token.slice("--namespace=".length);
      if (namespace.length === 0) {
        failWithCode("Missing value for --namespace.", 2);
        return null;
      }
    } else if (typeof token === "string" && token.startsWith("--output=")) {
      output = token.slice("--output=".length);
      if (output.length === 0) {
        failWithCode("Missing value for --output.", 2);
        return null;
      }
    } else if (typeof token === "string" && token.startsWith("--")) {
      failWithCode(`Unknown command or option: ${token}`, 2);
      return null;
    } else {
      positional.push(token);
    }
  }
  if (positional.length !== 1) {
    failWithCode("Usage: ega-skills import-plan <path> --namespace <namespace> --output <plan.json>", 2);
    return null;
  }
  if (namespace === undefined) {
    failWithCode("Missing required --namespace <namespace>.", 2);
    return null;
  }
  if (output === undefined) {
    failWithCode("Missing required --output <plan.json>.", 2);
    return null;
  }
  return { path: positional[0], namespace, output };
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

  if (command === "import-plan") {
    const parsed = readImportPlanArgs(rest);
    if (parsed === null) return;
    try {
      const plan = await runImportPlan({
        sourcePath: parsed.path,
        namespace: parsed.namespace,
        output: parsed.output,
        env: process.env,
      });
      process.stdout.write(`${JSON.stringify({
        output: parsed.output,
        digest: plan.digest,
        ...plan.payload.summary,
      })}\n`);
      if (plan.payload.summary.blocked_count > 0) process.exitCode = 1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && error.code === "E_NAMESPACE_INVALID" ? 2 : 4;
      failWithCode(error instanceof Error ? error.message : String(error), code);
    }
    return;
  }

  if (command === "intake") {
    const [subcommand, ...intakeRest] = rest;
    if (subcommand !== "quality") fail(`Unknown intake command: ${subcommand ?? ""}`);
    const parsed = readImportPlanArgs(intakeRest);
    if (parsed === null) return;
    try {
      const report = await runIntakeQuality({ sourcePath: parsed.path, namespace: parsed.namespace, output: parsed.output });
      process.stdout.write(`${JSON.stringify({ output: parsed.output, digest: report.digest, ...report.payload.summary })}\n`);
      if (report.payload.summary.blocked_count > 0) process.exitCode = 1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && error.code === "E_NAMESPACE_INVALID" ? 2 : 4;
      failWithCode(error instanceof Error ? error.message : String(error), code);
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

  if (command === "validate") {
    const positional = rest.filter((token) => !token.startsWith("-"));
    const json = rest.includes("--json");
    const extra = rest.filter((token) => token !== "--json" && token !== positional[0]);
    if (positional.length === 0) fail("Missing validate <path>.");
    if (positional.length > 1 || extra.length > 0) fail(`Unknown command or option: ${extra[0] ?? positional[1]}`);
    try {
      const result = await runValidate({ path: positional[0] });
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`${result.valid ? "Valid" : "Invalid"}: ${result.checked} skill(s) checked\n`);
      if (!result.valid) process.exitCode = 1;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "init-skill") {
    if (rest.length !== 1 || rest[0].startsWith("-")) fail("Usage: ega-skills init-skill <name>");
    try {
      const result = await runInitSkill({ name: rest[0] });
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

  if (command === "hub") {
    const [subcommand, ...hubRest] = rest;
    if (subcommand === "intake") {
      const [intakeSubcommand, ...intakeRest] = hubRest;
      if (intakeSubcommand === "plan") {
        const positional = readHubPositionals(intakeRest, new Set(["namespace", "source-id", "commit", "ref", "root", "provenance-file", "hub", "output"]));
        const source = positional[0];
        const sourceId = readFlag(intakeRest, "source-id");
        const namespace = readFlag(intakeRest, "namespace");
        const commit = readFlag(intakeRest, "commit");
        const ref = readFlag(intakeRest, "ref");
        const hub = readFlag(intakeRest, "hub");
        const output = readFlag(intakeRest, "output");
        const roots = readRepeatableFlag(intakeRest, "root");
        const provenanceFiles = readRepeatableFlag(intakeRest, "provenance-file");
        if (source === undefined || positional.length > 1) fail("Usage: ega-skills hub intake plan <repository-or-folder> ...");
        if (sourceId === undefined) fail("Missing required --source-id <id>.");
        if (namespace === undefined) fail("Missing required --namespace <namespace>.");
        if (roots.length === 0 || roots.some((value) => typeof value !== "string" || value.length === 0)) fail("Missing required --root <path>.");
        if (output === undefined) fail("Missing required --output <plan.json>.");
        if (existsSync(source) === false && commit === undefined && ref === undefined) fail("Git intake requires --commit <sha> or --ref <ref>.");
        try {
          const plan = await runHubIntakePlan({ commit, hub, namespace, output, provenanceFiles, ref, roots, source, sourceId });
          process.stdout.write(`${JSON.stringify({ output, digest: plan.digest, status: plan.payload.status, ...plan.payload.import_plan.payload.summary })}\n`);
          if (plan.payload.status === "BLOCKED") process.exitCode = 1;
        } catch (error) {
          failWithCode(error instanceof Error ? error.message : String(error), 4);
        }
        return;
      }
      if (intakeSubcommand === "stage") {
        const plan = readFlag(intakeRest, "plan");
        const positional = readHubPositionals(intakeRest, new Set(["plan"]));
        if (plan === undefined) fail("Missing required --plan <plan.json>.");
        if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
        try {
          const result = await runHubIntakeStage({ plan, hub: positional[0] ?? "." });
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          failWithCode(error instanceof Error ? error.message : String(error), 4);
        }
        return;
      }
      if (intakeSubcommand === "apply") {
        const plan = readFlag(intakeRest, "plan");
        const candidate = readFlag(intakeRest, "candidate");
        const positional = readHubPositionals(intakeRest, new Set(["plan", "candidate"]));
        if ((plan === undefined) === (candidate === undefined)) fail("Provide exactly one of --plan <plan.json> or --candidate <candidate.json|digest>.");
        if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
        try {
          const result = await runHubIntakeApply({ plan, candidate, hub: positional[0] ?? "." });
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          failWithCode(error instanceof Error ? error.message : String(error), 4);
        }
        return;
      }
      if (intakeSubcommand === "derive") {
        const candidate = readFlag(intakeRest, "candidate");
        const patch = readFlag(intakeRest, "patch");
        const ownedId = readFlag(intakeRest, "owned-id");
        const positional = readHubPositionals(intakeRest, new Set(["candidate", "patch", "owned-id"]));
        if (candidate === undefined) fail("Missing required --candidate <plan.json|digest>.");
        if (patch === undefined) fail("Missing required --patch <patch.json>.");
        if (ownedId === undefined) fail("Missing required --owned-id <namespace/name>.");
        if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
        try {
          const result = await runHubIntakeDerive({ candidate, hub: positional[0] ?? ".", ownedId, patch });
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          failWithCode(error instanceof Error ? error.message : String(error), 4);
        }
        return;
      }
      if (intakeSubcommand === "review") {
        const candidate = readFlag(intakeRest, "candidate");
        const decision = readFlag(intakeRest, "decision");
        const expectedRevision = readFlag(intakeRest, "expected-revision");
        const expectedRevisionsPath = readFlag(intakeRest, "expected-revisions");
        const actor = readFlag(intakeRest, "actor");
        const reason = readFlag(intakeRest, "reason");
        const positional = readHubPositionals(intakeRest, new Set(["candidate", "decision", "expected-revision", "expected-revisions", "actor", "reason"]));
        if (candidate === undefined) fail("Missing required --candidate <plan.json|digest>.");
        if (decision !== "approve" && decision !== "reject") fail("Missing required --decision <approve|reject>.");
        if ((expectedRevision === undefined) === (expectedRevisionsPath === undefined)) fail("Provide exactly one of --expected-revision <N> or --expected-revisions <json-file>.");
        if (expectedRevision !== undefined && !/^[0-9]+$/.test(expectedRevision)) fail("Invalid --expected-revision <N>.");
        if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
        try {
          const expectedRevisions = expectedRevisionsPath === undefined ? undefined : JSON.parse(readFileSync(expectedRevisionsPath, "utf8"));
          const result = runHubIntakeReview({ actor, candidate, decision: decision === "approve" ? "APPROVED" : "REJECTED", ...(expectedRevision === undefined ? {} : { expectedRevision: Number(expectedRevision) }), ...(expectedRevisions === undefined ? {} : { expectedRevisions }), hub: positional[0] ?? ".", reason });
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failWithCode(message, message.includes("E_REVIEW_STALE") || message.includes("E_REVIEW_CONFLICT") ? 3 : 4);
        }
        return;
      }
      fail(`Unknown hub intake command: ${intakeSubcommand ?? ""}`);
    }
    if (subcommand === "release") {
      const [releaseSubcommand, ...releaseRest] = hubRest;
      if (releaseSubcommand === "preview") {
        const hubFlag = readFlag(releaseRest, "hub");
        const against = readFlag(releaseRest, "against");
        const outputDirectory = readFlag(releaseRest, "output-dir");
        const positional = readHubPositionals(releaseRest, new Set(["hub", "against", "output-dir"]));
        if (hubFlag === undefined) fail("Missing required --hub <hub-dir>.");
        if (against === undefined) fail("Missing required --against <release.json|artifact-dir>.");
        if (outputDirectory === undefined) fail("Missing required --output-dir <candidate-dir>.");
        if (positional.length > 0) fail(`Unknown command or option: ${positional[0]}`);
        try {
          const result = await runHubReleasePreview({ against, hub: hubFlag, outputDirectory });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          if (result.status === "BLOCKED") process.exitCode = 1;
        } catch (error) {
          failWithCode(error instanceof Error ? error.message : String(error), 4);
        }
        return;
      }
      if (releaseSubcommand === "export") {
        const legacy = releaseRest.includes("--legacy");
        const exportRest = releaseRest.filter((token) => token !== "--legacy");
        const candidate = readFlag(exportRest, "candidate");
        const outputDirectory = readFlag(exportRest, "out");
        const positional = readHubPositionals(exportRest, new Set(["candidate", "out"]));
        if (candidate === undefined) fail("Missing required --candidate <candidate.json>.");
        if (outputDirectory === undefined) fail("Missing required --out <artifact-dir>.");
        if (positional.length > 0) fail(`Unknown command or option: ${positional[0]}`);
        try {
          const result = runHubReleaseExport({ candidate, outputDirectory, ...(legacy ? { legacy: true } : {}) });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          failWithCode(error instanceof Error ? error.message : String(error), 4);
        }
        return;
      }
      if (releaseSubcommand !== "preflight") fail(`Unknown hub release command: ${releaseSubcommand ?? ""}`);
      if (releaseRest.length > 1 || releaseRest.some((token) => token.startsWith("-"))) fail(`Unknown command or option: ${releaseRest[1] ?? releaseRest[0]}`);
      try {
        const result = await runHubReleasePreflight({ hub: releaseRest[0] ?? "." });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.payload.status === "BLOCKED") process.exitCode = 1;
      } catch (error) {
        failWithCode(error instanceof Error ? error.message : String(error), 4);
      }
      return;
    }
    if (subcommand === "collections") {
      const [collectionsSubcommand, ...collectionsRest] = hubRest;
      if (collectionsSubcommand !== "validate") fail(`Unknown hub collections command: ${collectionsSubcommand ?? ""}`);
      const hubFlag = readFlag(collectionsRest, "hub");
      const positional = readHubPositionals(collectionsRest, new Set(["hub"]));
      if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
      if (hubFlag !== undefined && positional.length > 0) fail("Use either a positional Hub path or --hub, not both.");
      try {
        const result = await runHubCollectionsValidate({ hub: hubFlag ?? positional[0] ?? "." });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.payload.status === "BLOCKED") process.exitCode = 1;
      } catch (error) {
        failWithCode(error instanceof Error ? error.message : String(error), 4);
      }
      return;
    }
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
    if (subcommand === "validate") {
      if (hubRest.length > 1 || hubRest.some((token) => token.startsWith("-"))) {
        fail(`Unknown command or option: ${hubRest[1] ?? hubRest[0]}`);
      }
      try {
        const result = await runHubValidate({ hub: hubRest[0] ?? "." });
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
        const result = await runHubUpdate({ plan, hub: positional[0] ?? "." });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    fail(`Unknown hub command: ${subcommand ?? ""}`);
  }

  if (command === "remote-lock") {
    const [subcommand, ...lockRest] = rest;
    if (subcommand === "plan") {
      const project = readFlag(lockRest, "project");
      const release = readFlag(lockRest, "release");
      const releaseFile = readFlag(lockRest, "release-file");
      const output = readFlag(lockRest, "output");
      if (!project) fail("Missing required --project <project-dir>.");
      if (!release) fail("Missing required --release <sha256:release|hub-release.json>.");
      if (!output) fail("Missing required --output <lock-plan.json>.");
      try {
        const result = runRemoteLockPlan({ project, release, releaseFile, output });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (subcommand !== "apply") fail(`Unknown remote-lock command: ${subcommand ?? ""}`);
    const plan = readFlag(lockRest, "plan");
    const positional = readHubPositionals(lockRest, new Set(["plan"]));
    if (plan === undefined) fail("Missing required --plan <lock-plan.json>.");
    if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
    try {
      const result = await runRemoteLockApply({ plan, project: positional[0] ?? "." });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command === "context") {
    const [subcommand, ...contextRest] = rest;
    if (subcommand !== "publish") fail(`Unknown context command: ${subcommand ?? ""}`);
    const workspace = readFlag(contextRest, "workspace");
    const projectId = readFlag(contextRest, "project-id");
    const release = readFlag(contextRest, "release");
    const output = readFlag(contextRest, "output");
    const fingerprint = readFlag(contextRest, "fingerprint");
    if (!workspace) fail("Missing required --workspace <id>.");
    if (!projectId) fail("Missing required --project-id <id>.");
    if (!release) fail("Missing required --release <hub-release.json>.");
    const positional = readHubPositionals(contextRest, new Set(["workspace", "project-id", "release", "output", "fingerprint"]));
    if (positional.length > 1) fail(`Unknown command or option: ${positional[1]}`);
    try {
      const result = runContextPublish({ workspace, projectId, release, output, fingerprint, project: positional[0] ?? "." });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  fail(`Unknown command or option: ${command ?? ""}`);
}

await main();
