// 1.1[B] sources.lock.yaml runtime (EGA-624). Contract A section 5.

import { HubError } from "./errors.js";
import { COMMIT_RE, SHA256_RE, isPlainObject, parseYamlMapping } from "./guards.js";
import { sourceConfigDigest, type SourceConfig, type SourcesConfig } from "./sources-config.js";

export interface LockedSelection {
  roots: string[];
}

export interface SourceLockRecord {
  source_config_digest: string;
  repository: string;
  requested_ref: string;
  namespace: string;
  selection: LockedSelection;
  provenance_files: string[];
  resolved_commit: string;
  selected_skill_tree_digest: string;
  vendored_snapshot_digest: string;
  extraction_contract: number;
}

export interface SourcesLock {
  schemaVersion: number;
  sources: Record<string, SourceLockRecord>;
}

const TOP_FIELDS = new Set(["schema_version", "sources"]);
const RECORD_FIELDS = new Set([
  "source_config_digest",
  "repository",
  "requested_ref",
  "namespace",
  "selection",
  "provenance_files",
  "resolved_commit",
  "selected_skill_tree_digest",
  "vendored_snapshot_digest",
  "extraction_contract",
]);

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

export function parseSourcesLockYaml(text: string): SourcesLock {
  const doc = parseYamlMapping(text, "sources.lock.yaml");
  for (const key of Object.keys(doc)) {
    if (!TOP_FIELDS.has(key)) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml unknown top-level field "${key}"`);
    }
  }
  if (doc["schema_version"] !== 1) {
    throw new HubError("E_LOCK_MISMATCH", "sources.lock.yaml schema_version must be 1");
  }
  const raw = doc["sources"];
  if (!isPlainObject(raw)) {
    throw new HubError("E_LOCK_MISMATCH", "sources.lock.yaml sources must be a mapping");
  }
  const sources: Record<string, SourceLockRecord> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} must be a mapping`);
    }
    for (const key of Object.keys(entry)) {
      if (!RECORD_FIELDS.has(key)) {
        throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} unknown field "${key}"`);
      }
    }
    for (const [key, value] of Object.entries(entry)) {
      if (value === null) {
        throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name}.${key} must not be null`);
      }
    }
    // Fail fast with the same codes the validator emits for the same defect
    // (validator §5: digest recompute, intent equality, format regexes).
    if (typeof entry["source_config_digest"] !== "string" || !SHA256_RE.test(entry["source_config_digest"] as string)) {
      throw new HubError("E_LOCK_DIGEST", `sources.lock.yaml source ${name} source_config_digest must match sha256:<64hex>`);
    }
    for (const field of ["repository", "requested_ref", "namespace"] as const) {
      if (typeof entry[field] !== "string") {
        throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} ${field} must be a string`);
      }
    }
    const selection = entry["selection"];
    if (!isPlainObject(selection) || !Array.isArray(selection["roots"])) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} selection.roots must be a list`);
    }
    const provenance = entry["provenance_files"];
    if (!Array.isArray(provenance)) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} provenance_files must be a list`);
    }
    if (typeof entry["resolved_commit"] !== "string" || !COMMIT_RE.test(entry["resolved_commit"] as string)) {
      throw new HubError("E_LOCK_COMMIT", `sources.lock.yaml source ${name} resolved_commit must be 40 lowercase hex`);
    }
    for (const field of ["selected_skill_tree_digest", "vendored_snapshot_digest"] as const) {
      if (typeof entry[field] !== "string" || !SHA256_RE.test(entry[field] as string)) {
        throw new HubError("E_TREE_DIGEST", `sources.lock.yaml source ${name} ${field} must match sha256:<64hex>`);
      }
    }
    if (entry["extraction_contract"] !== 1) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} extraction_contract must be 1`);
    }
    sources[name] = {
      extraction_contract: entry["extraction_contract"] as number,
      namespace: entry["namespace"] as string,
      provenance_files: provenance as string[],
      repository: entry["repository"] as string,
      requested_ref: entry["requested_ref"] as string,
      resolved_commit: entry["resolved_commit"] as string,
      selected_skill_tree_digest: entry["selected_skill_tree_digest"] as string,
      selection: { roots: selection["roots"] as string[] },
      source_config_digest: entry["source_config_digest"] as string,
      vendored_snapshot_digest: entry["vendored_snapshot_digest"] as string,
    };
  }
  return { schemaVersion: 1, sources };
}

/** Lock MUST cover exactly the configured sources and repeat their intent. */
export function verifySourcesLock(config: SourcesConfig, lock: SourcesLock): void {
  const configured = Object.keys(config.sources).sort();
  const locked = Object.keys(lock.sources).sort();
  if (JSON.stringify(configured) !== JSON.stringify(locked)) {
    throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml sources [${locked}] must equal configured sources [${configured}]`);
  }
  for (const name of configured) {
    const cfg = config.sources[name] as SourceConfig;
    const rec = lock.sources[name] as SourceLockRecord;
    if (rec.source_config_digest !== sourceConfigDigest(cfg)) {
      throw new HubError("E_LOCK_DIGEST", `sources.lock.yaml source ${name} source_config_digest mismatch`);
    }
    if (rec.repository !== cfg.repository || rec.requested_ref !== cfg.ref || rec.namespace !== cfg.namespace) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} must repeat sources.yaml intent`);
    }
    if (JSON.stringify(sortedUnique(rec.selection.roots)) !== JSON.stringify(sortedUnique(cfg.selection.roots))) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} selection.roots must equal sources.yaml`);
    }
    if (JSON.stringify(sortedUnique(rec.provenance_files)) !== JSON.stringify(sortedUnique(cfg.provenanceFiles))) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} provenance_files must equal sources.yaml`);
    }
    if (!COMMIT_RE.test(rec.resolved_commit)) {
      throw new HubError("E_LOCK_COMMIT", `sources.lock.yaml source ${name} resolved_commit must be 40 lowercase hex`);
    }
    if (!SHA256_RE.test(rec.selected_skill_tree_digest) || !SHA256_RE.test(rec.vendored_snapshot_digest)) {
      throw new HubError("E_TREE_DIGEST", `sources.lock.yaml source ${name} tree digests must match sha256:<64hex>`);
    }
    if (rec.extraction_contract !== 1) {
      throw new HubError("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} extraction_contract must be 1`);
    }
  }
}
