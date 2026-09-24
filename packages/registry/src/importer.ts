// SPEC-003 §5.1.10–§5.1.14 transactional importer pipeline (EGA-566).
//
// Discovery and per-skill error isolation live here. Source preparation and
// persistence are deliberately split in preparation.ts so planning can reuse
// canonical identity without mutating the registry or source tree.

import { validateNamespace } from "@ega-skills/schema";

import { discoverSkillRoots } from "./discovery.js";
import {
  commitPreparedSkill,
  prepareSkillRoot,
  preparationErrorMessage,
} from "./preparation.js";
import type { CommittedPreparedSkill } from "./preparation.js";
import type { RegistryHandle } from "./index.js";

export interface ImportSkillOptions {
  /** Directory to import: one skill root or a collection. */
  readonly path: string;
  /** Explicit author namespace (AMEND-02). Never guessed. */
  readonly namespace: string;
}

export interface SkillImportFailure {
  readonly path: string;
  readonly error: string;
}

export interface ImportSummary {
  readonly imported: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly failures: readonly SkillImportFailure[];
}

export type ImportedSkill = CommittedPreparedSkill;

/**
 * Import one skill root or a collection. Batch siblings commit
 * independently; the summary shape is the frozen
 * { imported, unchanged, failed, failures } contract.
 */
export async function importSkills(
  registry: RegistryHandle,
  options: ImportSkillOptions,
): Promise<ImportSummary> {
  const namespace = validateNamespace(options.namespace, { field: "namespace" });
  const roots = await discoverSkillRoots(options.path);
  let imported = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: SkillImportFailure[] = [];
  for (const root of roots) {
    try {
      const prepared = await prepareSkillRoot(root, namespace);
      const result = commitPreparedSkill(registry, prepared);
      if (result.outcome === "NEW_LOCAL_VERSION") imported += 1;
      else unchanged += 1;
    } catch (error) {
      failed += 1;
      failures.push({ path: root, error: preparationErrorMessage(error) });
    }
  }
  return { imported, unchanged, failed, failures };
}
