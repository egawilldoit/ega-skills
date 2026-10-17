import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectContext,
  createProjectContextStore,
  FileProjectContextPersistence,
  verifyProjectContext,
} from "../../packages/project/dist/index.js";

const digest = (char) => `sha256:${char.repeat(64)}`;

function context(projectId = "project-a") {
  return createProjectContext({
    workspace_id: "workspace-a",
    project_id: projectId,
    config_digest: digest("1"),
    lock_digest: digest("2"),
    release_digest: digest("3"),
    fingerprint_digest: null,
    context_contract: "E1",
  });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ega-context-store-"));
}

test("durable context store reconstructs published contexts after restart", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "contexts.json");
    const first = createProjectContextStore(new FileProjectContextPersistence(path));
    const published = first.publish({ contextId: "ctx-a", context: context("project-a") });
    assert.equal(published.revoked, false);
    assert.equal(existsSync(path), true);

    const restarted = createProjectContextStore(new FileProjectContextPersistence(path));
    assert.deepEqual(restarted.list().map((record) => record.contextId), ["ctx-a"]);
    assert.equal(restarted.get("ctx-a")?.context.digest, published.context.digest);
    assert.equal(restarted.get("ctx-a")?.revoked, false);
    assert.equal(restarted.get("ctx-missing"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation persists across restart and a new identity serves while the old one cannot", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "contexts.json");
    const first = createProjectContextStore(new FileProjectContextPersistence(path));
    const old = first.publish({ contextId: "ctx-old", context: context("project-old") });
    assert.equal(first.revoke("ctx-old").revoked, true);
    // New-identity publication after revoking the old one is allowed.
    const newIdentity = first.publish({ contextId: "ctx-new", context: context("project-new") });
    assert.equal(newIdentity.revoked, false);

    const restarted = createProjectContextStore(new FileProjectContextPersistence(path));
    assert.equal(restarted.isRevoked("ctx-old"), true);
    assert.equal(restarted.isRevoked("ctx-new"), false);
    // The revoked old identity cannot serve; the new identity serves.
    assert.equal(restarted.get("ctx-old")?.revoked, true);
    assert.equal(restarted.get("ctx-old")?.context.digest, old.context.digest);
    assert.equal(restarted.get("ctx-new")?.revoked, false);
    assert.equal(restarted.get("ctx-new")?.context.digest, newIdentity.context.digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or malformed persistence fails closed on construction", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "contexts.json");
    writeFileSync(path, "{not json");
    assert.throws(() => createProjectContextStore(new FileProjectContextPersistence(path)), SyntaxError);

    writeFileSync(path, JSON.stringify([{ contextId: "ctx-a" }]));
    assert.throws(
      () => createProjectContextStore(new FileProjectContextPersistence(path)),
      /invalid shape/,
    );

    writeFileSync(path, JSON.stringify([{ contextId: "ctx-a", context: { bogus: true }, revoked: false }]));
    assert.throws(
      () => createProjectContextStore(new FileProjectContextPersistence(path)),
      /invalid project context/,
    );

    writeFileSync(path, JSON.stringify([
      { contextId: "ctx-a", context: context("project-a"), revoked: false },
      { contextId: "ctx-a", context: context("project-a"), revoked: false },
    ]));
    assert.throws(
      () => createProjectContextStore(new FileProjectContextPersistence(path)),
      /duplicated in persistence/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const store = createProjectContextStore(persistence);
  const ctx = context("project-a");

  failSave = true;
  assert.throws(() => store.publish({ contextId: "ctx-failed", context: ctx }), /disk full/);
  assert.equal(store.get("ctx-failed"), undefined);

  failSave = false;
  store.publish({ contextId: "ctx-main", context: ctx });
  failSave = true;
  assert.throws(() => store.revoke("ctx-main"), /disk full/);
  assert.equal(store.get("ctx-main")?.revoked, false);
  assert.equal(records[0].revoked, false);
  assert.equal(createProjectContextStore(persistence).get("ctx-main")?.revoked, false);
});

test("file replacement failure restores the previous durable store", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "contexts.json");
    const store = createProjectContextStore(new FileProjectContextPersistence(path));
    store.publish({ contextId: "ctx-main", context: context("project-a") });
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
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup failure after replacement does not report a false persistence failure", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "contexts.json");
    createProjectContextStore(new FileProjectContextPersistence(path))
      .publish({ contextId: "ctx-main", context: context("project-a") });

    let targetAttempts = 0;
    let backupDirectory;
    const replacement = new FileProjectContextPersistence(
      path,
      (from, to) => {
        if (to === path) {
          targetAttempts += 1;
          if (targetAttempts === 1) throw new Error("destination replacement required");
        }
        renameSync(from, to);
      },
      (target, options) => {
        if (target.includes(".ega-context-backup-")) {
          backupDirectory = target;
          throw new Error("backup cleanup unavailable");
        }
        rmSync(target, options);
      },
    );
    const replacementStore = createProjectContextStore(replacement);
    assert.doesNotThrow(() => replacementStore.revoke("ctx-main"));
    assert.equal(targetAttempts, 2);
    assert.equal(replacementStore.get("ctx-main")?.revoked, true);
    assert.equal(new FileProjectContextPersistence(path).load()[0].revoked, true);
    assert.ok(backupDirectory && existsSync(backupDirectory));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("republishing an existing identity is rejected and does not rewrite persistence", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "contexts.json");
    const store = createProjectContextStore(new FileProjectContextPersistence(path));
    store.publish({ contextId: "ctx-main", context: context("project-a") });
    const before = readFileSync(path, "utf8");
    assert.throws(
      () => store.publish({ contextId: "ctx-main", context: context("project-b") }),
      /already published/,
    );
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the retained context is deep-frozen and independent of the caller's nested payload", () => {
  const store = createProjectContextStore();
  const original = context("project-a");
  // The caller keeps its own reference to the nested payload object.
  const callerPayload = original.payload;
  const published = store.publish({ contextId: "ctx-main", context: original });
  const retained = store.get("ctx-main");
  assert.ok(retained);

  // Positive: mutating the caller's ORIGINAL nested payload does not change the
  // retained context, and the digest still describes the retained payload.
  callerPayload.project_id = "project-mutated";
  assert.equal(callerPayload.project_id, "project-mutated");
  assert.equal(retained.context.payload.project_id, "project-a");
  assert.equal(store.get("ctx-main")?.context.payload.project_id, "project-a");
  assert.equal(retained.context.digest, published.context.digest);
  assert.equal(verifyProjectContext(retained.context).digest, published.context.digest);

  // Negative: every level of the returned context is frozen, so a mutation
  // attempt fails instead of corrupting a published record.
  assert.ok(Object.isFrozen(retained.context));
  assert.ok(Object.isFrozen(retained.context.payload));
  assert.throws(() => { retained.context.payload.workspace_id = "workspace-mutated"; }, TypeError);
  assert.throws(() => { delete retained.context.payload.project_id; }, TypeError);
  // The failed attempts left the retained state and its digest intact.
  assert.equal(retained.context.payload.workspace_id, "workspace-a");
  assert.equal(retained.context.payload.project_id, "project-a");
  assert.equal(store.get("ctx-main")?.context.payload.workspace_id, "workspace-a");
  assert.equal(verifyProjectContext(store.get("ctx-main")?.context).digest, published.context.digest);
});
