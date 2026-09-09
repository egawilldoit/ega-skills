import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRemoteLockPlan, digestProjectLock, hashNormalizedConfig, parseProjectConfig, serializeLockfile } from "../../packages/project/dist/index.js";

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

const digest = (hex) => `sha256:${hex.repeat(64 / hex.length)}`;

function testLock(version) {
  return {
    lockfile_version: 1,
    token_estimator: "ega-o200k-v1",
    generated_from: { config_hash: digest("a") },
    skills: { "ega/alpha": { name: "alpha", version_hash: digest(version) } },
  };
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
      "  ega-skills hub validate [<hub-dir>]",
      "  ega-skills hub check <source-id> [<hub-dir>] --output <plan.json>",
      "  ega-skills remote-lock plan --project <project-dir> --release <sha256:release> --release-file <hub-release.json> --output <lock-plan.json>",
      "  ega-skills remote-lock apply --plan <lock-plan.json> [<project-dir>]",
      "  ega-skills context publish --workspace <id> --project-id <id> --release <hub-release.json> [<project-dir>] [--output <context.json>] [--fingerprint <digest>]",
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

test("remote-lock apply is available through the real CLI entrypoint", () => {
  const project = mkdtempSync(join(tmpdir(), "ega-cli-project-"));
  const current = testLock("a");
  const candidate = testLock("b");
  const plan = createRemoteLockPlan({
    projectConfigDigest: digest("a"),
    existingLockDigest: digestProjectLock(current),
    targetReleaseDigest: digest("c"),
    current,
    candidate,
  });
  const planPath = join(project, "lock-plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  const result = runCli("remote-lock", "apply", "--plan", planPath, project);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    applied: true,
    path: join(project, ".egaskills.lock"),
    target_release_digest: digest("c"),
  });
  assert.match(readFileSync(join(project, ".egaskills.lock"), "utf8"), new RegExp(digest("b")));
});

test("remote-lock plan binds a local project to an exact HubRelease digest", () => {
  const project = mkdtempSync(join(tmpdir(), "ega-cli-lock-plan-"));
  const config = parseProjectConfig("schema_version: 1\n");
  writeFileSync(join(project, ".egaskills.yaml"), "schema_version: 1\n");
  writeFileSync(join(project, ".egaskills.lock"), serializeLockfile({
    lockfile_version: 1,
    token_estimator: "ega-o200k-v1",
    generated_from: { config_hash: hashNormalizedConfig(config) },
    skills: {},
  }));
  const hub = join(project, "hub");
  mkdirSync(join(hub, "owned", "ega"), { recursive: true });
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: lock-plan-hub\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const built = runCli("hub", "build", hub);
  assert.equal(built.status, 0);
  const release = JSON.parse(built.stdout).artifactPaths.release;
  const output = join(project, "lock-plan.json");
  const result = runCli("remote-lock", "plan", "--project", project, "--release", JSON.parse(readFileSync(release, "utf8")).digest, "--release-file", release, "--output", output);
  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.object_type, "ega.remote-lock-plan");
  assert.equal(plan.payload.target_release_digest, JSON.parse(readFileSync(release, "utf8")).digest);
  assert.deepEqual(plan.payload.candidate_lock.skills, {});
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), plan);
});

test("context publish creates an immutable artifact from validated local project files and a real HubRelease", () => {
  const project = mkdtempSync(join(tmpdir(), "ega-cli-context-"));
  writeFileSync(join(project, ".egaskills.yaml"), "schema_version: 1\n");
  const config = parseProjectConfig("schema_version: 1\n");
  const lock = { lockfile_version: 1, token_estimator: "ega-o200k-v1", generated_from: { config_hash: hashNormalizedConfig(config) }, skills: {} };
  writeFileSync(join(project, ".egaskills.lock"), serializeLockfile(lock));
  const hub = join(project, "hub");
  mkdirSync(join(hub, "owned", "ega"), { recursive: true });
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: context-hub\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const built = runCli("hub", "build", hub);
  assert.equal(built.status, 0, built.stderr);
  const releasePath = JSON.parse(built.stdout).artifactPaths.release;
  const output = join(project, "context.json");
  const result = runCli("context", "publish", "--workspace", "workspace-a", "--project-id", "project-a", "--release", releasePath, project, "--output", output);
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.equal(context.object_type, "ega.project-context");
  assert.equal(context.payload.workspace_id, "workspace-a");
  assert.equal(context.payload.project_id, "project-a");
  assert.equal(context.payload.release_digest, JSON.parse(readFileSync(releasePath, "utf8")).digest);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), context);
});

test("hub validate checks the adopted Hub without mutation", () => {
  const hub = mkdtempSync(join(tmpdir(), "ega-cli-hub-validate-"));
  mkdirSync(join(hub, "owned", "ega"), { recursive: true });
  writeFileSync(join(hub, "hub.yaml"), "schema_version: 1\nhub:\n  id: cli\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hub, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hub, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const result = runCli("hub", "validate", hub);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { hub, valid: true, skills: 0, sources: 0 });
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
  assert.match(report.failures[0].error, /must exactly match directory/);
  assert.equal(existsSync(join(cwd, ".ega-skills", "registry.sqlite")), false);
});

test("hub check --output writes a plan directly consumable by hub update --plan", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const {
    extractSelectedRoots,
    parseSourcesYaml,
    sourceConfigDigest,
  } = await import("../../packages/project/dist/index.js");

  const repo = mkdtempSync(join(tmpdir(), "ega-cli-upstream-"));
  const hub = mkdtempSync(join(tmpdir(), "ega-cli-update-hub-"));
  const tree = join(hub, "external", "upstream", "repo");

  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=cli-test",
        "-c",
        "user.email=cli-test@example.test",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();

  git("init", "-b", "main");

  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  writeFileSync(
    join(repo, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill.\n---\n\nVersion A.\n",
  );
  mkdirSync(join(repo, "skills", "beta"), { recursive: true });
  writeFileSync(
    join(repo, "skills", "beta", "SKILL.md"),
    "---\nname: beta\ndescription: Beta skill.\n---\n\nVersion B.\n",
  );
  writeFileSync(join(repo, "LICENSE"), "test license\n");
  git("add", ".");
  git("commit", "-m", "A");
  const commitA = git("rev-parse", "HEAD");

  mkdirSync(tree, { recursive: true });
  const adoptedA = extractSelectedRoots(
    repo,
    ["skills/alpha"],
    ["LICENSE"],
    tree,
  );

  writeFileSync(
    join(repo, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill.\n---\n\nVersion B.\n",
  );
  git("add", ".");
  git("commit", "-m", "B");
  const commitB = git("rev-parse", "HEAD");

  const repository = pathToFileURL(repo).href;
  const sourcesYaml = `schema_version: 1

sources:
  upstream:
    type: git
    repository: ${repository}
    ref: main
    namespace: upstream
    selection:
      roots:
        - skills/alpha
    provenance_files:
      - LICENSE
`;

  const parsed = parseSourcesYaml(sourcesYaml);
  const configDigest = sourceConfigDigest(parsed.sources.upstream);

  writeFileSync(
    join(hub, "hub.yaml"),
    `schema_version: 1

hub:
  id: cli-update

owned: []

external:
  - source: upstream
`,
  );

  writeFileSync(join(hub, "sources.yaml"), sourcesYaml);

  writeFileSync(
    join(hub, "sources.lock.yaml"),
    `schema_version: 1

sources:
  upstream:
    source_config_digest: ${configDigest}
    repository: ${repository}
    requested_ref: main
    namespace: upstream
    selection:
      roots:
        - skills/alpha
    provenance_files:
      - LICENSE
    resolved_commit: ${commitA}
    selected_skill_tree_digest: ${adoptedA.treeDigest}
    vendored_snapshot_digest: ${adoptedA.snapshotDigest}
    extraction_contract: 1
`,
  );

  const planFile = join(hub, "update-plan.json");

  const check = runCli(
    "hub",
    "check",
    "upstream",
    hub,
    "--output",
    planFile,
  );

  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, "UPDATE_AVAILABLE");

  const persistedPlan = JSON.parse(readFileSync(planFile, "utf8"));
  assert.equal(persistedPlan.object_type, "ega.update-plan");
  assert.equal(persistedPlan.payload.source_id, "upstream");
  assert.equal(persistedPlan.payload.target_commit, commitB);

  const update = runCli(
    "hub",
    "update",
    "--plan",
    planFile,
    hub,
  );

  assert.equal(update.status, 0, update.stderr);

  const lockAfter = readFileSync(join(hub, "sources.lock.yaml"), "utf8");
  assert.match(lockAfter, new RegExp(`resolved_commit: ${commitB}`));

  // A deliberate selection-intent change is proposed against the old lock;
  // it must not be mistaken for a corrupt adopted tree.
  writeFileSync(join(hub, "sources.yaml"), sourcesYaml.replace("- skills/alpha", "- skills"));
  const transitionPlanFile = join(hub, "selection-transition.json");
  const transition = runCli("hub", "check", "upstream", hub, "--output", transitionPlanFile);
  assert.equal(transition.status, 0, transition.stderr);
  const transitionPlan = JSON.parse(readFileSync(transitionPlanFile, "utf8"));
  assert.deepEqual(transitionPlan.payload.added_skills.map((entry) => entry.skill_ref), ["upstream/beta"]);
  const transitionApply = runCli("hub", "update", "--plan", transitionPlanFile, hub);
  assert.equal(transitionApply.status, 0, transitionApply.stderr);
  assert.match(readFileSync(join(hub, "sources.lock.yaml"), "utf8"), /- skills\n/);
});
