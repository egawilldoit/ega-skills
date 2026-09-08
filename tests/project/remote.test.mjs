import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { canonicalizeJson, createEnvelope, hashBytes } from "../../packages/hashing/dist/index.js";
import {
  REMOTE_PROJECT_ERROR_CODES,
  createProjectContextCacheIdentity,
  createProjectContextStore,
  FileProjectContextPersistence,
  createContextControlPlaneHandler,
  createProjectContextArtifact,
  createRemoteLockPlan,
  hashNormalizedConfig,
  getProjectContext,
  listProjectContexts,
  verifyProjectContext,
  verifyRemoteLockPlan,
  verifyRemoteLockPlanAgainstLock,
  publishProjectContext,
  revokeProjectContext,
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

test("Contract E rejects forged remote lock change sets", () => {
  const candidate = lock({ [skillId]: { name: "alpha", version_hash: versionHash } });
  const plan = createRemoteLockPlan({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    existing_lock: lock({}),
    candidate_lock: candidate,
    target_release: release,
  });
  const forged = {
    ...plan,
    removed_entries: [skillId],
    changed_entries: [
      { skill_id: skillId, previous_version_hash: versionHash, candidate_version_hash: versionHash },
      { skill_id: skillId, previous_version_hash: versionHash, candidate_version_hash: versionHash },
    ],
  };
  assert.throws(
    () => verifyRemoteLockPlan({ ...forged, plan_digest: `sha256:${"a".repeat(64)}` }),
    (error) => error?.code === REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT,
  );
});

test("Contract E compares equivalent remote lock changes canonically", () => {
  const previousVersionHash = `sha256:${"0".repeat(64)}`;
  const existing = lock({ [skillId]: { name: "alpha", version_hash: previousVersionHash } });
  const candidate = lock({ [skillId]: { name: "alpha", version_hash: versionHash } });
  const plan = createRemoteLockPlan({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    existing_lock: existing,
    candidate_lock: candidate,
    target_release: release,
  });
  const reorderedChange = {
    candidate_version_hash: versionHash,
    skill_id: skillId,
    previous_version_hash: previousVersionHash,
  };
  const { plan_digest: _ignored, ...artifact } = { ...plan, changed_entries: [reorderedChange] };
  const equivalent = { ...artifact, plan_digest: hashBytes(canonicalizeJson(artifact)) };
  assert.doesNotThrow(() => verifyRemoteLockPlanAgainstLock(equivalent, existing));
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

test("context control plane bounds unknown-length request bodies before reading them", async () => {
  const store = createProjectContextStore();
  const handler = createContextControlPlaneHandler({
    store,
    maxBodyBytes: 16,
    authenticate: () => true,
    authorize: () => true,
  });
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(8));
      if (pulls >= 10) controller.close();
    },
  });
  const response = await handler(new Request("https://control.example.test/v1/contexts", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body,
    duplex: "half",
  }));
  assert.equal(response.status, 413);
  assert.ok(pulls < 10, `control plane consumed ${pulls} chunks`);
});

test("context clients reject remote cleartext endpoints before sending bearer credentials", async () => {
  let fetches = 0;
  await assert.rejects(
    publishProjectContext(
      "http://remote.example.test",
      "secret-token",
      "ctx-main",
      {} ,
      {},
      async () => {
        fetches += 1;
        return new Response();
      },
    ),
    /HTTPS is required/,
  );
  assert.equal(fetches, 0);
});

test("context client preserves an endpoint base path and accepts case-insensitive bearer schemes", async () => {
  const seen = [];
  const fetcher = async (input, init) => {
    seen.push({ url: new URL(input).toString(), authorization: init?.headers?.authorization });
    return new Response(JSON.stringify({ contexts: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const listed = await listProjectContexts("http://127.0.0.1:8787/control-plane", "token-a", fetcher);
  assert.deepEqual(listed.contexts, []);
  assert.deepEqual(seen, [{
    url: "http://127.0.0.1:8787/control-plane/v1/contexts",
    authorization: "Bearer token-a",
  }]);

  await listProjectContexts("http://[::1]:8787/control-plane", "token-a", fetcher);
  assert.equal(seen[1].url, "http://[::1]:8787/control-plane/v1/contexts");

  const store = createProjectContextStore();
  const handler = createContextControlPlaneHandler({
    store,
    authenticate: (token) => token === "token-a",
    authorize: () => true,
  });
  const response = await handler(new Request("https://control.example.test/v1/contexts", {
    headers: { authorization: "bEaReR token-a" },
  }));
  assert.equal(response.status, 200);
});

test("context clients report non-JSON control-plane failures by status", async () => {
  await assert.rejects(
    publishProjectContext("https://control.example.test", "token-a", "ctx-main", {}, {}, async () => new Response("upstream unavailable", { status: 503 })),
    /Context publication failed \(503\)/,
  );
});

test("context clients bound unknown-length response bodies", async () => {
  let pulls = 0;
  const responseBody = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(8));
      if (pulls >= 10) controller.close();
    },
  });
  await assert.rejects(
    listProjectContexts("https://control.example.test", "token-a", async () => new Response(responseBody), { maxResponseBytes: 16 }),
    /control-plane response exceeds configured limit/,
  );
  assert.ok(pulls < 10, `control-plane client consumed ${pulls} response chunks`);
});

test("context clients abort a request that exceeds its deadline", async () => {
  let aborted = false;
  const fetcher = async (_input, init) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response(JSON.stringify({ contexts: [] }), { status: 200 });
  };
  await assert.rejects(
    listProjectContexts("https://control.example.test", "token-a", fetcher, { timeoutMs: 10 }),
    /control-plane request timed out/,
  );
  assert.equal(aborted, true);
});

test("context clients reject malformed successful responses", async () => {
  const emptyResponse = async () => new Response("", { status: 200 });
  await assert.rejects(
    publishProjectContext("https://control.example.test", "token-a", "ctx-main", {}, {}, emptyResponse),
    /Context publication returned an invalid response/,
  );
  await assert.rejects(
    getProjectContext("https://control.example.test", "token-a", "ctx-main", emptyResponse),
    /Context retrieval returned an invalid response/,
  );
  await assert.rejects(
    revokeProjectContext("https://control.example.test", "token-a", "ctx-main", emptyResponse),
    /Context revocation returned an invalid response/,
  );
  await assert.rejects(
    listProjectContexts("https://control.example.test", "token-a", async () => new Response(JSON.stringify({ contexts: [{}] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })),
    /Context listing item 0 returned an invalid response/,
  );
});

test("context visibility changes only after durable persistence succeeds", () => {
  let records = [];
  let failSave = false;
  const persistence = {
    load: () => records,
    save(record) {
      if (failSave) throw new Error("disk full");
      records = [...records.filter((current) => current.contextId !== record.contextId), record];
    },
  };
  const context = createProjectContextArtifact({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
    release,
  });
  const store = createProjectContextStore(persistence);
  assert.throws(() => {
    failSave = true;
    store.publish({ contextId: "ctx-failed", context });
  }, /disk full/);
  assert.equal(store.get("ctx-failed"), undefined);

  failSave = false;
  store.publish({ contextId: "ctx-main", context });
  failSave = true;
  assert.throws(() => store.revoke("ctx-main"), /disk full/);
  assert.equal(store.get("ctx-main")?.revoked, false);
  assert.equal(records[0].revoked, false);
  assert.equal(createProjectContextStore(persistence).get("ctx-main")?.revoked, false);
});

test("file context replacement failure restores the previous durable store", async () => {
  const root = await mkdtemp(`${tmpdir()}/ega-context-file-`);
  try {
    const path = `${root}/contexts.json`;
    const persistence = new FileProjectContextPersistence(path);
    const context = createProjectContextArtifact({
      workspace_id: "workspace-a",
      project_id: "project-a",
      config,
      lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
      release,
    });
    const store = createProjectContextStore(persistence);
    store.publish({ contextId: "ctx-main", context });
    const previous = store.get("ctx-main");
    assert.ok(previous);
    let targetAttempts = 0;
    const failingReplacement = new FileProjectContextPersistence(path, (from, to) => {
      if (to === path) {
        targetAttempts += 1;
        if (targetAttempts <= 2) throw new Error("replacement failed");
      }
      renameSync(from, to);
    });
    assert.throws(() => failingReplacement.save({ ...previous, revoked: true }), /replacement failed/);
    assert.equal(targetAttempts, 3);
    assert.equal(new FileProjectContextPersistence(path).load()[0].revoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file context persistence retains a backup when restoration also fails", async () => {
  const root = await mkdtemp(`${tmpdir()}/ega-context-retained-backup-`);
  try {
    const path = `${root}/contexts.json`;
    const persistence = new FileProjectContextPersistence(path);
    const context = createProjectContextArtifact({
      workspace_id: "workspace-a",
      project_id: "project-a",
      config,
      lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
      release,
    });
    const store = createProjectContextStore(persistence);
    store.publish({ contextId: "ctx-main", context });
    const previous = store.get("ctx-main");
    assert.ok(previous);
    let targetAttempts = 0;
    const failingRestoration = new FileProjectContextPersistence(path, (from, to) => {
      if (to === path) {
        targetAttempts += 1;
        if (targetAttempts <= 3) throw new Error("replacement failed");
      }
      renameSync(from, to);
    });
    let error;
    try {
      failingRestoration.save({ ...previous, revoked: true });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /replacement failed; context backup retained at /);
    assert.equal(targetAttempts, 3);
    const retainedPath = error.message.match(/context backup retained at (.+)$/)?.[1];
    assert.ok(retainedPath);
    const retained = JSON.parse(readFileSync(retainedPath, "utf8"));
    assert.equal(retained[0].revoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file context persistence rejects malformed record entries before store reconstruction", async () => {
  const root = await mkdtemp(`${tmpdir()}/ega-context-invalid-`);
  try {
    const path = `${root}/contexts.json`;
    writeFileSync(path, JSON.stringify([{ contextId: "ctx-main", revoked: false }]));
    assert.throws(() => new FileProjectContextPersistence(path).load(), /invalid shape/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context control plane lists only authorized contexts and supports client lifecycle operations", async () => {
  const contextA = createProjectContextArtifact({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config,
    lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
    release,
  });
  const contextB = createProjectContextArtifact({
    workspace_id: "workspace-b",
    project_id: "project-b",
    config,
    lock: lock({ [skillId]: { name: "alpha", version_hash: versionHash } }),
    release,
  });
  const store = createProjectContextStore();
  store.publish({ contextId: "ctx-a", context: contextA });
  store.publish({ contextId: "ctx-b", context: contextB });
  const handler = createContextControlPlaneHandler({
    store,
    authenticate: (token) => token === "token-a",
    authorize: ({ workspaceId }) => workspaceId === "workspace-a",
  });
  const fetcher = async (input, init) => handler(new Request(input, init));
  const listed = await listProjectContexts("http://127.0.0.1:8787", "token-a", fetcher);
  assert.deepEqual(listed.contexts.map((item) => item.context_id), ["ctx-a"]);
  const revoked = await revokeProjectContext("http://127.0.0.1:8787", "token-a", "ctx-a", fetcher);
  assert.equal(revoked.revoked, true);
  const forbidden = await fetcher("http://127.0.0.1:8787/v1/contexts/ctx-b", {
    headers: { authorization: "Bearer token-a" },
  });
  assert.equal(forbidden.status, 404);
  assert.deepEqual(await forbidden.json(), { code: REMOTE_PROJECT_ERROR_CODES.CONTEXT_NOT_FOUND });
  const absent = await fetcher("http://127.0.0.1:8787/v1/contexts/not-published", {
    headers: { authorization: "Bearer token-a" },
  });
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), { code: REMOTE_PROJECT_ERROR_CODES.CONTEXT_NOT_FOUND });
});
