// 1.1[C] update check orchestration (EGA-625). Contract B sections 2-4.
//
// `checkForUpdates` is READ-ONLY with respect to adopted content: it resolves
// the tracked ref, fetches the exact tip into quarantine, extracts the
// declared roots, imports the candidate into a SCRATCH registry home
// (discarded afterwards), and emits an immutable UpdatePlan envelope — or
// reports NO_CHANGE. It never touches the Hub, the lock, or any registry.
//
// Version-change semantics are conservative at check time: a changed
// SkillVersion sets raw_changed (the adopted tree bytes are not available to
// the checker; apply-time reporting refines this against the preserved old
// tree). Canonical identity always comes from the V1 importer, never invented.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope } from "@ega-skills/hashing";
import { importSkills, listSkillVersions, openRegistry, type RegistryHandle } from "@ega-skills/registry";
import { HubError } from "./errors.js";
import { fetchRefTip, resolveRefToCommit } from "./git.js";
import { discoverUnselectedSkills, extractSelectedRoots } from "./quarantine.js";
import { sourceConfigDigest, type SourceConfig } from "./sources-config.js";

export interface AdoptedSourceView {
  commit: string;
  treeDigest: string;
  snapshotDigest: string;
  versions: Record<string, string>;
}

export interface CheckInput {
  sourceId: string;
  config: SourceConfig;
  adopted: AdoptedSourceView;
  workDir: string;
}

export interface AddedSkill {
  skill_ref: string;
  version_hash: string;
}

export interface PlanSkillChange {
  skill_ref: string;
  old_version: string;
  new_version: string;
  raw_changed: boolean;
  canonical_changed: boolean;
}

export interface UpdatePlanPayload {
  source_id: string;
  source_config_digest: string;
  expected_old: { resolved_commit: string; selected_skill_tree_digest: string };
  target_commit: string;
  new_selected_tree_digest: string;
  new_vendored_snapshot_digest: string;
  added_skills: AddedSkill[];
  removed_skills: AddedSkill[];
  changed_skills: PlanSkillChange[];
  unselected_new_skills: string[];
  provenance_changes: string[];
  extraction_contract: 1;
}

export interface UpdatePlanDocument {
  object_type: "ega.update-plan";
  schema_version: 1;
  payload: UpdatePlanPayload;
  digest: string;
}

export type CheckResult =
  | { status: "NO_CHANGE"; targetCommit: string }
  | { status: "UPDATE_AVAILABLE"; plan: UpdatePlanDocument };

function readSkillName(skillMdPath: string): string {
  const text = readFileSync(skillMdPath, "utf8");
  const match = text.match(/^name:\s*(.+?)\s*$/m);
  if (!match || !match[1]) {
    throw new HubError("E_PLAN_FETCH", `candidate skill has no frontmatter name: ${skillMdPath}`);
  }
  return match[1];
}

export async function checkForUpdates(input: CheckInput): Promise<CheckResult> {
  const { sourceId, config, adopted, workDir } = input;
  const target = resolveRefToCommit(config.repository, config.ref);
  if (target === adopted.commit) {
    // The same commit cannot yield changes: no fetch, no mutation, no plan.
    return { status: "NO_CHANGE", targetCommit: target };
  }
  // Every temp directory this check creates is removed in the outer finally
  // (registry closed first): successful and failed checks leave nothing
  // behind in workDir or the system temp area.
  const tempDirs: string[] = [];
  let registry: RegistryHandle | null = null;
  try {
    const fetchDir = mkdtempSync(join(workDir, "fetch-"));
    tempDirs.push(fetchDir);
    fetchRefTip(config.repository, config.ref, target, fetchDir);
    const quarantineDir = mkdtempSync(join(workDir, "quarantine-"));
    tempDirs.push(quarantineDir);
    const tree = extractSelectedRoots(fetchDir, config.selection.roots, config.provenanceFiles, quarantineDir);
    const unselected = discoverUnselectedSkills(fetchDir, config.selection.roots);
    if (tree.treeDigest === adopted.treeDigest && tree.snapshotDigest === adopted.snapshotDigest) {
      return { status: "NO_CHANGE", targetCommit: target };
    }
    // Candidate SkillVersions via the V1 importer in a scratch home. The env is
    // fully explicit (no process inheritance) so checks never observe ambient state.
    const scratchHome = mkdtempSync(join(tmpdir(), "ega-plan-scratch-"));
    tempDirs.push(scratchHome);
    const opened = openRegistry({ env: { EGA_SKILLS_HOME: scratchHome }, userHome: tmpdir() });
    registry = opened;
    const summary = await importSkills(opened, { namespace: config.namespace, path: quarantineDir });
    if (summary.failed > 0) {
      const first = summary.failures[0];
      throw new HubError("E_PLAN_FETCH", `candidate tree failed V1 import: ${first ? first.error : "unknown"}`);
    }
    const candidate: Record<string, string> = {};
    for (const root of config.selection.roots) {
      const name = readSkillName(join(quarantineDir, ...root.split("/"), "SKILL.md"));
      const ref = `${config.namespace}/${name}`;
      const rows = listSkillVersions(registry.db, ref);
      const latest = rows[rows.length - 1];
      if (!latest) {
        throw new HubError("E_PLAN_FETCH", `candidate skill imported without a version: ${ref}`);
      }
      candidate[ref] = latest.versionHash;
    }
    const byRef = (a: { skill_ref: string }, b: { skill_ref: string }): number => (a.skill_ref < b.skill_ref ? -1 : 1);
    const added: AddedSkill[] = Object.entries(candidate)
      .filter(([ref]) => !(ref in adopted.versions))
      .map(([skill_ref, version_hash]) => ({ skill_ref, version_hash }))
      .sort(byRef);
    const removed: AddedSkill[] = Object.entries(adopted.versions)
      .filter(([ref]) => !(ref in candidate))
      .map(([skill_ref, version_hash]) => ({ skill_ref, version_hash }))
      .sort(byRef);
    const changed: PlanSkillChange[] = Object.entries(candidate)
      .filter(([ref, hash]) => ref in adopted.versions && adopted.versions[ref] !== hash)
      .map(([skill_ref, new_version]) => ({
        canonical_changed: true,
        new_version,
        old_version: adopted.versions[skill_ref] as string,
        raw_changed: true,
        skill_ref,
      }))
      .sort(byRef);
    // Provenance-only change: the selected tree is identical but the snapshot
    // (roots + provenance) moved, so the difference must be in provenance files.
    const provenanceChanges =
      tree.treeDigest === adopted.treeDigest && tree.snapshotDigest !== adopted.snapshotDigest
        ? [...config.provenanceFiles].sort()
        : [];
    const payload: UpdatePlanPayload = {
      added_skills: added,
      changed_skills: changed,
      expected_old: { resolved_commit: adopted.commit, selected_skill_tree_digest: adopted.treeDigest },
      extraction_contract: 1,
      new_selected_tree_digest: tree.treeDigest,
      new_vendored_snapshot_digest: tree.snapshotDigest,
      provenance_changes: provenanceChanges,
      removed_skills: removed,
      source_config_digest: sourceConfigDigest(config),
      source_id: sourceId,
      target_commit: target,
      unselected_new_skills: unselected,
    };
    const plan = createEnvelope({ object_type: "ega.update-plan", payload, schema_version: 1 });
    return {
      plan: {
        digest: plan.digest,
        object_type: "ega.update-plan",
        payload,
        schema_version: 1,
      },
      status: "UPDATE_AVAILABLE",
    };
  } finally {
    if (registry !== null) {
      try {
        registry.close();
      } catch {
        // Close is best-effort here: temp removal below must still run.
      }
    }
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup must never mask the check result.
      }
    }
  }
}
