// Unpublished experiment derived from verified canonical release inputs.
// Reuse the Contract C importer/builder; never mutate published registry rows.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheBlobPathForHash, openRegistry, prepareSkillRoot } from "../../packages/registry/dist/index.js";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import { loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";

export const BASE_DIGEST = "sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The first three deltas match owned source PR skills#8 at da7fe7e6.
// The fourth is an explicitly declared local overlay on mattpocock/pr;
// it is not an upstream change, catalog adoption, or publication.
export const PATCHES = {
  "egawilldoit/get-pr-comments": { domains: [] },
  "egawilldoit/design-architecture": { domains: [] },
  "egawilldoit/certify-production-target": { appendTrigger: "prove this is really live" },
  "mattpocock/pr": { anti_triggers: ["release readiness"] },
};

export async function buildRoutingCandidate() {
  const baseline = join(ROOT, "packages/mcp/artifact");
  const original = loadHostedReleaseSnapshot(baseline);
  assert.equal(original.releaseDigest, BASE_DIGEST);
  const hub = await mkdtemp(join(tmpdir(), "ega-routing-source-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: baseline }, readonly: true });
  const namespaces = new Set();
  try {
    for (const [id, version] of Object.entries(original.release.payload.skill_versions)) {
      const [namespace, name] = id.split("/");
      namespaces.add(namespace);
      const root = join(hub, "owned", namespace, name);
      const row = registry.db.prepare("SELECT manifest_json FROM skill_versions WHERE skill_id = ? AND version_hash = ?").get(id, version);
      assert.ok(row, `missing manifest ${id}`);
      const manifest = JSON.parse(row.manifest_json);
      for (const file of manifest.files) {
        const target = resolve(root, file.path);
        assert.ok(target.startsWith(`${root}/`), "manifest path escapes skill");
        const bytes = await readFile(cacheBlobPathForHash(join(baseline, "cache/sha256"), file.blob_hash));
        assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, file.blob_hash);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const metadata = { schema_version: 1, ...manifest.routing };
      await writeFile(join(root, "ega.yaml"), JSON.stringify(metadata));
      // Prove source reconstruction preserves every original SkillVersion.
      assert.equal((await prepareSkillRoot(root, namespace)).versionHash, version, id);
      const patch = PATCHES[id];
      if (patch) {
        if (patch.domains) metadata.domains = patch.domains;
        if (patch.anti_triggers) metadata.anti_triggers = patch.anti_triggers;
        if (patch.appendTrigger) metadata.triggers = [...metadata.triggers, patch.appendTrigger];
        await writeFile(join(root, "ega.yaml"), JSON.stringify(metadata));
      }
    }
  } finally {
    registry.close();
  }
  const json = (path, value) => writeFile(join(hub, path), JSON.stringify(value));
  await json("hub.yaml", { schema_version: 1, hub: { id: "routing-experiment" }, owned: [...namespaces].sort().map(namespace => ({ path: `owned/${namespace}`, namespace })), external: [] });
  await json("sources.yaml", { schema_version: 1, sources: {} });
  await json("sources.lock.yaml", { schema_version: 1, sources: {} });
  const built = await buildHubRelease(hub);
  const candidate = loadHostedReleaseSnapshot(built.registryHome);
  assert.notEqual(candidate.releaseDigest, BASE_DIGEST);
  const changed = built.skills.filter(skill => original.release.payload.skill_versions[skill.skillId] !== skill.versionHash).map(skill => skill.skillId).sort();
  assert.deepEqual(changed, Object.keys(PATCHES).sort());
  await writeFile(join(built.registryHome, "routing-experiment.json"), JSON.stringify({ baseline: BASE_DIGEST, candidate: candidate.releaseDigest, source: "verified baseline manifests and content-addressed blobs", ownedSourcePR: "https://github.com/egawilldoit/skills/pull/8", ownedSourceHead: "da7fe7e6cb7f85397ed0fee30ed81ad164ec52fe", patches: PATCHES, changed }, null, 2));
  return { artifactDir: built.registryHome, digest: candidate.releaseDigest, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildRoutingCandidate()));
}
