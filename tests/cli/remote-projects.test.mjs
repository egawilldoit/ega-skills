import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { canonicalizeJson, createEnvelope, hashBytes } from "../../packages/hashing/dist/index.js";
import {
  hashNormalizedConfig,
  parseProjectConfig,
  serializeLockfile,
  createProjectContextStore,
  FileProjectContextPersistence,
  createContextControlPlaneHandler,
  verifyProjectContext,
} from "../../packages/project/dist/index.js";
import { runContextPublish } from "../../packages/cli/dist/index.js";

const root = join(import.meta.dirname, "..", "..");
const cli = join(root, "packages", "cli", "bin", "ega-skills.mjs");
const versionHash = `sha256:${"a".repeat(64)}`;
const roots = new Set();

test.after(() => {
  for (const rootPath of roots) rmSync(rootPath, { recursive: true, force: true });
});

function releaseDocument() {
  return createEnvelope({
    object_type: "ega.hub-release",
    schema_version: 1,
    payload: {
      hub_id: "personal",
      skill_versions: { "ega/alpha": versionHash },
      alias_map_digest: `sha256:${"b".repeat(64)}`,
      search_index_input_digest: `sha256:${"c".repeat(64)}`,
      token_artifact_digest: `sha256:${"d".repeat(64)}`,
      adopted_sources: [],
      contracts: {
        build_contract: "C1",
        hashing: 1,
        hub_contract: "A1",
        importer_build: 1,
        router: 1,
        schema: "v1.0.1",
        search: 1,
        token_estimator: "ega-o200k-v1",
        update_contract: "B1",
      },
      build: { fresh_registry: true, import_failures: 0, expected_catalog_match: true },
    },
  });
}

function runCli(project, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: "utf8",
  });
}

function setupProject() {
  const project = mkdtempSync(join(tmpdir(), "ega-remote-project-cli-"));
  writeFileSync(join(project, ".egaskills.yaml"), "schema_version: 1\nrouting:\n  max_skills: 2\n");
  const config = parseProjectConfig(readFileSync(join(project, ".egaskills.yaml"), "utf8"));
  const emptyLock = {
    lockfile_version: 1,
    token_estimator: "ega-o200k-v1",
    generated_from: { config_hash: hashNormalizedConfig(config) },
    skills: {},
  };
  writeFileSync(join(project, ".egaskills.lock"), serializeLockfile(emptyLock));
  const releasePath = join(project, "release.json");
  writeFileSync(releasePath, `${JSON.stringify(releaseDocument(), null, 2)}\n`);
  return { project, releasePath };
}

test("remote lock plan/apply and context publish preserve local authority boundaries", () => {
  const { project, releasePath } = setupProject();
  const configPath = join(project, ".egaskills.yaml");
  const lockPath = join(project, ".egaskills.lock");
  const configBefore = readFileSync(configPath);
  const lockBefore = readFileSync(lockPath);
  const planPath = join(project, "reviewed-plan.json");

  const planned = runCli(
    project,
    "remote-lock",
    "plan",
    "--release",
    releasePath,
    "--workspace-id",
    "workspace-a",
    "--project-id",
    "project-a",
    "--without-fingerprint",
    "--output",
    planPath,
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.added_entries, ["ega/alpha"]);
  assert.equal(plan.fingerprint_digest, null);
  assert.deepEqual(readFileSync(configPath), configBefore);
  assert.deepEqual(readFileSync(lockPath), lockBefore);

  const refused = runCli(project, "remote-lock", "apply", "--plan", planPath, "--release", releasePath);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /explicit approval/);
  assert.deepEqual(readFileSync(lockPath), lockBefore);

  const applied = runCli(project, "remote-lock", "apply", "--plan", planPath, "--release", releasePath, "--yes");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, true);
  const appliedLock = readFileSync(lockPath);
  assert.notDeepEqual(appliedLock, lockBefore);
  assert.deepEqual(readFileSync(configPath), configBefore);

  const published = runCli(
    project,
    "context",
    "publish",
    "--release",
    releasePath,
    "--workspace-id",
    "workspace-a",
    "--project-id",
    "project-a",
    "--context-id",
    "ctx-a",
    "--without-fingerprint",
  );
  assert.equal(published.status, 0, published.stderr);
  const result = JSON.parse(published.stdout);
  assert.equal(result.context_id, "ctx-a");
  assert.equal(result.context.fingerprint_digest, null);
  verifyProjectContext(result.context);
  assert.deepEqual(readFileSync(configPath), configBefore);
  assert.deepEqual(readFileSync(lockPath), appliedLock);
});

test("remote lock apply rejects a self-consistent candidate outside its target release", () => {
  const { project, releasePath } = setupProject();
  const planPath = join(project, "reviewed-plan.json");
  const planned = runCli(project, "remote-lock", "plan", "--release", releasePath, "--workspace-id", "workspace-a", "--project-id", "project-a", "--without-fingerprint", "--output", planPath);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const forged = {
    ...plan,
    candidate_lock: {
      ...plan.candidate_lock,
      skills: { "ega/alpha": { name: "alpha", version_hash: `sha256:${"b".repeat(64)}` } },
    },
  };
  const { plan_digest: _ignored, ...forgedArtifact } = forged;
  forged.plan_digest = hashBytes(canonicalizeJson(forgedArtifact));
  const forgedPath = join(project, "forged-plan.json");
  writeFileSync(forgedPath, `${JSON.stringify(forged)}\n`);
  const before = readFileSync(join(project, ".egaskills.lock"));
  const result = runCli(project, "remote-lock", "apply", "--plan", forgedPath, "--release", releasePath, "--yes");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not contained in HubRelease/);
  assert.deepEqual(readFileSync(join(project, ".egaskills.lock")), before);
});

test("remote lock apply rejects a self-consistent but false change summary", () => {
  const { project, releasePath } = setupProject();
  const planPath = join(project, "reviewed-plan.json");
  const planned = runCli(project, "remote-lock", "plan", "--release", releasePath, "--workspace-id", "workspace-a", "--project-id", "project-a", "--without-fingerprint", "--output", planPath);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const { plan_digest: _ignored, ...forgedArtifact } = { ...plan, added_entries: [] };
  const forged = { ...forgedArtifact, plan_digest: hashBytes(canonicalizeJson(forgedArtifact)) };
  const forgedPath = join(project, "false-summary-plan.json");
  writeFileSync(forgedPath, `${JSON.stringify(forged)}\n`);
  const before = readFileSync(join(project, ".egaskills.lock"));
  const result = runCli(project, "remote-lock", "apply", "--plan", forgedPath, "--release", releasePath, "--yes");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /changes do not match/);
  assert.deepEqual(readFileSync(join(project, ".egaskills.lock")), before);
});

test("context publish uses an authenticated local HTTP control plane and revocation", async () => {
  const { project, releasePath } = setupProject();
  const store = createProjectContextStore();
  const handler = createContextControlPlaneHandler({
    store,
    authenticate: (token) => token === "staging-token",
    authorize: ({ workspaceId, projectId }) => workspaceId === "workspace-a" && projectId === "project-a",
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const webRequest = new Request(`http://${request.headers.host}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: body.length === 0 ? undefined : body,
    });
    const webResponse = await handler(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const previousToken = process.env.EGA_TEST_CONTEXT_TOKEN;
  process.env.EGA_TEST_CONTEXT_TOKEN = "staging-token";
  try {
    const published = await runContextPublish({
      project,
      release: releasePath,
      workspaceId: "workspace-a",
      projectId: "project-a",
      contextId: "ctx-http",
      withoutFingerprint: true,
      controlPlane: endpoint,
      tokenEnv: "EGA_TEST_CONTEXT_TOKEN",
      env: process.env,
    });
    assert.equal(published.publication?.context_id, "ctx-http");
    assert.equal(store.get("ctx-http")?.revoked, false);
    const fetched = await fetch(`${endpoint}/v1/contexts/ctx-http`, { headers: { authorization: "Bearer staging-token" } });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).context.context_digest, published.context.context_digest);
    const revoked = await fetch(`${endpoint}/v1/contexts/ctx-http`, { method: "DELETE", headers: { authorization: "Bearer staging-token" } });
    assert.equal(revoked.status, 200);
    assert.equal(store.get("ctx-http")?.revoked, true);
  } finally {
    if (previousToken === undefined) delete process.env.EGA_TEST_CONTEXT_TOKEN;
    else process.env.EGA_TEST_CONTEXT_TOKEN = previousToken;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("context persistence survives control-plane process reconstruction", async () => {
  const { project, releasePath } = setupProject();
  const published = await runContextPublish({
    project,
    release: releasePath,
    workspaceId: "workspace-a",
    projectId: "project-a",
    contextId: "ctx-durable",
    withoutFingerprint: true,
  });
  const persistence = new FileProjectContextPersistence(join(project, "control-plane", "contexts.json"));
  const first = createProjectContextStore(persistence);
  first.publish({ contextId: published.context_id, context: published.context });
  const restored = createProjectContextStore(persistence);
  assert.equal(restored.get("ctx-durable")?.context.context_digest, published.context.context_digest);
  assert.equal(restored.get("ctx-durable")?.revoked, false);
  assert.throws(
    () => restored.publish({ contextId: published.context_id, context: published.context }),
    /already published/,
  );
  restored.revoke("ctx-durable");
  const restarted = createProjectContextStore(persistence);
  assert.equal(restarted.isRevoked("ctx-durable"), true);
});

test("context publication fingerprints package-scoped monorepo inputs without absolute paths", () => {
  const { project, releasePath } = setupProject();
  mkdirSync(join(project, "apps", "web"), { recursive: true });
  mkdirSync(join(project, "apps", "mobile"), { recursive: true });
  writeFileSync(join(project, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(join(project, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "1.0.0" } }));
  writeFileSync(join(project, "apps", "mobile", "package.json"), JSON.stringify({ name: "mobile", dependencies: { expo: "1.0.0" } }));

  const plan = runCli(
    project,
    "remote-lock",
    "plan",
    "--release",
    releasePath,
    "--workspace-id",
    "workspace-a",
    "--project-id",
    "project-web",
    "--project",
    join(project, "apps", "web"),
    "--repository-root",
    project,
  );
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout);
  assert.match(planned.fingerprint_digest, /^sha256:[0-9a-f]{64}$/);
  const mobilePlan = runCli(
    project,
    "remote-lock",
    "plan",
    "--release",
    releasePath,
    "--workspace-id",
    "workspace-a",
    "--project-id",
    "project-mobile",
    "--project",
    join(project, "apps", "mobile"),
    "--repository-root",
    project,
  );
  assert.equal(mobilePlan.status, 0, mobilePlan.stderr);
  assert.notEqual(planned.fingerprint_digest, JSON.parse(mobilePlan.stdout).fingerprint_digest);
});

test("real monorepo contexts distinguish root, packages, feature branch, and worktree", () => {
  const repository = mkdtempSync(join(tmpdir(), "ega-remote-monorepo-"));
  roots.add(repository);
  const worktree = `${repository}-worktree`;
  const releasePath = join(repository, "release.json");
  mkdirSync(join(repository, "apps", "web"), { recursive: true });
  mkdirSync(join(repository, "apps", "mobile"), { recursive: true });
  writeFileSync(join(repository, ".egaskills.yaml"), "schema_version: 1\nrouting:\n  max_skills: 2\n");
  const config = parseProjectConfig(readFileSync(join(repository, ".egaskills.yaml"), "utf8"));
  writeFileSync(join(repository, ".egaskills.lock"), serializeLockfile({
    lockfile_version: 1,
    token_estimator: "ega-o200k-v1",
    generated_from: { config_hash: hashNormalizedConfig(config) },
    skills: { "ega/alpha": { name: "alpha", version_hash: versionHash } },
  }));
  writeFileSync(join(repository, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "monorepo", workspaces: ["apps/*"] }));
  writeFileSync(join(repository, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "1.0.0", react: "1.0.0" } }));
  writeFileSync(join(repository, "apps", "mobile", "package.json"), JSON.stringify({ name: "mobile", dependencies: { expo: "1.0.0", "react-native": "1.0.0" } }));
  writeFileSync(releasePath, `${JSON.stringify(releaseDocument(), null, 2)}\n`);
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: "pipe" });
  git("init", "-q");
  git("branch", "-M", "main");
  git("config", "user.name", "EGA test");
  git("config", "user.email", "ega-test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "initial monorepo");

  const publish = (id, project, repo = repository) => {
    const result = runCli(
      repo,
      "context",
      "publish",
      "--release",
      releasePath,
      "--workspace-id",
      "workspace-mono",
      "--project-id",
      id,
      "--context-id",
      id,
      "--project",
      project,
      "--repository-root",
      repo,
    );
    assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(result.stdout);
    verifyProjectContext(published.context);
    return published;
  };

  const rootContext = publish("root", repository);
  const webContext = publish("web", join(repository, "apps", "web"));
  const mobileContext = publish("mobile", join(repository, "apps", "mobile"));
  assert.equal(rootContext.fingerprint.package_root, ".");
  assert.deepEqual(webContext.fingerprint.platforms, ["web"]);
  assert.deepEqual(mobileContext.fingerprint.platforms, ["mobile"]);
  assert.equal(webContext.fingerprint.workspace_root, ".");
  assert.equal(mobileContext.fingerprint.workspace_root, ".");
  assert.notEqual(webContext.context.fingerprint_digest, mobileContext.context.fingerprint_digest);
  assert.ok(webContext.fingerprint.evidence.every((record) => !record.path.startsWith("/")));

  git("switch", "-qc", "feature/mobile");
  writeFileSync(join(repository, "apps", "mobile", "package.json"), JSON.stringify({ name: "mobile", dependencies: { expo: "2.0.0", "react-native": "1.0.0" } }));
  git("add", "apps/mobile/package.json");
  git("commit", "-qm", "feature mobile inputs");
  const featureContext = publish("feature", join(repository, "apps", "mobile"));
  assert.equal(featureContext.fingerprint.revision.mode, "git-clean");
  assert.notEqual(featureContext.context.fingerprint_digest, mobileContext.context.fingerprint_digest);

  git("switch", "-q", "main");
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", "-b", "worktree-context", worktree, "main"], { stdio: "pipe" });
  writeFileSync(join(worktree, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "2.0.0", react: "1.0.0" } }));
  const worktreeContext = publish("worktree", join(worktree, "apps", "web"), worktree);
  assert.equal(worktreeContext.fingerprint.revision.mode, "git-dirty");
  assert.equal(worktreeContext.fingerprint.revision.base_commit_sha.length, 40);
  assert.notEqual(worktreeContext.context.fingerprint_digest, webContext.context.fingerprint_digest);

  const store = createProjectContextStore();
  for (const published of [rootContext, webContext, mobileContext, featureContext, worktreeContext]) {
    store.publish({ contextId: published.context_id, context: published.context });
  }
  assert.equal(store.list().length, 5);
  store.revoke("feature");
  assert.equal(store.get("feature")?.revoked, true);
  assert.equal(store.get("feature")?.context.context_digest, featureContext.context.context_digest);
  execFileSync("git", ["-C", repository, "worktree", "remove", "-f", worktree], { stdio: "pipe" });
});
