import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assessBaselineMigration,
  createBaselineMigrationAuthorization,
  verifyBaselineMigrationReceipt,
} from "../../packages/project/dist/index.js";
import {
  acquirePublicationLease,
  artifactTreeDigest,
  createBaselineDeployWorktree,
  executeBaselineMigration,
  executeBaselineReconcile,
  persistFailedReceipt,
  probeLegacyReady,
  readBaselineSources,
  readRuntimeGitConfig,
  removeBaselineDeployWorktree,
  VercelApi,
  verifyBaselineArtifactBindings,
  verifyBaselineDelta,
  verifyBaselineRuntimeFiles,
  verifyBaselineSourceReachability,
  verifyApprovedSourceCommit,
  verifyBaselineStaging,
  verifyBaselineWorktree,
} from "../../scripts/hosted/publish-production.mjs";

const BASELINE = "sha256:3c08da9b48f179697b290513be69fe642bf6bb88b6e8c1d5f31d63575f089297";
const BASELINE_CANDIDATE = "sha256:5c441c3f0d7f5acf0cbdf005e6b4db8d05105783c38f37b4939b3b0ae54a45bc";
const BASELINE_TREE = "sha256:ad9f0cfa1c68a1531c964d921dfc4e6acf94357447517138aa7d69187f88276a";
const CANDIDATE_RELEASE = "sha256:08b12c28b66a9705fbaf523131867046d9d0b47bafe42a8564daab58a7ed0266";
const CURRENT_TREE = "sha256:08e086198728b8eeb2dd4dfa8284c0b08ec109f16f4702c724d773a34b3fc13a";
const CONFIG_DIGEST = "sha256:" + "9".repeat(64);
const PREDECESSOR = "dpl_MGiFbFtwcibpc9wY7BiK7gXkH3zH";
const STAGED = "dpl_baseline12345678";
const OTHER = "dpl_other12345678";
const TEAM = "team_e2x4kf12yL43qmBIs2t2YaD2";
const PROJECT = "prj_64LVYA9KOYL9sA2ONRNBzJmt9WAG";
const PUBLISHER = "Dc0U1Ov3Zh5zeFKeic10bVWj";
const ALIAS = "ega-skills-mcp.vercel.app";
const PRE_COMMIT = "a".repeat(40);
const MIGRATION_COMMIT = "b".repeat(40);
const REVIEWED_COMMIT = MIGRATION_COMMIT;
const NOW = Date.parse("2026-10-27T13:00:00.000Z");

function authorizationPayload(overrides = {}) {
  return {
    approval_record: "https://github.com/egawilldoit/ega-skills/issues/168#issuecomment-6471216248",
    approved_at: "2026-10-27T12:00:00.000Z",
    approved_by: "owner",
    baseline_artifact_tree_digest: BASELINE_TREE,
    baseline_candidate_digest: BASELINE_CANDIDATE,
    baseline_release_digest: BASELINE,
    candidate_artifact_tree_digest: CURRENT_TREE,
    candidate_release_digest: CANDIDATE_RELEASE,
    runtime_vercel_config_digest: CONFIG_DIGEST,
    canonical_alias: ALIAS,
    hub_id: "personal",
    legacy_deployment_checks: "succeeded",
    migration_source_commit: MIGRATION_COMMIT,
    predecessor_deployment_id: PREDECESSOR,
    predecessor_source_commit: PRE_COMMIT,
    production_branch: "main",
    publisher: { owner_subject: "owner", project_id: PROJECT, team_id: TEAM, vercel_user_id: PUBLISHER },
    reviewed_runtime_commit: REVIEWED_COMMIT,
    scope: "runtime-readiness-only",
    ...overrides,
  };
}

function authorization(overrides = {}) {
  return createBaselineMigrationAuthorization(authorizationPayload(overrides));
}

const expected = {
  baseline_candidate_digest: BASELINE_CANDIDATE,
  baseline_artifact_tree_digest: BASELINE_TREE,
  candidate_artifact_tree_digest: CURRENT_TREE,
  candidate_release_digest: CANDIDATE_RELEASE,
  runtime_source_commit: MIGRATION_COMMIT,
  runtime_vercel_config_digest: CONFIG_DIGEST,
  canonical_alias: ALIAS,
  legacy_deployment_checks: "succeeded",
  max_approval_age_ms: 24 * 60 * 60 * 1000,
  migration_source_commit: MIGRATION_COMMIT,
  now: "2026-10-27T13:00:00.000Z",
  predecessor_deployment_id: PREDECESSOR,
  predecessor_release_digest: BASELINE,
  predecessor_source_commit: PRE_COMMIT,
  production_branch: "main",
  project_id: PROJECT,
  publisher_vercel_user_id: PUBLISHER,
  reviewed_runtime_commit: REVIEWED_COMMIT,
  staged_deployment_id: STAGED,
  team_id: TEAM,
};

function observation(overrides = {}) {
  return {
    alias_target_deployment_id: PREDECESSOR,
    canonical_alias: ALIAS,
    deployment_checks_state: "succeeded",
    deployment_ready_state: "READY",
    deployment_source_commit: PRE_COMMIT,
    deployment_source_ref: "release/2.0",
    git_production_auto_deploy: false,
    legacy_readyz: "legacy",
    production_aliases: [ALIAS],
    production_branch: "main",
    project_id: PROJECT,
    project_name: "ega-skills-mcp",
    served_deployment_id: PREDECESSOR,
    team_id: TEAM,
    ...overrides,
  };
}

function assess({ auth = authorization(), obs = observation(), expect = expected } = {}) {
  return assessBaselineMigration({ authorization: auth, expected: expect, observation: obs });
}

test("the exact authorized baseline migration is READY only for the legacy readiness shape", () => {
  const ready = assess();
  assert.equal(ready.status, "READY", JSON.stringify(ready.blockers));
  assert.equal(ready.release_digest, BASELINE);
  assert.equal(ready.artifact_tree_digest, BASELINE_TREE);

  for (const shape of ["unavailable", "digest"]) {
    const result = assess({ obs: observation({ legacy_readyz: shape, ...(shape === "digest" ? { served_release_digest: BASELINE } : {}) }) });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.some((blocker) => blocker.code === "E_BASELINE_LEGACY_STATE"));
  }
});

test("a pre-check legacy deployment is accepted only with explicit absent-accepted authorization", () => {
  const auth = authorization({ legacy_deployment_checks: "absent-accepted" });
  const absent = observation({ deployment_checks_state: "none" });
  const expect = { ...expected, legacy_deployment_checks: "absent-accepted" };
  assert.equal(assessBaselineMigration({ authorization: auth, expected: expect, observation: absent }).status, "READY");
  for (const checks of ["failed", "pending", "succeeded"]) {
    const result = assessBaselineMigration({ authorization: auth, expected: expect, observation: observation({ deployment_checks_state: checks }) });
    assert.ok(result.blockers.some((blocker) => blocker.code === "E_BASELINE_CHECKS_NOT_PASSED"), checks);
  }
  const strict = assessBaselineMigration({ authorization: authorization(), expected, observation: absent });
  assert.ok(strict.blockers.some((blocker) => blocker.code === "E_BASELINE_CHECKS_NOT_PASSED"));
});

test("runtime config evidence disables auto-deploy only when commit and digest match", () => {
  const config = { config_digest: CONFIG_DIGEST, deployment_enabled: false, kind: "runtime-config", source_commit: MIGRATION_COMMIT };
  const disabled = observation({ git_auto_deploy_control: config, git_production_auto_deploy: true });
  assert.equal(assessBaselineMigration({ authorization: authorization(), expected, observation: disabled }).status, "READY");
  for (const control of [
    { ...config, config_digest: "sha256:" + "8".repeat(64) },
    { ...config, source_commit: "c".repeat(40) },
    { ...config, deployment_enabled: true },
    { ...config, kind: "ignored-build-step" },
  ]) {
    const result = assessBaselineMigration({ authorization: authorization(), expected, observation: observation({ git_auto_deploy_control: control, git_production_auto_deploy: true }) });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.some((blocker) => blocker.code === "E_BASELINE_PLATFORM_GUARD"));
  }
});

test("missing, substituted and stale predecessor evidence is refused", () => {
  const cases = [
    [{ alias_target_deployment_id: OTHER }, "E_BASELINE_PREDECESSOR_MISMATCH"],
    [{ deployment_source_commit: "c".repeat(40) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ deployment_source_commit: "" }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ deployment_ready_state: "ERROR" }, "E_BASELINE_DEPLOYMENT_NOT_READY"],
    [{ deployment_checks_state: "failed" }, "E_BASELINE_CHECKS_NOT_PASSED"],
    [{ deployment_checks_state: "none" }, "E_BASELINE_CHECKS_NOT_PASSED"],
    [{ git_production_auto_deploy: true }, "E_BASELINE_PLATFORM_GUARD"],
    [{ production_aliases: [ALIAS, "extra.vercel.app"] }, "E_BASELINE_PLATFORM_GUARD"],
    [{ canonical_alias: "other.vercel.app" }, "E_BASELINE_PLATFORM_GUARD"],
    [{ team_id: "team_other" }, "E_BASELINE_IDENTITY_MISMATCH"],
    [{ project_id: "prj_other" }, "E_BASELINE_IDENTITY_MISMATCH"],
    [{ production_branch: "release/2.0" }, "E_BASELINE_IDENTITY_MISMATCH"],
    [{ served_deployment_id: OTHER }, "E_BASELINE_PREDECESSOR_MISMATCH"],
    [{ legacy_readyz: undefined }, "E_BASELINE_LEGACY_STATE"],
    [{ legacy_readyz: "unknown" }, "E_BASELINE_LEGACY_STATE"],
    [{ git_production_auto_deploy: undefined }, "E_BASELINE_PLATFORM_GUARD"],
    [{ production_aliases: undefined }, "E_BASELINE_PLATFORM_GUARD"],
  ];
  for (const [change, code] of cases) {
    const result = assess({ obs: observation(change) });
    assert.equal(result.status, "BLOCKED", JSON.stringify(change));
    assert.ok(result.blockers.some((blocker) => blocker.code === code), `${JSON.stringify(change)} -> ${JSON.stringify(result.blockers)}`);
  }

  const stale = assess({ expect: { ...expected, now: "2026-10-28T13:00:00.000Z" } });
  assert.equal(stale.status, "BLOCKED");
  assert.ok(stale.blockers.some((blocker) => blocker.code === "E_BASELINE_AUTHORIZATION_STALE"));
});

test("authorization must bind the exact candidate, artifact tree, commits, publisher and alias", () => {
  const cases = [
    [{ baseline_candidate_digest: "sha256:" + "1".repeat(64) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ baseline_artifact_tree_digest: "sha256:" + "2".repeat(64) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ candidate_artifact_tree_digest: "sha256:" + "4".repeat(64) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ candidate_release_digest: "sha256:" + "5".repeat(64) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ predecessor_source_commit: "c".repeat(40) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ reviewed_runtime_commit: "e".repeat(40) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ migration_source_commit: "f".repeat(40) }, "E_BASELINE_SOURCE_MISMATCH"],
    [{ legacy_deployment_checks: "absent-accepted" }, "E_BASELINE_CHECKS_NOT_PASSED"],
    [{ predecessor_deployment_id: OTHER }, "E_BASELINE_PREDECESSOR_MISMATCH"],
    [{ baseline_release_digest: "sha256:" + "3".repeat(64) }, "E_BASELINE_PREDECESSOR_MISMATCH"],
    [{ canonical_alias: "other.vercel.app" }, "E_BASELINE_IDENTITY_MISMATCH"],
    [{ production_branch: "release/2.0" }, "E_BASELINE_IDENTITY_MISMATCH"],
  ];
  for (const [change, code] of cases) {
    const result = assess({ auth: authorization(change) });
    assert.equal(result.status, "BLOCKED", JSON.stringify(change));
    assert.ok(result.blockers.some((blocker) => blocker.code === code), `${JSON.stringify(change)} -> ${JSON.stringify(result.blockers)}`);
  }

  const wrongPublisher = authorization({
    publisher: { owner_subject: "owner", project_id: PROJECT, team_id: TEAM, vercel_user_id: "user_other" },
  });
  const result = assess({ auth: wrongPublisher });
  assert.ok(result.blockers.some((blocker) => blocker.code === "E_BASELINE_IDENTITY_MISMATCH"));
});

test("a tampered or extended authorization envelope is refused", () => {
  const auth = authorization();
  for (const candidate of [
    { ...auth, digest: "sha256:" + "0".repeat(64) },
    { ...auth, extra: true },
    { ...auth, schema_version: 1 },
    { ...auth, payload: { ...auth.payload, scope: "release-change" } },
    { ...auth, payload: { ...auth.payload, approval_record: "https://example.com/approval" } },
  ]) {
    const result = assess({ auth: candidate });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.some((blocker) => blocker.code === "E_BASELINE_AUTHORIZATION_INVALID"), JSON.stringify(result.blockers));
  }
});

test("the artifact tree digest reproduces the runbook's sorted sha256sum form", () => {
  const root = mkdtempSync(join(tmpdir(), "ega-baseline-tree-"));
  mkdirSync(join(root, "artifact", "sub"), { recursive: true });
  writeFileSync(join(root, "artifact", "b.txt"), "b\n");
  writeFileSync(join(root, "artifact", "sub", "a.txt"), "a\n");
  const digest = artifactTreeDigest(root, "artifact");
  const lines = [
    `${createHash("sha256").update("b\n").digest("hex")}  artifact/b.txt`,
    `${createHash("sha256").update("a\n").digest("hex")}  artifact/sub/a.txt`,
  ].sort((left, right) => Buffer.compare(Buffer.from(left.slice(66)), Buffer.from(right.slice(66))));
  assert.equal(digest, `sha256:${createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex")}`);
  rmSync(root, { recursive: true, force: true });
});

test("the committed artifact tree digest is stable", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  assert.equal(artifactTreeDigest(root, "packages/mcp/artifact"), CURRENT_TREE);
});

test("artifact trees reject escaping paths and symlinks", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "ega-baseline-symlink-"));
  mkdirSync(join(root, "artifact"), { recursive: true });
  writeFileSync(join(root, "artifact", "file.txt"), "bytes\n");
  symlinkSync(join(root, "artifact", "file.txt"), join(root, "artifact", "link.txt"));
  assert.throws(() => artifactTreeDigest(root, "artifact"), { code: "E_BASELINE_SOURCE_MISMATCH" });
  assert.throws(() => artifactTreeDigest(root, "../escape"), { code: "E_BASELINE_SOURCE_MISMATCH" });
  rmSync(root, { recursive: true, force: true });
});

test("the legacy readiness probe classifies but never invents a digest", async () => {
  const legacy = await probeLegacyReady(`https://${ALIAS}`, {
    fetch: async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
  });
  assert.deepEqual(legacy, { shape: "legacy" });

  const digest = await probeLegacyReady(`https://${ALIAS}`, {
    fetch: async () => new Response(JSON.stringify({ release_digest: BASELINE, status: "ready" }), { status: 200 }),
  });
  assert.deepEqual(digest, { release_digest: BASELINE, shape: "digest" });

  for (const response of [
    new Response("{}", { status: 503 }),
    new Response("not json", { status: 200 }),
    new Response(JSON.stringify({ status: "unavailable" }), { status: 200 }),
    new Response(JSON.stringify({ release_digest: 123, status: "ready" }), { status: 200 }),
    new Response(JSON.stringify({ release_digest: "not-a-digest", status: "ready" }), { status: 200 }),
  ]) {
    assert.deepEqual(await probeLegacyReady(`https://${ALIAS}`, { fetch: async () => response.clone() }), { shape: "unavailable" });
  }
  assert.deepEqual(await probeLegacyReady(`https://${ALIAS}`, { fetch: async () => { throw new Error("offline"); } }), { shape: "unavailable" });
  await assert.rejects(probeLegacyReady("http://example.com", { fetch: async () => new Response("{}") }), { code: "E_PROBE_URL" });
});

function mockVercel({ aliasSequence, deploymentOverrides = {}, inventory, legacy = { shape: "legacy" } } = {}) {
  let aliasReads = 0;
  const deployment = {
    checksConclusion: "succeeded",
    checksState: "completed",
    id: PREDECESSOR,
    meta: { githubCommitRef: "release/2.0", githubCommitSha: PRE_COMMIT },
    projectId: PROJECT,
    readyState: "READY",
    target: "production",
    ...deploymentOverrides,
  };
  return new VercelApi({
    token: "test-only",
    teamId: TEAM,
    fetch: async (url) => {
      let body;
      if (url.pathname === "/v2/user") body = { user: { id: PUBLISHER } };
      else if (url.pathname.startsWith("/v9/projects/")) body = { accountId: TEAM, git: { deploymentEnabled: false, productionBranch: "main" }, id: PROJECT, name: "ega-skills-mcp" };
      else if (url.pathname.startsWith("/v4/aliases/")) {
        aliasReads += 1;
        const alias = decodeURIComponent(url.pathname.slice("/v4/aliases/".length));
        body = aliasSequence?.(aliasReads, alias) ?? { alias, deploymentId: PREDECESSOR, projectId: PROJECT };
      } else if (url.pathname.endsWith("/aliases")) body = inventory ?? { aliases: [{ alias: ALIAS, deploymentId: PREDECESSOR }] };
      else if (url.pathname.startsWith("/v13/deployments/")) body = deployment;
      else throw new Error(`Unexpected API path ${url.pathname}`);
      return new Response(JSON.stringify(body), { status: 200 });
    },
  }).readBaseline({ ...expected, predecessor_deployment_id: PREDECESSOR, predecessor_release_digest: BASELINE }, async () => legacy);
}

test("the platform mapping binds the legacy deployment, its source commit and the legacy readiness shape", async () => {
  const observed = await mockVercel();
  assert.equal(observed.alias_target_deployment_id, PREDECESSOR);
  assert.equal(observed.served_deployment_id, PREDECESSOR);
  assert.equal(observed.deployment_source_commit, PRE_COMMIT);
  assert.equal(observed.legacy_readyz, "legacy");
  assert.equal(observed.served_release_digest, undefined);
  assert.equal(observed.deployment_checks_state, "succeeded");
  assert.deepEqual(observed.production_aliases, [ALIAS]);
  assert.equal(assessBaselineMigration({ authorization: authorization(), expected, observation: observed }).status, "READY");

  const missingCommit = await mockVercel({ deploymentOverrides: { meta: {} } });
  assert.equal(missingCommit.deployment_source_commit, "");
  const blocked = assessBaselineMigration({ authorization: authorization(), expected, observation: missingCommit });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.some((blocker) => blocker.code === "E_BASELINE_SOURCE_MISMATCH"));

  const digestShape = await mockVercel({ legacy: { release_digest: BASELINE, shape: "digest" } });
  assert.equal(digestShape.served_release_digest, BASELINE);
  assert.equal(assessBaselineMigration({ authorization: authorization(), expected, observation: digestShape }).blockers.some((blocker) => blocker.code === "E_BASELINE_LEGACY_STATE"), true);
});

test("the platform mapping refuses alias movement, foreign targets and incomplete inventories", async () => {
  await assert.rejects(
    () => mockVercel({ aliasSequence: (read) => ({ alias: ALIAS, deploymentId: read === 1 ? PREDECESSOR : OTHER, projectId: PROJECT }) }),
    { code: "E_ALIAS_DRIFT" },
  );
  for (const alias of [
    { alias: ALIAS, deploymentId: PREDECESSOR, projectId: "prj_other" },
    { alias: "other.example", deploymentId: PREDECESSOR, projectId: PROJECT },
    { alias: ALIAS, deploymentId: PREDECESSOR, projectId: PROJECT, redirect: "other.example" },
  ]) {
    await assert.rejects(() => mockVercel({ aliasSequence: () => alias }), { code: "E_ALIAS_DRIFT" });
  }
  for (const inventory of [{}, { aliases: [], pagination: { next: 1 } }, { aliases: [{ alias: ALIAS, deploymentId: OTHER }] }]) {
    await assert.rejects(() => mockVercel({ inventory }), { code: "E_PLATFORM_GUARD" });
  }
  await assert.rejects(
    () => mockVercel({ inventory: { aliases: [{ alias: ALIAS, deploymentId: PREDECESSOR }, { alias: "extra.vercel.app" }] } }),
    { code: "E_PLATFORM_GUARD" },
  );
});

test("recognized Vercel-managed production aliases are accepted only with a direct exact target", async () => {
  const generated = [
    "ega-skills-mcp-git-release-20-egas-projects-4fb87621.vercel.app",
    "ega-skills-mcp-egas-projects-4fb87621.vercel.app",
  ];
  const inventory = { aliases: [ALIAS, ...generated].map((alias) => ({ alias, deploymentId: PREDECESSOR })) };
  const observed = await mockVercel({ inventory });
  assert.deepEqual(observed.production_aliases, [ALIAS, ...generated].sort());
  assert.equal(assessBaselineMigration({ authorization: authorization(), expected, observation: observed }).status, "READY");

  for (const bad of [
    { alias: "ega-skills-mcp-git-main-egas-projects-4fb87621.vercel.app", redirect: "other.example" },
    { alias: "ega-skills-mcp-egas-projects-4fb87621.vercel.app", projectId: "prj_other" },
    { alias: "ega-skills-mcp-egas-projects-deadbeef.vercel.app", deploymentId: OTHER },
  ]) {
    await assert.rejects(
      () => mockVercel({
        aliasSequence: (read, name) => name === ALIAS
          ? { alias: ALIAS, deploymentId: PREDECESSOR, projectId: PROJECT }
          : { ...bad, alias: name },
        inventory: { aliases: [ALIAS, bad.alias].map((alias) => ({ alias, deploymentId: PREDECESSOR })) },
      }),
      { code: "E_ALIAS_DRIFT" },
    );
  }
});

test("the approved source commit must be the clean HEAD and reachable from the release branch", () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-approved-source-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "release"]);
  const release = git(["rev-parse", "HEAD"]);
  git(["branch", "release/2.0"]);
  writeFileSync(join(repo, "a.txt"), "unmerged\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "unmerged"]);
  const unmerged = git(["rev-parse", "HEAD"]);

  git(["checkout", release]);
  assert.equal(verifyApprovedSourceCommit(release, "release/2.0", repo), release);
  writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  assert.throws(() => verifyApprovedSourceCommit(release, "release/2.0", repo), { code: "E_SOURCE_DIRTY" });
  rmSync(join(repo, "dirty.txt"));

  git(["checkout", unmerged]);
  assert.throws(() => verifyApprovedSourceCommit(unmerged, "release/2.0", repo), { code: "E_SOURCE_COMMIT" });
  assert.throws(() => verifyApprovedSourceCommit(release, "release/2.0", repo), { code: "E_SOURCE_COMMIT" });
  rmSync(repo, { recursive: true, force: true });
});

test("the migration delta is only the reviewed readiness paths and the runtime files come from Git objects", () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-baseline-delta-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  const pinned = {
    "packages/mcp/server.mts": readFileSync(new URL("../../packages/mcp/server.mts", import.meta.url)),
    "packages/mcp/src/vercel-adapter.ts": readFileSync(new URL("../../packages/mcp/src/vercel-adapter.ts", import.meta.url)),
  };
  for (const path of ["packages/mcp/server.mts", "packages/mcp/src/vercel-adapter.ts", "tests/mcp/vercel-adapter.test.mjs"]) write(path, "old\n");
  write("packages/mcp/src/hosted.ts", "runtime\n");
  git(["add", "-A"]);
  git(["commit", "-m", "predecessor"]);
  const predecessor = git(["rev-parse", "HEAD"]);

  for (const path of ["packages/mcp/server.mts", "packages/mcp/src/vercel-adapter.ts"]) write(path, pinned[path]);
  write("tests/mcp/vercel-adapter.test.mjs", "reviewed\n");
  git(["add", "-A"]);
  git(["commit", "-m", "readiness"]);
  const migration = git(["rev-parse", "HEAD"]);
  assert.deepEqual(verifyBaselineDelta({ migrationCommit: migration, predecessorCommit: predecessor, sourceDir: repo }).changed_paths, [
    "packages/mcp/server.mts",
    "packages/mcp/src/vercel-adapter.ts",
    "tests/mcp/vercel-adapter.test.mjs",
  ]);
  verifyBaselineRuntimeFiles({ migrationCommit: migration, repoRoot: repo, reviewedCommit: migration, sourceDir: repo });

  write("packages/mcp/src/hosted.ts", "unreviewed runtime change\n");
  git(["add", "-A"]);
  git(["commit", "-m", "unreviewed"]);
  const unreviewed = git(["rev-parse", "HEAD"]);
  assert.throws(
    () => verifyBaselineDelta({ migrationCommit: unreviewed, predecessorCommit: predecessor, sourceDir: repo }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );

  write("packages/mcp/src/vercel-adapter.ts", "tampered\n");
  git(["add", "-A"]);
  git(["commit", "-m", "tampered"]);
  const tampered = git(["rev-parse", "HEAD"]);
  assert.throws(
    () => verifyBaselineRuntimeFiles({ migrationCommit: tampered, repoRoot: repo, reviewedCommit: migration, sourceDir: repo }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );
  rmSync(repo, { recursive: true, force: true });
});

test("the deployment worktree is a fresh clean checkout at the exact commit", { skip: process.platform === "win32" }, () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const worktree = createBaselineDeployWorktree(repo, head);
  try {
    assert.equal(spawnSync("git", ["-C", worktree.directory, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), head);
    assert.equal(existsSync(join(worktree.directory, "packages/mcp/artifact/hub-release.json")), true);
    assert.equal(spawnSync("git", ["-C", worktree.directory, "status", "--porcelain", "--ignored"], { encoding: "utf8" }).stdout.trim(), "");
  } finally {
    removeBaselineDeployWorktree({ directory: worktree.directory, parent: worktree.parent, sourceDir: repo });
  }
});

test("readBaselineSources composes the main runtime with the retained artifact", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "ega-compose-"));
  const git = (args, cwd = repo) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, "runtime.txt"), "runtime\n");
  for (const [relativePath, content] of Object.entries({
    "packages/mcp/server.mts": readFileSync(new URL("../../packages/mcp/server.mts", import.meta.url)),
    "packages/mcp/src/vercel-adapter.ts": readFileSync(new URL("../../packages/mcp/src/vercel-adapter.ts", import.meta.url)),
  })) {
    mkdirSync(dirname(join(repo, relativePath)), { recursive: true });
    writeFileSync(join(repo, relativePath), content);
  }
  mkdirSync(join(repo, "packages/mcp/artifact"), { recursive: true });
  writeFileSync(join(repo, "packages/mcp/vercel.json"), JSON.stringify({ git: { deploymentEnabled: false } }) + "\n");
  writeFileSync(join(repo, "packages/mcp/artifact/retained.txt"), "117\n");
  git(["add", "-A"]);
  git(["commit", "-m", "predecessor 117"]);
  const predecessorCommit = git(["rev-parse", "HEAD"]);
  rmSync(join(repo, "packages/mcp/artifact/retained.txt"));
  writeFileSync(join(repo, "packages/mcp/artifact/candidate.txt"), "126\n");
  git(["add", "-A"]);
  git(["commit", "-m", "main candidate 126"]);
  const runtimeCommit = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", runtimeCommit]);

  const predecessorDir = join(repo, "..", `${basename(repo)}-predecessor`);
  const runtimeDir = join(repo, "..", `${basename(repo)}-runtime`);
  git(["worktree", "add", "--detach", predecessorDir, predecessorCommit]);
  git(["worktree", "add", "--detach", runtimeDir, runtimeCommit]);
  t.after(() => {
    git(["worktree", "remove", "-f", predecessorDir]);
    git(["worktree", "remove", "-f", runtimeDir]);
    rmSync(repo, { recursive: true, force: true });
  });
  const predecessorTree = artifactTreeDigest(predecessorDir, "packages/mcp/artifact");
  const runtimeTree = artifactTreeDigest(runtimeDir, "packages/mcp/artifact");
  const runtimeConfig = readRuntimeGitConfig({ commit: runtimeCommit, productionBranch: "main", repoRoot: repo });
  const readCandidateImpl = async (directory) => directory.includes("-predecessor")
    ? { candidate_digest: BASELINE_CANDIDATE, hub_id: "personal", release_digest: BASELINE }
    : { candidate_digest: "sha256:" + "9".repeat(64), hub_id: "personal", release_digest: CANDIDATE_RELEASE };
  const source = await readBaselineSources({
    expected: {
      ...expected,
      baseline_artifact_tree_digest: predecessorTree,
      candidate_artifact_tree_digest: runtimeTree,
      migration_source_commit: runtimeCommit,
      predecessor_source_commit: predecessorCommit,
      reviewed_runtime_commit: runtimeCommit,
      runtime_vercel_config_digest: runtimeConfig.config_digest,
    },
    migrationSourceDir: runtimeDir,
    predecessorSourceDir: predecessorDir,
    readCandidateImpl,
    repoRoot: repo,
  });
  assert.equal(source.artifact_tree_digest, predecessorTree);
  assert.equal(source.candidate_artifact_tree_digest, runtimeTree);
  assert.notEqual(predecessorTree, runtimeTree);
  assert.equal(source.artifact_source_dir, predecessorDir);
  assert.equal(source.migration_source_dir, runtimeDir);

  writeFileSync(join(repo, "packages/mcp/artifact/candidate.txt"), "unreviewed\n");
  git(["add", "-A"]);
  git(["commit", "-m", "unmerged runtime"]);
  const unmerged = git(["rev-parse", "HEAD"]);
  const unmergedDir = join(repo, "..", `${basename(repo)}-unmerged`);
  git(["worktree", "add", "--detach", unmergedDir, unmerged]);
  try {
    await assert.rejects(
      () => readBaselineSources({
        expected: {
          ...expected,
          baseline_artifact_tree_digest: predecessorTree,
          candidate_artifact_tree_digest: runtimeTree,
          migration_source_commit: unmerged,
          predecessor_source_commit: predecessorCommit,
          reviewed_runtime_commit: unmerged,
          runtime_vercel_config_digest: runtimeConfig.config_digest,
        },
        migrationSourceDir: unmergedDir,
        predecessorSourceDir: predecessorDir,
        readCandidateImpl,
        repoRoot: repo,
      }),
      { code: "E_BASELINE_SOURCE_MISMATCH" },
    );
  } finally {
    git(["worktree", "remove", "-f", unmergedDir]);
  }
});

test("the runtime git config control accepts only exact false or all-false branch rules", () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-config-control-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  mkdirSync(join(repo, "packages/mcp"), { recursive: true });
  for (const [config, accepted] of [
    [{ git: { deploymentEnabled: false } }, true],
    [{ git: { deploymentEnabled: { main: false } } }, true],
    [{ git: { deploymentEnabled: { main: false, "*": true } } }, false],
    [{ git: { deploymentEnabled: true } }, false],
    [{}, false],
  ]) {
    writeFileSync(join(repo, "packages/mcp/vercel.json"), JSON.stringify(config) + "\n");
    git(["add", "-A"]);
    git(["commit", "-m", "config"]);
    const commit = git(["rev-parse", "HEAD"]);
    const result = readRuntimeGitConfig({ commit, productionBranch: "main", repoRoot: repo });
    assert.equal(result.control !== undefined, accepted, JSON.stringify(config));
    assert.match(result.config_digest, /^sha256:[0-9a-f]{64}$/);
  }
  rmSync(repo, { recursive: true, force: true });
});

test("the migration runtime source must be reachable from origin/main", () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-baseline-main-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, "a.txt"), "main\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "main"]);
  const main = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", main]);
  assert.equal(verifyBaselineSourceReachability({ directory: repo, expectedCommit: main, productionBranch: "main", repoRoot: repo }), main);
  writeFileSync(join(repo, "a.txt"), "unmerged\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "unmerged"]);
  const unmerged = git(["rev-parse", "HEAD"]);

  assert.throws(
    () => verifyBaselineSourceReachability({ directory: repo, expectedCommit: unmerged, productionBranch: "main", repoRoot: repo }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );
  git(["checkout", main]);
  assert.throws(
    () => verifyBaselineSourceReachability({ directory: repo, expectedCommit: main, productionBranch: "release/2.0", repoRoot: repo }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );

  const fake = mkdtempSync(join(tmpdir(), "ega-baseline-fake-"));
  const fakeGit = (args) => {
    const result = spawnSync("git", args, { cwd: fake, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fakeGit(["init"]);
  fakeGit(["config", "user.email", "test@example.com"]);
  fakeGit(["config", "user.name", "test"]);
  writeFileSync(join(fake, "a.txt"), "fake main\n");
  fakeGit(["add", "a.txt"]);
  fakeGit(["commit", "-m", "fake main"]);
  writeFileSync(join(fake, "a.txt"), "fake unmerged\n");
  fakeGit(["add", "a.txt"]);
  fakeGit(["commit", "-m", "fake unmerged"]);
  const fakeUnmerged = fakeGit(["rev-parse", "HEAD"]);
  fakeGit(["update-ref", "refs/remotes/origin/main", fakeUnmerged]);
  assert.throws(
    () => verifyBaselineSourceReachability({ directory: fake, expectedCommit: fakeUnmerged, productionBranch: "main" }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );
  assert.throws(
    () => verifyBaselineSourceReachability({ directory: fake, expectedCommit: fakeUnmerged, productionBranch: "main", repoRoot: repo }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );
  rmSync(fake, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("the 117 artifact and the untouched 126 runtime artifact are bound separately", () => {
  assert.deepEqual(verifyBaselineArtifactBindings({ expected, migrationTree: CURRENT_TREE, predecessorTree: BASELINE_TREE }), {
    baseline_artifact_tree_digest: BASELINE_TREE,
    candidate_artifact_tree_digest: CURRENT_TREE,
  });
  for (const trees of [
    { migrationTree: CURRENT_TREE, predecessorTree: CURRENT_TREE },
    { migrationTree: BASELINE_TREE, predecessorTree: BASELINE_TREE },
    { migrationTree: BASELINE_TREE, predecessorTree: CURRENT_TREE },
  ]) {
    assert.throws(() => verifyBaselineArtifactBindings({ expected, ...trees }), { code: "E_BASELINE_SOURCE_MISMATCH" });
  }
});

test("the deployment worktree assembles the main runtime with the retained artifact only", { skip: process.platform === "win32" }, () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-baseline-assemble-"));
  const git = (args, cwd = repo) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const artifact = join(repo, "packages/mcp/artifact");
  const writeArtifact = (name, content) => {
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, name), content);
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, "runtime.txt"), "runtime\n");
  writeArtifact("retained.txt", "117\n");
  git(["add", "-A"]);
  git(["commit", "-m", "predecessor 117"]);
  const predecessor = git(["rev-parse", "HEAD"]);
  rmSync(join(artifact, "retained.txt"));
  writeArtifact("candidate.txt", "126\n");
  git(["add", "-A"]);
  git(["commit", "-m", "main candidate 126"]);
  const main = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", main]);

  const predecessorDir = join(repo, "..", `${basename(repo)}-predecessor`);
  git(["worktree", "add", "--detach", predecessorDir, predecessor]);
  const worktree = createBaselineDeployWorktree(repo, main, {
    artifactSourceCommit: predecessor,
    artifactSourceDir: predecessorDir,
    expectedArtifactTreeDigest: artifactTreeDigest(predecessorDir, "packages/mcp/artifact"),
  });
  try {
    assert.equal(existsSync(join(worktree.directory, "packages/mcp/artifact/retained.txt")), true);
    assert.equal(existsSync(join(worktree.directory, "packages/mcp/artifact/candidate.txt")), false);
    const status = spawnSync("git", ["-C", worktree.directory, "status", "--porcelain", "--ignored"], { encoding: "utf8" }).stdout.trim();
    assert.ok(status.split("\n").filter(Boolean).every((line) => line.includes("packages/mcp/artifact/")));
  } finally {
    removeBaselineDeployWorktree({ directory: worktree.directory, parent: worktree.parent, sourceDir: repo });
    git(["worktree", "remove", "-f", predecessorDir]);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a migration source worktree must be clean and at the exact reviewed commit", () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-baseline-git-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "initial"]);
  const head = git(["rev-parse", "HEAD"]);
  assert.equal(verifyBaselineWorktree({ directory: repo, expectedCommit: head, role: "test source" }), repo);
  assert.throws(() => verifyBaselineWorktree({ directory: repo, expectedCommit: "c".repeat(40), role: "test source" }), { code: "E_BASELINE_SOURCE_MISMATCH" });
  writeFileSync(join(repo, "a.txt"), "changed\n");
  assert.throws(() => verifyBaselineWorktree({ directory: repo, expectedCommit: head, role: "test source" }), { code: "E_BASELINE_SOURCE_MISMATCH" });
  rmSync(repo, { recursive: true, force: true });
});

function readiness(stateDir, overrides = {}) {
  return {
    access_controls_reviewed: true,
    canonical_alias: ALIAS,
    certified_by: "release reviewer",
    expires_at: "2026-10-27T13:30:00.000Z",
    project_id: PROJECT,
    production_branch: "main",
    publisher_vercel_user_id: PUBLISHER,
    residual_alias_race_accepted: true,
    review_record: "https://github.com/egawilldoit/ega-skills/pull/176#review",
    schema_version: 1,
    single_writer_controls_reviewed: true,
    state_dir: stateDir,
    team_id: TEAM,
    verified_at: "2026-10-27T12:30:00.000Z",
    ...overrides,
  };
}

function migrationDeps({ mutate = (state) => { state.alias = STAGED; state.legacy = "digest"; state.served = BASELINE; }, now = () => NOW } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ega-baseline-lease-"));
  const state = { alias: PREDECESSOR, calls: 0, deployed: 0, legacy: "legacy", promoted: 0, rolledBack: 0, served: undefined };
  const deps = {
    maxAttempts: 3,
    now,
    readiness: readiness(stateDir),
    readObservation: async () => observation({
      alias_target_deployment_id: state.alias,
      ...(state.alias === STAGED ? { deployment_source_commit: MIGRATION_COMMIT } : {}),
      legacy_readyz: state.legacy,
      production_aliases: [ALIAS],
      served_deployment_id: state.alias,
      ...(state.served === undefined ? {} : { served_release_digest: state.served }),
    }),
    probeReady: async (url) => {
      if (url.includes("staged.example.com")) return { release_digest: BASELINE };
      if (state.alias !== STAGED) throw Object.assign(new Error("legacy"), { code: "E_PROBE_UNAVAILABLE" });
      return { release_digest: state.served };
    },
    readDeploymentIdentity: async () => ({
      checks_state: "succeeded",
      deployment_id: STAGED,
      project_id: PROJECT,
      ready_state: "READY",
      source_commit: MIGRATION_COMMIT,
      target: "production",
      url: "staged.example.com",
    }),
    deployStagedProduction: async () => { state.deployed += 1; return { deployment_id: STAGED, url: "https://staged.example.com" }; },
    promote: async () => { state.promoted += 1; mutate(state); },
    recordReceipt: async () => {},
    rollback: async () => { state.rolledBack += 1; state.alias = PREDECESSOR; state.legacy = "legacy"; state.served = undefined; },
    sleep: async () => {},
    stateDir,
    writeStaging: async (record) => { state.staging = record; },
  };
  return { deps, state, stateDir };
}

function staging(state, overrides = {}) {
  return {
    artifact_tree_digest: BASELINE_TREE,
    authorization_digest: authorization().digest,
    candidate_digest: BASELINE_CANDIDATE,
    deployment_id: STAGED,
    migration_source_commit: MIGRATION_COMMIT,
    predecessor_deployment_id: PREDECESSOR,
    predecessor_release_digest: BASELINE,
    release_digest: BASELINE,
    staged_at: "2026-10-27T12:45:00.000Z",
    url: state.staging?.url ?? "https://staged.example.com",
    ...overrides,
  };
}

function source() {
  return {
    artifact_source_commit: PRE_COMMIT,
    artifact_source_dir: "/tmp/predecessor-source",
    artifact_tree_digest: BASELINE_TREE,
    candidate_artifact_tree_digest: CURRENT_TREE,
    candidate_digest: BASELINE_CANDIDATE,
    candidate_release_digest: CANDIDATE_RELEASE,
    migration_source_commit: MIGRATION_COMMIT,
    migration_source_dir: "/tmp/migration-source",
    predecessor_source_commit: PRE_COMMIT,
    predecessor_source_dir: "/tmp/predecessor-source",
    release_digest: BASELINE,
    reviewed_runtime_commit: REVIEWED_COMMIT,
  };
}

test("FAILED side receipts are persisted without overwriting the final path", () => {
  const root = mkdtempSync(join(tmpdir(), "ega-failed-receipt-"));
  const final = join(root, "receipt.json");
  const error = { receipt: { digest: "sha256:" + "e".repeat(64), payload: { status: "FAILED" } } };
  assert.equal(persistFailedReceipt(final, error), true);
  assert.deepEqual(JSON.parse(readFileSync(`${final}.failed.json`, "utf8")), error.receipt);
  assert.equal(existsSync(final), false);
  assert.equal(persistFailedReceipt(final, new Error("no receipt")), false);
  rmSync(root, { recursive: true, force: true });
});

test("baseline staging records are exact, well-formed and authorization-bound", () => {
  const auth = authorization();
  const record = staging({});
  assert.equal(verifyBaselineStaging(record, expected, auth.digest), record);
  for (const invalid of [
    { ...record, extra: true },
    { ...record, deployment_id: "not-a-deployment" },
    { ...record, release_digest: "sha256:" + "8".repeat(64) },
    { ...record, authorization_digest: "sha256:" + "7".repeat(64) },
    { ...record, staged_at: "not-a-time" },
    { ...record, url: "not a URL" },
    { ...record, url: "http://staged.example.com" },
    { ...record, url: "https://user:pass@staged.example.com" },
    { ...record, url: "https://staged.example.com/?a=1" },
  ]) {
    assert.throws(() => verifyBaselineStaging(invalid, expected, auth.digest), { code: "E_BASELINE_STAGE" });
  }
  assert.throws(
    () => verifyBaselineStaging(record, expected, auth.digest, Date.parse("2026-10-27T12:30:00.000Z")),
    { code: "E_BASELINE_STAGE" },
  );
});

test("baseline migration stages, promotes and records the exact retained digest", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const receipts = [];
  deps.recordReceipt = async (receipt) => { receipts.push(receipt); };
  const result = await executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() });
  assert.equal(result.status, "BASELINE_MIGRATED");
  assert.equal(state.deployed, 1);
  assert.equal(state.promoted, 1);
  assert.equal(state.alias, STAGED);
  assert.equal(state.staging.deployment_id, STAGED);
  assert.equal(state.staging.authorization_digest, authorization().digest);
  assert.equal(receipts.length, 1);
  const receipt = verifyBaselineMigrationReceipt(result.receipt);
  assert.equal(receipt.payload.status, "SUCCEEDED");
  assert.equal(receipt.payload.release_digest, BASELINE);
  assert.equal(receipt.payload.candidate_digest, BASELINE_CANDIDATE);
  assert.equal(receipt.payload.artifact_tree_digest, BASELINE_TREE);
  assert.equal(receipt.payload.predecessor_deployment_id, PREDECESSOR);
  assert.equal(receipt.payload.deployment_id, STAGED);
  assert.equal(receipt.payload.migration_source_commit, MIGRATION_COMMIT);
  assert.equal(receipt.payload.predecessor_source_commit, PRE_COMMIT);
});

test("dry-run performs no deployment, promotion or receipt write", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const result = await executeBaselineMigration({ apply: false, authorization: authorization(), deps, expected, source: source() });
  assert.equal(result.status, "DRY_RUN");
  assert.equal(state.deployed, 0);
  assert.equal(state.promoted, 0);
});

test("unavailable or already-migrated readiness blocks before any deployment", async (t) => {
  for (const [legacy, served] of [["unavailable", undefined], ["digest", BASELINE]]) {
    const { deps, state, stateDir } = migrationDeps();
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    deps.readObservation = async () => observation({ legacy_readyz: legacy, ...(served ? { served_release_digest: served } : {}) });
    await assert.rejects(
      () => executeBaselineMigration({ apply: false, authorization: authorization(), deps, expected, source: source() }),
      (error) => error.code === "E_BASELINE_BLOCKED" && /E_BASELINE_LEGACY_STATE/.test(error.message),
    );
    assert.equal(state.deployed, 0);
  }
});

test("readiness is mandatory for an applying baseline migration", async (t) => {
  const { deps, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  deps.readiness = undefined;
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    { code: "E_PUBLICATION_READINESS" },
  );
});

test("a staged deployment without the authorized source commit never promotes", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  deps.readDeploymentIdentity = async () => ({
    checks_state: "succeeded",
    deployment_id: STAGED,
    project_id: PROJECT,
    ready_state: "READY",
    source_commit: "c".repeat(40),
    target: "production",
    url: "staged.example.com",
  });
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );
  assert.equal(state.promoted, 0);

  deps.readDeploymentIdentity = async () => ({
    checks_state: "succeeded",
    deployment_id: STAGED,
    project_id: PROJECT,
    ready_state: "READY",
    source_commit: MIGRATION_COMMIT,
    target: "production",
    url: "other.example.com",
  });
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    { code: "E_BASELINE_SOURCE_MISMATCH" },
  );
  assert.equal(state.promoted, 0);
});

test("a staged migration deployment without successful checks never promotes", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  deps.readDeploymentIdentity = async () => ({
    checks_state: "pending",
    deployment_id: STAGED,
    project_id: PROJECT,
    ready_state: "READY",
    source_commit: MIGRATION_COMMIT,
    target: "production",
    url: "staged.example.com",
  });
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    { code: "E_BASELINE_CHECKS_NOT_PASSED" },
  );
  assert.equal(state.promoted, 0);
});

test("a promoted deployment that reports a different source commit is restored", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const original = deps.readObservation;
  deps.readObservation = async () => {
    const value = await original();
    return value.alias_target_deployment_id === STAGED ? { ...value, deployment_source_commit: "c".repeat(40) } : value;
  };
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    (error) => error.code === "E_BASELINE_SOURCE_MISMATCH" && error.receipt?.payload.status === "FAILED",
  );
  assert.equal(state.rolledBack, 1);
  assert.equal(state.alias, PREDECESSOR);
});

test("a receipt write failure after promotion restores the predecessor", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  deps.recordReceipt = async () => { throw Object.assign(new Error("receipt disk full"), { code: "E_RECEIPT_WRITE" }); };
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    (error) => error.code === "E_RECEIPT_WRITE" && error.receipt?.payload.status === "FAILED",
  );
  assert.equal(state.rolledBack, 1);
  assert.equal(state.alias, PREDECESSOR);
});

test("a failed promotion restores the legacy deployment and records FAILED side evidence", async (t) => {
  const { deps, state, stateDir } = migrationDeps({
    mutate: (current) => { current.alias = STAGED; current.legacy = "digest"; current.served = "sha256:" + "f".repeat(64); },
  });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    (error) => error.code === "E_BASELINE_UNVERIFIED" && error.receipt?.payload.status === "FAILED",
  );
  assert.equal(state.rolledBack, 1);
  assert.equal(state.alias, PREDECESSOR);
  assert.equal(state.legacy, "legacy");
});

test("a promotion that fails before moving the alias reports the real error and restores nothing", async (t) => {
  const { deps, state, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  deps.promote = async () => { state.promoted += 1; throw Object.assign(new Error("vercel promote failed"), { code: "E_VERCEL_CLI" }); };
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    { code: "E_VERCEL_CLI" },
  );
  assert.equal(state.rolledBack, 0);
  assert.equal(state.alias, PREDECESSOR);
});

test("an absent-accepted legacy predecessor is restored under the same check policy", async (t) => {
  const { deps, state, stateDir } = migrationDeps({
    mutate: (current) => { current.alias = STAGED; current.legacy = "digest"; current.served = "sha256:" + "f".repeat(64); },
  });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const original = deps.readObservation;
  deps.readObservation = async () => {
    const value = await original();
    return { ...value, deployment_checks_state: value.alias_target_deployment_id === STAGED ? "succeeded" : "none" };
  };
  const absentAuth = authorization({ legacy_deployment_checks: "absent-accepted" });
  const absentExpected = { ...expected, legacy_deployment_checks: "absent-accepted" };
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: absentAuth, deps, expected: absentExpected, source: source() }),
    (error) => error.code === "E_BASELINE_UNVERIFIED" && error.receipt?.payload.status === "FAILED",
  );
  assert.equal(state.rolledBack, 1);
  assert.equal(state.alias, PREDECESSOR);
});

test("a migration superseded by another publication is never clobbered", async (t) => {
  const { deps, state, stateDir } = migrationDeps({
    mutate: (current) => { current.alias = OTHER; current.legacy = "digest"; current.served = BASELINE; },
  });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  await assert.rejects(
    () => executeBaselineMigration({ apply: true, authorization: authorization(), deps, expected, source: source() }),
    { code: "E_PUBLICATION_SUPERSEDED" },
  );
  assert.equal(state.rolledBack, 0);
  assert.equal(state.alias, OTHER);
});

test("an interrupted baseline migration reconciles only the exact live result", async (t) => {
  const { deps, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  deps.readObservation = async () => observation({ alias_target_deployment_id: STAGED, deployment_source_commit: MIGRATION_COMMIT, legacy_readyz: "digest", served_deployment_id: STAGED, served_release_digest: BASELINE });
  const receipts = [];
  deps.recordReceipt = async (receipt) => { receipts.push(receipt); };
  const result = await executeBaselineReconcile({ apply: true, authorization: authorization(), deps, expected, source: source(), staging: staging({}) });
  assert.equal(result.status, "BASELINE_RECONCILED");
  assert.equal(verifyBaselineMigrationReceipt(result.receipt).payload.status, "SUCCEEDED");
  assert.equal(receipts.length, 1);

  const absentAuth = authorization({ legacy_deployment_checks: "absent-accepted" });
  const absentExpected = { ...expected, legacy_deployment_checks: "absent-accepted" };
  const absent = await executeBaselineReconcile({
    apply: true,
    authorization: absentAuth,
    deps,
    expected: absentExpected,
    source: source(),
    staging: staging({}, { authorization_digest: absentAuth.digest }),
  });
  assert.equal(absent.status, "BASELINE_RECONCILED");

  deps.readObservation = async () => observation({ alias_target_deployment_id: PREDECESSOR });
  await assert.rejects(
    () => executeBaselineReconcile({ apply: true, authorization: authorization(), deps, expected, source: source(), staging: staging({}) }),
    { code: "E_BASELINE_RECONCILE_STATE" },
  );

  deps.readObservation = async () => observation({ alias_target_deployment_id: STAGED, deployment_source_commit: MIGRATION_COMMIT, legacy_readyz: "digest", served_deployment_id: STAGED, served_release_digest: BASELINE });
  await assert.rejects(
    () => executeBaselineReconcile({ apply: true, authorization: authorization(), deps, expected, source: source(), staging: staging({}, { authorization_digest: "sha256:" + "9".repeat(64) }) }),
    { code: "E_BASELINE_STAGE" },
  );
});

test("reconcile refuses a staged deployment without successful checks", async (t) => {
  const { deps, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  for (const checks of ["none", "pending"]) {
    deps.readObservation = async () => observation({
      alias_target_deployment_id: STAGED,
      deployment_checks_state: checks,
      deployment_source_commit: MIGRATION_COMMIT,
      legacy_readyz: "digest",
      served_deployment_id: STAGED,
      served_release_digest: BASELINE,
    });
    await assert.rejects(
      () => executeBaselineReconcile({ apply: true, authorization: authorization(), deps, expected, source: source(), staging: staging({}) }),
      { code: "E_BASELINE_CHECKS_NOT_PASSED" },
    );
  }
});

test("an existing lease blocks a second baseline migration", async (t) => {
  const { deps, stateDir } = migrationDeps();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const lease = await acquirePublicationLease({ now: NOW, stateDir });
  try {
    await assert.rejects(
      () => executeBaselineMigration({ apply: false, authorization: authorization(), deps, expected, source: source() }),
      { code: "E_PUBLICATION_LEASE" },
    );
  } finally {
    lease.release();
  }
});
