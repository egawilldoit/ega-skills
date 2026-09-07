import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHub,
  createHubRelease,
  discoverUnselectedSkills,
  extractSelectedRoots,
  fetchRefTip,
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
