// Read-only I1 projection for a new, pinned Git intake. No candidate,
// approval, release artifact or canonical Hub mutation is produced.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createImportPlan, emptyRegistryTarget, importSkills, listSkillVersions, openRegistry } from "@ega-skills/registry";
import { acquireSource, releaseAcquiredSource } from "../intake/acquire.js";
import { readHubIntakeState, verifyAdoptionPlan, verifyAdoptionStage, type AdoptionPlanDocument } from "../intake/adoption-plan.js";
import { buildHub, type HubBuildResult } from "./builder.js";
import { HubError } from "./errors.js";
import { validateInvocationPolicy, type InvocationPolicy } from "./invocation-policy.js";
import { createInvocationRelease, type InvocationHubRelease } from "./invocation-release.js";
import { adoptedSourcePath } from "./paths.js";
import { digestStagedTree } from "./quarantine.js";
import { createHubRelease, verifyHubRelease, type HubRelease, type ReleaseArtifacts } from "./release.js";
import { deriveAliasMap, deriveSearchIndexInput, deriveTokenArtifact } from "./release-state.js";
import { sourceConfigDigest, type SourceConfig } from "./sources-config.js";

function artifacts(build: HubBuildResult): ReleaseArtifacts {
  return { aliasMap: deriveAliasMap(build), searchIndexInput: deriveSearchIndexInput(build), tokenArtifact: deriveTokenArtifact(build) };
}
function fail(message: string): never { throw new HubError("E_BUILD_ATTESTATION", message); }

/** Reacquire the pinned Git input and derive only an in-memory semantic identity. */
export async function projectInvocationRelease(input: { hubDir: string; baseline: HubRelease; plan: AdoptionPlanDocument; policy: InvocationPolicy }): Promise<InvocationHubRelease> {
  const plan = verifyAdoptionPlan(input.plan);
  const policy = validateInvocationPolicy(input.policy);
  verifyHubRelease(input.baseline);
  const state = readHubIntakeState(input.hubDir);
  if (plan.payload.status !== "READY" || plan.payload.diagnostics.length || state.baselineDigest !== plan.payload.hub.baseline_digest ||
      JSON.stringify(state.sourceIds) !== JSON.stringify(plan.payload.hub.source_ids) || JSON.stringify(state.namespaces) !== JSON.stringify(plan.payload.hub.namespaces)) fail("stale or blocked adoption plan");
  const source = plan.payload.source;
  if (source.type !== "git" || !source.repository || !source.requested_ref || !source.resolved_commit || state.sourceIds.includes(plan.payload.source_id) || state.namespaces.includes(plan.payload.namespace)) fail("projection requires a new pinned Git source and namespace");
  const binding = policy.payload.sources.find((row) => row.source_id === plan.payload.source_id);
  if (!binding || binding.repository !== source.repository || binding.resolved_commit !== source.resolved_commit ||
      JSON.stringify(binding.governed_skill_ids) !== JSON.stringify(plan.payload.candidates.map((row) => row.skill_id).sort())) fail("policy source binding mismatch");
  const config: SourceConfig = { namespace: plan.payload.namespace, provenanceFiles: [...source.provenance_files], ref: source.requested_ref, repository: source.repository, selection: { roots: [...source.selected_roots] }, type: "git" };
  const stage = verifyAdoptionStage(input.hubDir, plan);
  const stagedSource = join(stage, "source");
  const acquired = acquireSource({ source: source.repository, sourceType: "git", ref: source.requested_ref, commit: source.resolved_commit, roots: source.selected_roots, provenanceFiles: source.provenance_files });
  try {
    if (acquired.tree.treeDigest !== source.selected_skill_tree_digest || acquired.tree.snapshotDigest !== source.vendored_snapshot_digest) fail("pinned Git snapshot mismatch");
    const importedPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: plan.payload.namespace, target: emptyRegistryTarget() });
    if (importedPlan.digest !== plan.payload.import_plan.digest) fail("pinned Git import plan mismatch");
  } finally { releaseAcquiredSource(acquired); }
  const build = await buildHub(input.hubDir);
  try {
    if (createHubRelease(build, artifacts(build)).digest !== input.baseline.digest) fail("baseline release does not match verified Hub inputs");
    const registry = openRegistry({ env: { EGA_SKILLS_HOME: build.registryHome } });
    const skills = [...build.skills];
    const ids = new Set(skills.map((row) => row.skillId));
    try {
      for (const candidate of plan.payload.candidates) {
        if (ids.has(candidate.skill_id)) fail("projected catalog contains a conflicting skill");
        const summary = await importSkills(registry, { namespace: plan.payload.namespace, path: join(stagedSource, ...candidate.relative_root.split("/")), logicalPath: join(adoptedSourcePath("", plan.payload.source_id), ...candidate.relative_root.split("/")).replaceAll("\\", "/") });
        if (summary.failed || summary.imported !== 1) fail("staged skill import failed");
        const versions = listSkillVersions(registry.db, candidate.skill_id);
        if (versions.length !== 1 || versions[0]?.versionHash !== candidate.version_hash) fail("staged skill version mismatch");
        ids.add(candidate.skill_id); skills.push({ skillId: candidate.skill_id, versionHash: candidate.version_hash });
      }
    } finally { registry.close(); }
    const rechecked = digestStagedTree(stagedSource, source.selected_roots);
    if (rechecked.treeDigest !== source.selected_skill_tree_digest || rechecked.snapshotDigest !== source.vendored_snapshot_digest || readHubIntakeState(input.hubDir).baselineDigest !== state.baselineDigest) fail("projection inputs changed during construction");
    const projected: HubBuildResult = { ...build, skills: skills.sort((a, b) => a.skillId < b.skillId ? -1 : 1), adoptedSources: [...build.adoptedSources, { sourceId: plan.payload.source_id, sourceConfigDigest: sourceConfigDigest(config), resolvedCommit: source.resolved_commit, selectedSkillTreeDigest: source.selected_skill_tree_digest, vendoredSnapshotDigest: source.vendored_snapshot_digest }].sort((a, b) => a.sourceId < b.sourceId ? -1 : 1) };
    const semanticArtifacts = artifacts(projected);
    return createInvocationRelease(createHubRelease(projected, semanticArtifacts), policy, semanticArtifacts);
  } finally { rmSync(build.registryHome, { recursive: true, force: true }); }
}
