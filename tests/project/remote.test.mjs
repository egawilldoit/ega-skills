import assert from "node:assert/strict";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import {
  REMOTE_PROJECT_ERROR_CODES,
  createProjectContextCacheIdentity,
  createProjectContextStore,
  createProjectContextArtifact,
  createRemoteLockPlan,
  hashNormalizedConfig,
  verifyProjectContext,
  verifyRemoteLockPlan,
} from "../../packages/project/dist/index.js";
import { parseProjectConfig } from "../../packages/project/dist/index.js";
import test from "node:test";

const config = parseProjectConfig("schema_version: 1\nrouting:\n  max_skills: 2\n");
const skillId = "ega/alpha";
const versionHash = `sha256:${"1".repeat(64)}`;
const release = createEnvelope({
  object_type: "ega.hub-release",
  schema_version: 1,
  payload: {
    hub_id: "personal",
    skill_versions: { [skillId]: versionHash },
    alias_map_digest: `sha256:${"2".repeat(64)}`,
    search_index_input_digest: `sha256:${"3".repeat(64)}`,
    token_artifact_digest: `sha256:${"4".repeat(64)}`,
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

function lock(skills) {
  return Object.freeze({
    lockfile_version: 1,
    token_estimator: "ega-o200k-v1",
    generated_from: Object.freeze({ config_hash: hashNormalizedConfig(config) }),
    skills: Object.freeze(skills),
  });
}

test("Contract E context identity binds config, lock, release, and optional fingerprint", () => {
  const context = createProjectContextArtifact({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
    release,
    fingerprint_digest: `sha256:${"5".repeat(64)}`,
  });
  assert.equal(context.context_contract_version, 1);
  assert.equal(context.release_digest, release.digest);
  assert.match(context.context_digest, /^sha256:[0-9a-f]{64}$/);
  verifyProjectContext(context);
  assert.throws(
    () => verifyProjectContext({ ...context, project_id: "project-b" }),
    (error) => error?.code === REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT,
  );
});

test("Contract E rejects a lock that crosses the exact HubRelease", () => {
  const outsideHash = `sha256:${"9".repeat(64)}`;
  assert.throws(
    () => createProjectContextArtifact({
      workspace_id: "workspace-a",
      project_id: "project-a",
      config,
      lock: lock({ [skillId]: { name: "alpha", version_hash: outsideHash } }),
      release,
    }),
    (error) => error?.code === REMOTE_PROJECT_ERROR_CODES.LOCK_RELEASE_MISMATCH,
  );
});

test("Contract E remote lock plans are immutable, reviewable, and diff exact entries", () => {
  const existing = lock({});
  const candidate = lock({ [skillId]: { name: "alpha", version_hash: versionHash } });
  const plan = createRemoteLockPlan({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    existing_lock: existing,
    candidate_lock: candidate,
    target_release: release,
    fingerprint_digest: null,
  });
  assert.deepEqual(plan.added_entries, [skillId]);
  assert.deepEqual(plan.removed_entries, []);
  assert.deepEqual(plan.changed_entries, []);
  assert.match(plan.plan_digest, /^sha256:[0-9a-f]{64}$/);
  verifyRemoteLockPlan(plan);
  assert.throws(
    () => verifyRemoteLockPlan({ ...plan, target_release_digest: `sha256:${"0".repeat(64)}` }),
    (error) => error?.code === REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT,
  );
});

test("Contract E cache identity and lifecycle preserve exact artifacts across revocation", () => {
  const context = createProjectContextArtifact({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
    release,
  });
  const cache = createProjectContextCacheIdentity({
    workspace_id: context.workspace_id,
    project_id: context.project_id,
    context_id: "ctx-main",
    config_digest: context.config_digest,
    lock_digest: context.lock_digest,
    release_digest: context.release_digest,
    fingerprint_digest: context.fingerprint_digest,
    router_contract_version: 1,
    search_contract_version: 1,
    task: "hosted",
    query: null,
    explicit_skills: [skillId],
    max_skills: 1,
    max_tokens: 500,
    policy_digest: null,
  });
  assert.match(cache.cache_identity_digest, /^sha256:[0-9a-f]{64}$/);
  const store = createProjectContextStore();
  const published = store.publish({ contextId: "ctx-main", context });
  assert.equal(published.revoked, false);
  const second = store.publish({
    contextId: "ctx-feature",
    context: createProjectContextArtifact({
      workspace_id: context.workspace_id,
      project_id: context.project_id,
      config,
      lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
      release,
      fingerprint_digest: `sha256:${"6".repeat(64)}`,
    }),
  });
  assert.equal(second.revoked, false);
  assert.deepEqual(store.list().map((record) => record.contextId), ["ctx-feature", "ctx-main"]);
  const retained = store.revoke("ctx-main");
  assert.equal(retained.revoked, true);
  assert.equal(retained.context.context_digest, context.context_digest);
  assert.equal(store.get("ctx-main")?.context.context_digest, context.context_digest);
  assert.equal(store.get("ctx-feature")?.revoked, false);
  assert.throws(() => store.publish({ contextId: "ctx-main", context }), /already published/);
});
