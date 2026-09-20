import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../../packages/hashing/dist/index.js";
import { buildHubRelease, createArtifactCandidate, writeArtifactCandidate } from "../../packages/project/dist/index.js";
import {
  createHostedMcpHandler,
  createHostedRuntimeFromEnv,
  createRetainedManifest,
  loadRetainedReleaseSet,
  promoteRetainedRelease,
  rollbackRetainedRelease,
} from "../../packages/mcp/dist/index.js";

function makeHub(skill, body) {
  const hubDir = mkdtempSync(join(tmpdir(), `ega-retained-${skill}-`));
  const skillDir = join(hubDir, "owned", "ega", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} retained skill.\n---\n\n${body}\n`);
  writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${skill}\n`);
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: retained-test\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

function packageDigest(artifactDir) {
  return `sha256:${sha256Hex(readFileSync(join(artifactDir, "release-package.json")))}`;
}

const buildR1 = await buildHubRelease(makeHub("alpha", "Use alpha from retained R1."));
const buildR2 = await buildHubRelease(makeHub("beta", "Use beta from retained R2."));
const root = mkdtempSync(join(tmpdir(), "ega-retained-bundle-"));
const r1Dir = join(root, "r1");
const r2Dir = join(root, "r2");
writeArtifactCandidate(buildR1, r1Dir, createArtifactCandidate(buildR1));
writeArtifactCandidate(buildR2, r2Dir, createArtifactCandidate(buildR2));
const manifestPath = join(root, "retained-manifest.json");
const r1 = createHostedSnapshot(r1Dir);
const r2 = createHostedSnapshot(r2Dir);

function createHostedSnapshot(artifactDir) {
  return JSON.parse(readFileSync(join(artifactDir, "hub-release.json"), "utf8"));
}

function entry(artifactPath, release) {
  return {
    artifact_path: artifactPath,
    candidate_digest: JSON.parse(readFileSync(join(root, artifactPath, "candidate.json"), "utf8")).digest,
    release_digest: release.digest,
    release_package_digest: packageDigest(join(root, artifactPath)),
  };
}

writeFileSync(manifestPath, `${JSON.stringify(createRetainedManifest({
  hub_id: "retained-test",
  publication_revision: 1,
  deployment_id: "deploy-r1",
  default_release_digest: r1.digest,
  releases: [entry("r1", r1), entry("r2", r2)],
}), null, 2)}\n`);

function writeTestManifest(path, revision = 1, deploymentId = "deploy-r1", defaultRelease = r1) {
  writeFileSync(path, `${JSON.stringify(createRetainedManifest({
    hub_id: "retained-test",
    publication_revision: revision,
    deployment_id: deploymentId,
    default_release_digest: defaultRelease.digest,
    releases: [entry("r1", r1), entry("r2", r2)],
  }), null, 2)}\n`);
}

async function waitForFile(path) {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnRetainedChild({ manifest, action = "promote", deploymentId, expectedRevision = 1, barrier, marker, release, result }) {
  const script = `
    import { writeFileSync } from "node:fs";
    import { promoteRetainedRelease, rollbackRetainedRelease } from "./packages/mcp/dist/index.js";
    const options = {
      manifestPath: process.env.EGA_TEST_MANIFEST,
      candidatePath: process.env.EGA_TEST_CANDIDATE,
      candidateDigest: process.env.EGA_TEST_CANDIDATE_DIGEST,
      expectedRevision: Number(process.env.EGA_TEST_EXPECTED_REVISION),
      deploymentId: process.env.EGA_TEST_DEPLOYMENT,
      legacy: true,
    };
    try {
      const value = process.env.EGA_TEST_ACTION === "rollback"
        ? rollbackRetainedRelease({ ...options, releaseDigest: process.env.EGA_TEST_RELEASE_DIGEST })
        : promoteRetainedRelease(options);
      writeFileSync(process.env.EGA_TEST_RESULT, JSON.stringify({ ok: true, revision: value.payload.publication_revision, defaultRelease: value.payload.default_release_digest }));
    } catch (error) {
      writeFileSync(process.env.EGA_TEST_RESULT, JSON.stringify({ ok: false, code: error?.code, message: String(error?.message ?? error) }));
      process.exitCode = 1;
    }
  `;
  const env = {
    ...process.env,
    EGA_TEST_MANIFEST: manifest,
    EGA_TEST_ACTION: action,
    EGA_TEST_CANDIDATE: join(root, action === "rollback" ? "r1/candidate.json" : "r2/candidate.json"),
    EGA_TEST_CANDIDATE_DIGEST: JSON.parse(readFileSync(join(root, action === "rollback" ? "r1" : "r2", "candidate.json"), "utf8")).digest,
    EGA_TEST_EXPECTED_REVISION: String(expectedRevision),
    EGA_TEST_DEPLOYMENT: deploymentId,
    EGA_TEST_RELEASE_DIGEST: r1.digest,
    EGA_TEST_RESULT: result,
  };
  if (barrier) {
    env.EGA_TEST_RETAINED_BARRIER = barrier;
    env.EGA_TEST_RETAINED_BARRIER_MARKER = marker;
    env.EGA_TEST_RETAINED_BARRIER_RELEASE = release;
  }
  return spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
}

function waitForChild(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function rpc(handler, id, name, args) {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "http://localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text).result;
}

test("RL-04 retained promotion is revision-CAS protected and rollback is monotonic", () => {
  const r1CandidateDigest = JSON.parse(readFileSync(join(r1Dir, "candidate.json"), "utf8")).digest;
  const r2CandidateDigest = JSON.parse(readFileSync(join(r2Dir, "candidate.json"), "utf8")).digest;
  assert.throws(
    () => promoteRetainedRelease({ manifestPath, candidatePath: join(r2Dir, "candidate.json"), candidateDigest: r2CandidateDigest, expectedRevision: 1, deploymentId: "missing-governance" }),
    /new retained promotions require a governed release candidate/,
  );
  assert.throws(
    () => promoteRetainedRelease({ manifestPath, candidatePath: join(r2Dir, "candidate.json"), candidateDigest: r1CandidateDigest, expectedRevision: 1, deploymentId: "wrong-binding", legacy: true }),
    /promotion candidate digest does not match candidate.json/,
  );
  const promoted = promoteRetainedRelease({
    manifestPath,
    candidatePath: join(r2Dir, "candidate.json"),
    candidateDigest: r2CandidateDigest,
    expectedRevision: 1,
    deploymentId: "deploy-r2",
    legacy: true,
  });
  assert.equal(promoted.payload.default_release_digest, r2.digest);
  assert.equal(promoted.payload.publication_revision, 2);
  assert.equal(promoted.payload.deployment_id, "deploy-r2");
  assert.throws(
    () => promoteRetainedRelease({ manifestPath, candidatePath: join(r1Dir, "candidate.json"), candidateDigest: r1CandidateDigest, expectedRevision: 1, deploymentId: "old-job", legacy: true }),
    /retained manifest revision is stale|retained manifest changed during promotion/,
  );

  const rolledBack = rollbackRetainedRelease({
    manifestPath,
    candidatePath: join(r1Dir, "candidate.json"),
    candidateDigest: r1CandidateDigest,
    releaseDigest: r1.digest,
    expectedRevision: 2,
    deploymentId: "deploy-r3-rollback",
    legacy: true,
  });
  assert.equal(rolledBack.payload.default_release_digest, r1.digest);
  assert.equal(rolledBack.payload.publication_revision, 3);
  assert.equal(rolledBack.payload.deployment_id, "deploy-r3-rollback");
  assert.equal(loadRetainedReleaseSet(manifestPath).defaultSnapshot.releaseDigest, r1.digest);
});

test("W6: owner-token reclaim cannot remove a replacement owner", async () => {
  const localManifest = join(root, "owner-reclaim-manifest.json");
  writeTestManifest(localManifest);
  const lockPath = `${localManifest}.lock`;
  const staleToken = "a".repeat(64);
  const deadOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitForChild(deadOwner);
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, `owner.${staleToken}`), JSON.stringify({ pid: deadOwner.pid, token: staleToken }));
  const markerA = join(root, "owner-a.marker");
  const releaseA = join(root, "owner-a.release");
  const resultA = join(root, "owner-a.result");
  const childA = spawnRetainedChild({ manifest: localManifest, deploymentId: "owner-a", barrier: "AFTER_LOCK", marker: markerA, release: releaseA, result: resultA });
  await waitForFile(markerA);
  const owners = readdirSync(lockPath).filter((name) => name.startsWith("owner."));
  assert.equal(owners.length, 1);
  const resultB = join(root, "owner-b.result");
  const childB = spawnRetainedChild({ manifest: localManifest, deploymentId: "owner-b", result: resultB });
  await waitForFile(resultB);
  const b = JSON.parse(readFileSync(resultB, "utf8"));
  assert.equal(b.ok, false);
  assert.equal(b.code, "E_RETAINED_LOCKED");
  assert.equal(existsSync(join(lockPath, owners[0])), true);
  writeFileSync(releaseA, "continue\n");
  const [exitA, exitB] = await Promise.all([waitForChild(childA), waitForChild(childB)]);
  assert.equal(exitA.signal, null);
  assert.equal(exitB.code, 1);
  assert.equal(JSON.parse(readFileSync(resultA, "utf8")).ok, true);
  assert.equal(existsSync(lockPath), false);
});

test("W6: concurrent promotion and rollback produce one monotonic transition", async () => {
  const localManifest = join(root, "concurrent-manifest.json");
  writeTestManifest(localManifest);
  const resultPromotion = join(root, "concurrent-promotion.result");
  const resultRollback = join(root, "concurrent-rollback.result");
  const promotion = spawnRetainedChild({ manifest: localManifest, deploymentId: "concurrent-promotion", result: resultPromotion });
  const rollback = spawnRetainedChild({ manifest: localManifest, action: "rollback", deploymentId: "concurrent-rollback", result: resultRollback });
  await Promise.all([waitForFile(resultPromotion), waitForFile(resultRollback), waitForChild(promotion), waitForChild(rollback)]);
  const results = [JSON.parse(readFileSync(resultPromotion, "utf8")), JSON.parse(readFileSync(resultRollback, "utf8"))];
  assert.equal(results.filter((result) => result.ok).length, 1);
  const loser = results.find((result) => !result.ok);
  assert.ok(loser);
  assert.ok(["E_RETAINED_LOCKED", "E_RETAINED_STALE"].includes(loser.code), JSON.stringify(loser));
  const final = loadRetainedReleaseSet(localManifest).manifest;
  assert.equal(final.payload.publication_revision, 2);
  assert.ok([r1.digest, r2.digest].includes(final.payload.default_release_digest));
});

test("W6: killed promotion is recovered before and after the durable pointer write", async () => {
  const beforeManifest = join(root, "killed-before-manifest.json");
  writeTestManifest(beforeManifest);
  const beforeMarker = join(root, "killed-before.marker");
  const beforeResult = join(root, "killed-before.result");
  const before = spawnRetainedChild({ manifest: beforeManifest, deploymentId: "killed-before", barrier: "BEFORE_POINTER_WRITE", marker: beforeMarker, release: join(root, "unused-before.release"), result: beforeResult });
  await waitForFile(beforeMarker);
  before.kill("SIGKILL");
  const beforeExit = await waitForChild(before);
  assert.equal(beforeExit.signal, "SIGKILL");
  const recoveredBefore = promoteRetainedRelease({
    manifestPath: beforeManifest,
    candidatePath: join(r2Dir, "candidate.json"),
    candidateDigest: JSON.parse(readFileSync(join(r2Dir, "candidate.json"), "utf8")).digest,
    expectedRevision: 1,
    deploymentId: "recovered-before",
    legacy: true,
  });
  assert.equal(recoveredBefore.payload.publication_revision, 2);

  const afterManifest = join(root, "killed-after-manifest.json");
  writeTestManifest(afterManifest);
  const afterMarker = join(root, "killed-after.marker");
  const afterResult = join(root, "killed-after.result");
  const after = spawnRetainedChild({ manifest: afterManifest, deploymentId: "retry-after", barrier: "AFTER_POINTER_WRITE", marker: afterMarker, release: join(root, "unused-after.release"), result: afterResult });
  await waitForFile(afterMarker);
  assert.equal(loadRetainedReleaseSet(afterManifest).manifest.payload.publication_revision, 2);
  after.kill("SIGKILL");
  const afterExit = await waitForChild(after);
  assert.equal(afterExit.signal, "SIGKILL");
  const retried = promoteRetainedRelease({
    manifestPath: afterManifest,
    candidatePath: join(r2Dir, "candidate.json"),
    candidateDigest: JSON.parse(readFileSync(join(r2Dir, "candidate.json"), "utf8")).digest,
    expectedRevision: 1,
    deploymentId: "retry-after",
    legacy: true,
  });
  assert.equal(retried.payload.publication_revision, 2);
  assert.equal(loadRetainedReleaseSet(afterManifest).manifest.payload.publication_revision, 2);
});

test("RL-05 exact retained/default selection never falls back", async () => {
  const set = loadRetainedReleaseSet(manifestPath);
  assert.equal(set.defaultSnapshot.releaseDigest, r1.digest);
  const handler = createHostedMcpHandler(set.defaultSnapshot, {
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async () => true,
    resolveStableRelease: async () => loadRetainedReleaseSet(manifestPath).defaultSnapshot,
    resolveRelease: async (digest) => loadRetainedReleaseSet(manifestPath).snapshots.get(digest) ?? Promise.reject(new Error("unknown retained release")),
  });
  const pinned = await rpc(handler, 1, "search", { query: "beta", release_digest: r2.digest });
  assert.notEqual(pinned.isError, true, JSON.stringify(pinned));
  assert.match(JSON.stringify(pinned), /ega\/beta/);
  const unknown = await rpc(handler, 2, "search", { query: "alpha", release_digest: `sha256:${"0".repeat(64)}` });
  assert.equal(unknown.isError, true, JSON.stringify(unknown));
  assert.doesNotMatch(JSON.stringify(unknown), /Use alpha from retained R1/);
});

test("RL-06 deny policy applies to retained explicit releases", async () => {
  const set = loadRetainedReleaseSet(manifestPath);
  const handler = createHostedMcpHandler(set.defaultSnapshot, {
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async () => true,
    deniedReleases: new Set([r1.digest]),
    resolveRelease: async (digest) => set.snapshots.get(digest) ?? Promise.reject(new Error("unknown retained release")),
  });
  const denied = await rpc(handler, 1, "inspect", { skill_id: "ega/alpha", release_digest: r1.digest });
  assert.equal(denied.isError, true, JSON.stringify(denied));
  assert.match(JSON.stringify(denied), /E_UNAUTHORIZED/);
});

test("RL-07 one request keeps its selected snapshot across a default swap", async () => {
  const set = loadRetainedReleaseSet(manifestPath);
  let current = set.snapshots.get(r1.digest);
  let signalSelectionStarted;
  const selectionStarted = new Promise((resolve) => {
    signalSelectionStarted = resolve;
  });
  let continueSelection;
  const selectionPaused = new Promise((resolve) => {
    continueSelection = resolve;
  });
  const handler = createHostedMcpHandler(current, {
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async () => true,
    resolveStableRelease: async () => {
      const selected = current;
      signalSelectionStarted();
      await selectionPaused;
      return selected;
    },
  });
  const inFlight = rpc(handler, 1, "search", { query: "alpha" });
  await selectionStarted;
  current = set.snapshots.get(r2.digest);
  continueSelection();
  const first = await inFlight;
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.match(JSON.stringify(first), /ega\/alpha/);
  assert.doesNotMatch(JSON.stringify(first), /ega\/beta/);
});

test("retained manifest wiring supports a runtime with no mutable artifact default", async () => {
  const runtime = createHostedRuntimeFromEnv({
    EGA_HOSTED_RETAINED_MANIFEST: manifestPath,
    EGA_HOSTED_AUTHZ_JSON: JSON.stringify({
      workspace_id: "retained-workspace",
      visibility: "private",
      owner_subject: "local-smoke",
      memberships: [{ subject: "local-smoke", role: "owner", active: true }],
      denies: [],
    }),
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    EGA_HOSTED_BEARER_TOKEN: "test-token",
    EGA_HOSTED_ALLOW_STATIC_TOKEN: "true",
  });
  const defaultSearch = await rpc(runtime.handler, 1, "search", { query: "alpha" });
  assert.notEqual(defaultSearch.isError, true, JSON.stringify(defaultSearch));
  assert.match(JSON.stringify(defaultSearch), /ega\/alpha/);
  const exactR2 = await rpc(runtime.handler, 2, "search", { query: "beta", release_digest: r2.digest });
  assert.notEqual(exactR2.isError, true, JSON.stringify(exactR2));
  assert.match(JSON.stringify(exactR2), /ega\/beta/);
});
