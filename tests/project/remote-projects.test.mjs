import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRemoteLockPlan,
  createProjectContext,
  createRemoteLockPlan,
  digestProjectLock,
  hashNormalizedConfig,
  parseProjectConfig,
  verifyProjectContext,
} from "../../packages/project/dist/index.js";
import { createEnvelope } from "../../packages/hashing/dist/index.js";
import { runRemoteLockApply } from "../../packages/cli/dist/index.js";

const digest = (hex) => `sha256:${hex.repeat(64 / hex.length)}`;
const lock = (skill, version, configHash = digest("a")) => ({
  lockfile_version: 1,
  token_estimator: "ega-o200k-v1",
  generated_from: { config_hash: configHash },
  skills: { [skill]: { name: skill.split("/")[1], version_hash: digest(version) } },
});

function planFor({ current, candidate, configDigest = digest("a") }) {
  return createRemoteLockPlan({
    projectConfigDigest: configDigest,
    existingLockDigest: digestProjectLock(current),
    targetReleaseDigest: digest("c"),
    current,
    candidate,
  });
}

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
  const plan = planFor({ current, candidate });
  assert.equal(plan.payload.target_release_digest, digest("c"));
  assert.deepEqual(plan.payload.changes, [{ skill_ref: "ega/alpha", old_version: digest("a"), new_version: digest("b") }]);
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-"));
  const path = join(dir, ".egaskills.lock");
  applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("a") });
  assert.match(readFileSync(path, "utf8"), new RegExp(digest("b")));
});

test("remote lock apply rejects a stale existing lock and preserves it", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const dir = mkdtempSync(join(tmpdir(), "ega-remote-lock-stale-"));
  const path = join(dir, ".egaskills.lock");
  const newer = lock("ega/alpha", "d");
  writeFileSync(path, `${JSON.stringify(newer, null, 2)}\n`);
  const before = readFileSync(path);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: newer, projectConfigDigest: digest("a") }),
    /existing lock does not match/,
  );
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(dir), [".egaskills.lock"], "no temp files may remain");
});

test("remote lock apply rejects a plan for a different project config", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const path = join(mkdtempSync(join(tmpdir(), "ega-remote-lock-config-")), ".egaskills.lock");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  const before = readFileSync(path);

  assert.throws(
    () => applyRemoteLockPlan(plan, path, { currentLock: current, projectConfigDigest: digest("f") }),
    /project config does not match/,
  );
  assert.deepEqual(readFileSync(path), before);
});

test("remote lock apply rejects a transition that is not completely described", () => {
  const current = lock("ega/alpha", "a");
  current.skills["ega/beta"] = { name: "beta", version_hash: digest("e") };
  const candidate = lock("ega/alpha", "b");
  candidate.skills["ega/beta"] = { name: "beta", version_hash: digest("f") };
  const plan = createRemoteLockPlan({
    projectConfigDigest: digest("a"),
    existingLockDigest: digestProjectLock(current),
    targetReleaseDigest: digest("c"),
    current,
    candidate,
  });
  assert.equal(plan.payload.changes.length, 2);

  const subset = structuredClone(plan);
  subset.payload.changes = subset.payload.changes.filter((change) => change.skill_ref === "ega/alpha");
  subset.digest = createEnvelope({ object_type: subset.object_type, schema_version: subset.schema_version, payload: subset.payload }).digest;
  const path = join(mkdtempSync(join(tmpdir(), "ega-remote-lock-subset-")), ".egaskills.lock");
  assert.throws(
    () => applyRemoteLockPlan(subset, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /completely describe/,
  );
});

test("remote lock apply locates the discovered project boundary from a nested directory", () => {
  const base = mkdtempSync(join(tmpdir(), "ega-remote-lock-boundary-"));
  const project = join(base, "project");
  const nested = join(project, "packages", "app");
  mkdirSync(nested, { recursive: true });
  const configText = "schema_version: 1\n";
  writeFileSync(join(project, ".egaskills.yaml"), configText);
  const configDigest = hashNormalizedConfig(parseProjectConfig(configText));
  const current = lock("ega/alpha", "a", configDigest);
  const candidate = lock("ega/alpha", "b", configDigest);
  writeFileSync(join(project, ".egaskills.lock"), `${JSON.stringify(current, null, 2)}\n`);
  const plan = planFor({ current, candidate, configDigest });
  const planPath = join(base, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const result = runRemoteLockApply({ plan: planPath, project: nested });
  assert.equal(result.path, join(project, ".egaskills.lock"));
  assert.match(readFileSync(join(project, ".egaskills.lock"), "utf8"), new RegExp(digest("b")));
  assert.deepEqual(readdirSync(nested), [], "nested invocation must not write a lock");
});

test("remote lock apply rejects forged or malformed change summaries", () => {
  const current = lock("ega/alpha", "a");
  const candidate = lock("ega/alpha", "b");
  const plan = planFor({ current, candidate });
  const path = join(mkdtempSync(join(tmpdir(), "ega-remote-lock-invalid-")), ".egaskills.lock");
  const forged = structuredClone(plan);
  forged.payload.changes[0].new_version = digest("d");
  forged.digest = createEnvelope({ object_type: forged.object_type, schema_version: forged.schema_version, payload: forged.payload }).digest;
  assert.throws(
    () => applyRemoteLockPlan(forged, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /does not match candidate lock/,
  );

  const extra = structuredClone(plan);
  extra.payload.changes[0].unexpected = true;
  extra.digest = createEnvelope({ object_type: extra.object_type, schema_version: extra.schema_version, payload: extra.payload }).digest;
  assert.throws(
    () => applyRemoteLockPlan(extra, path, { currentLock: current, projectConfigDigest: digest("a") }),
    /unknown or missing fields/,
  );
});
