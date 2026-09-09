import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRemoteLockPlan,
  createProjectContext,
  createRemoteLockPlan,
  digestProjectLock,
  verifyProjectContext,
} from "../../packages/project/dist/index.js";
import { createEnvelope } from "../../packages/hashing/dist/index.js";

const digest = (hex) => `sha256:${hex.repeat(64 / hex.length)}`;
const lock = (skill, version) => ({
  lockfile_version: 1,
  token_estimator: "ega-o200k-v1",
  generated_from: { config_hash: digest("a") },
  skills: { [skill]: { name: skill.split("/")[1], version_hash: digest(version) } },
});

test("ProjectContext binds one immutable release and verifies its envelope", () => {
  const context = createProjectContext({
    workspace_id: "workspace-a",
    project_id: "project-a",
    config_digest: digest("a"),
    lock_digest: digest("b"),
    release_digest: digest("c"),
    fingerprint_digest: null,
    context_contract: "E1",
  });
  assert.equal(verifyProjectContext(context).payload.release_digest, digest("c"));
  const forged = structuredClone(context);
  forged.payload.release_digest = digest("d");
  assert.throws(() => verifyProjectContext(forged));
  const extra = structuredClone(context);
  extra.payload.extra = "forbidden";
  extra.digest = createEnvelope({ object_type: extra.object_type, schema_version: extra.schema_version, payload: extra.payload }).digest;
  assert.throws(() => verifyProjectContext(extra));
});

test("remote lock plan is exact-release bound and applies only the reviewed candidate", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = createRemoteLockPlan({
    projectConfigDigest: digest("a"),
    existingLockDigest: digestProjectLock(current),
    targetReleaseDigest: digest("c"),
    current,
    candidate,
  });
  assert.equal(plan.payload.target_release_digest, digest("c"));
  assert.deepEqual(plan.payload.changes, [{ skill_ref: "ega/alpha", old_version: digest("a"), new_version: digest("b") }]);
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-"));
  const path = join(dir, ".egaskills.lock");
  applyRemoteLockPlan(plan, path);
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")));
});
