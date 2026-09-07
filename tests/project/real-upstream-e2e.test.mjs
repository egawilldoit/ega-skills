import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHub,
  buildHubRelease,
  createHubRelease,
  discoverUnselectedSkills,
  extractSelectedRoots,
  fetchExactCommit,
  fetchRefTip,
  applyUpdatePlan,
  checkForUpdates,
  parseSourcesYaml,
  resolveRefToCommit,
  sourceConfigDigest,
  verifyHubRelease,
} from "../../packages/project/dist/index.js";

const enabled = process.env.EGA_REAL_UPSTREAM === "1";

// The current Cursor repository's typescript-best-practices skill carries the
// frozen V1-unsupported `paths` field. Strict import rejects it; this harness
// deliberately selects two other current Cursor skills and preserves their
// upstream bytes without normalization.
const SOURCES = [
  {
    id: "cursor-pstack",
    repository: "https://github.com/cursor/plugins",
    namespace: "cursor",
    roots: ["pstack/skills/architect", "pstack/skills/setup-pstack"],
    provenance: ["pstack/LICENSE"],
  },
  {
    id: "mattpocock",
    repository: "https://github.com/mattpocock/skills",
    namespace: "mattpocock",
    roots: ["skills/engineering/code-review", "skills/engineering/tdd", "skills/productivity/grilling"],
    provenance: ["LICENSE"],
  },
];

test("real Matt and Cursor upstream corpus builds a release", { skip: !enabled }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "ega-real-upstream-"));
  const hubDir = join(workspace, "hub");
  mkdirSync(join(hubDir, "owned", "ega", "real-e2e"), { recursive: true });
  writeFileSync(
    join(hubDir, "owned", "ega", "real-e2e", "SKILL.md"),
    "---\nname: real-e2e\ndescription: Real upstream release acceptance skill.\n---\n\nAcceptance fixture.\n",
  );
  writeFileSync(join(hubDir, "owned", "ega", "real-e2e", "ega.yaml"), "schema_version: 1\n");

  const configs = Object.fromEntries(
    SOURCES.map((source) => [
      source.id,
      {
        type: "git",
        repository: source.repository,
        ref: "main",
        namespace: source.namespace,
        selection: { roots: source.roots },
        provenance_files: source.provenance,
      },
    ]),
  );
  const parsed = parseSourcesYaml(JSON.stringify({ schema_version: 1, sources: configs }));
  const locks = {};
  const observations = {};
  for (const source of SOURCES) {
    const config = parsed.sources[source.id];
    const commit = resolveRefToCommit(source.repository, "main");
    const fetched = join(workspace, `${source.id}-fetched`);
    fetchRefTip(source.repository, "main", commit, fetched);
    const treeDir = join(hubDir, "trees", source.id);
    mkdirSync(treeDir, { recursive: true });
    const tree = extractSelectedRoots(fetched, source.roots, source.provenance, treeDir);
    const unselected = discoverUnselectedSkills(fetched, source.roots);
    assert.ok(unselected.length > 0, `${source.id} must report unselected upstream skills`);
    locks[source.id] = {
      source_config_digest: sourceConfigDigest(config),
      repository: source.repository,
      requested_ref: "main",
      namespace: source.namespace,
      selection: { roots: source.roots },
      provenance_files: source.provenance,
      resolved_commit: commit,
      selected_skill_tree_digest: tree.treeDigest,
      vendored_snapshot_digest: tree.snapshotDigest,
      extraction_contract: 1,
    };
    observations[source.id] = { commit, selected: tree.treeDigest, snapshot: tree.snapshotDigest, unselected: unselected.length };
  }

  writeFileSync(
    join(hubDir, "hub.yaml"),
    JSON.stringify({
      schema_version: 1,
      hub: { id: "personal" },
      owned: [{ path: "owned/ega", namespace: "ega" }],
      external: SOURCES.map(({ id: sourceId }) => ({ source: sourceId })),
    }),
  );
  writeFileSync(join(hubDir, "sources.yaml"), JSON.stringify({ schema_version: 1, sources: configs }));
  writeFileSync(join(hubDir, "sources.lock.yaml"), JSON.stringify({ schema_version: 1, sources: locks }));

  const build = await buildHub(hubDir);
  assert.deepEqual(
    build.skills.map(({ skillId }) => skillId),
    [
      "cursor/architect",
      "cursor/setup-pstack",
      "ega/real-e2e",
      "mattpocock/code-review",
      "mattpocock/grilling",
      "mattpocock/tdd",
    ],
  );
  const release = createHubRelease(build);
  verifyHubRelease(release);
  assert.equal(Object.keys(release.payload.skill_versions).length, 6);
  assert.deepEqual(
    Object.fromEntries(build.adoptedSources.map((source) => [source.sourceId, source.resolvedCommit])),
    Object.fromEntries(Object.entries(observations).map(([id, value]) => [id, value.commit])),
  );
  process.stdout.write(`real-upstream-observations ${JSON.stringify(observations)}\n`);
});

test("real upstream A-to-B-to-C lifecycle applies the approved commit", { skip: !enabled }, async () => {
  // These are immutable commits from the Matt Pocock upstream observed by
  // the release candidate. The local bare mirror controls only the tracked
  // ref, allowing the test to reproduce B -> C after approval without
  // inventing source bytes.
  const commitA = "5c89081d4bbeb3d039a42093653f90bb698d780e";
  const commitB = "6a34259e99bc5fed4f8fe5da61c273dad14edf67";
  const commitC = "3cca18b368ae95cdbdebbff572ccafa662551015";
  const source = {
    id: "matt-lifecycle",
    repository: "https://github.com/mattpocock/skills",
    namespace: "mattpocock",
    roots: ["skills/engineering/code-review", "skills/engineering/tdd"],
    provenance: ["LICENSE"],
  };
  const workspace = mkdtempSync(join(tmpdir(), "ega-real-lifecycle-"));
  const mirror = join(workspace, "matt.git");
  execFileSync("git", ["clone", "--quiet", "--bare", source.repository, mirror], { stdio: "pipe" });
  assert.doesNotThrow(() => execFileSync("git", ["-C", mirror, "cat-file", "-e", `${commitC}^{commit}`], { stdio: "pipe" }));
  execFileSync("git", ["-C", mirror, "update-ref", "refs/heads/main", commitB], { stdio: "pipe" });

  const hubDir = join(workspace, "hub");
  mkdirSync(join(hubDir, "owned", "ega", "real-e2e"), { recursive: true });
  writeFileSync(
    join(hubDir, "owned", "ega", "real-e2e", "SKILL.md"),
    "---\nname: real-e2e\ndescription: Real upstream lifecycle acceptance skill.\n---\n\nAcceptance fixture.\n",
  );
  writeFileSync(join(hubDir, "owned", "ega", "real-e2e", "ega.yaml"), "schema_version: 1\n");
  const config = {
    type: "git",
    repository: mirror,
    ref: "main",
    namespace: source.namespace,
    selection: { roots: source.roots },
    provenance_files: source.provenance,
  };
  const parsed = parseSourcesYaml(JSON.stringify({ schema_version: 1, sources: { [source.id]: config } }));
  const fetchedA = join(workspace, "fetched-a");
  const treeA = join(hubDir, "trees", source.id);
  mkdirSync(treeA, { recursive: true });
  fetchExactCommit(mirror, commitA, fetchedA);
  const extractedA = extractSelectedRoots(fetchedA, source.roots, source.provenance, treeA);
  const lock = {
    schema_version: 1,
    sources: {
      [source.id]: {
        source_config_digest: sourceConfigDigest(parsed.sources[source.id]),
        repository: mirror,
        requested_ref: "main",
        namespace: source.namespace,
        selection: { roots: source.roots },
        provenance_files: source.provenance,
        resolved_commit: commitA,
        selected_skill_tree_digest: extractedA.treeDigest,
        vendored_snapshot_digest: extractedA.snapshotDigest,
        extraction_contract: 1,
      },
    },
  };
  writeFileSync(join(hubDir, "hub.yaml"), JSON.stringify({
    schema_version: 1,
    hub: { id: "personal" },
    owned: [{ path: "owned/ega", namespace: "ega" }],
    external: [{ source: source.id }],
  }));
  writeFileSync(join(hubDir, "sources.yaml"), JSON.stringify({ schema_version: 1, sources: { [source.id]: config } }));
  writeFileSync(join(hubDir, "sources.lock.yaml"), JSON.stringify(lock));

  const release1 = await buildHubRelease(hubDir);
  const release1ReleaseBytes = readFileSync(release1.artifactPaths.release);
  const release1FtsBytes = readFileSync(join(release1.registryHome, "registry.sqlite"));
  const adoptedVersions = Object.fromEntries(release1.skills.map(({ skillId, versionHash }) => [skillId, versionHash]));
  const checksDir = join(workspace, "checks");
  mkdirSync(checksDir);
  const checked = await checkForUpdates({
    sourceId: source.id,
    config: parsed.sources[source.id],
    adopted: {
      commit: commitA,
      treeDigest: extractedA.treeDigest,
      snapshotDigest: extractedA.snapshotDigest,
      versions: adoptedVersions,
    },
    workDir: checksDir,
  });
  assert.equal(checked.status, "UPDATE_AVAILABLE");
  assert.equal(checked.plan.payload.target_commit, commitB);
  const approvedPlanDigest = checked.plan.digest;
  const fetchedB = join(workspace, "fetched-b");
  const stageB = join(workspace, "stage-b");
  fetchExactCommit(mirror, commitB, fetchedB);
  extractSelectedRoots(fetchedB, source.roots, source.provenance, stageB);

  execFileSync("git", ["-C", mirror, "update-ref", "refs/heads/main", commitC], { stdio: "pipe" });
  assert.equal(resolveRefToCommit(mirror, "main"), commitC);
  await applyUpdatePlan({ hubDir, plan: checked.plan, stageDir: stageB });
  const release2 = await buildHubRelease(hubDir);
  assert.equal(release2.adoptedSources.find(({ sourceId }) => sourceId === source.id)?.resolvedCommit, commitB);
  assert.notEqual(release2.release.digest, release1.release.digest);
  assert.deepEqual(readFileSync(release1.artifactPaths.release), release1ReleaseBytes);
  assert.deepEqual(readFileSync(join(release1.registryHome, "registry.sqlite")), release1FtsBytes);
  assert.equal(approvedPlanDigest, checked.plan.digest);
  process.stdout.write(`real-upstream-lifecycle ${JSON.stringify({ commitA, commitB, commitC, approvedPlanDigest })}\n`);
});
