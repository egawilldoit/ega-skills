// 1.1[B] sources.yaml runtime (EGA-624). Contract A section 4.

import { canonicalizeJson, sha256Hex } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import {
  NAMESPACE_RE,
  assertRelativePosix,
  assertSourceId,
  assertSortedUnique,
  isPlainObject,
  parseYamlMapping,
} from "./guards.js";

export interface SourceSelection {
  roots: string[];
}

export interface SourceConfig {
  type: string;
  repository: string;
  ref: string;
  namespace: string;
  selection: SourceSelection;
  provenanceFiles: string[];
}

export interface SourcesConfig {
  schemaVersion: number;
  sources: Record<string, SourceConfig>;
}

const TOP_FIELDS = new Set(["schema_version", "sources"]);
const SOURCE_FIELDS = new Set(["type", "repository", "ref", "namespace", "selection", "provenance_files"]);

function sourceFieldError(source: string, message: string): HubError {
  return new HubError("E_SOURCE_SCHEMA", `sources.yaml source ${source}: ${message}`);
}

/**
 * Final Contract A repository rule (validator-identical): https:// with a
 * non-empty hostname and no credentials; file:// without credentials; absolute
 * local paths (posix, Windows drive, UNC). Relative paths and bare hosts fail.
 */
export function isValidRepository(repo: unknown): boolean {
  if (typeof repo !== "string" || repo.length === 0) return false;
  if (repo.startsWith("https://") || repo.startsWith("file://")) {
    try {
      const url = new URL(repo);
      if (url.username.length > 0 || url.password.length > 0) return false;
      if (url.protocol === "file:") return true;
      return url.protocol === "https:" && url.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(repo)) return true;
  if (repo.startsWith("//") || repo.startsWith("/")) return true;
  return false;
}

export function parseSourcesYaml(text: string): SourcesConfig {
  const doc = parseYamlMapping(text, "sources.yaml");
  for (const key of Object.keys(doc)) {
    if (!TOP_FIELDS.has(key)) {
      throw new HubError("E_SOURCE_SCHEMA", `sources.yaml unknown top-level field "${key}"`);
    }
  }
  if (doc["schema_version"] !== 1) {
    throw new HubError("E_SOURCE_SCHEMA", "sources.yaml schema_version must be 1");
  }
  const raw = doc["sources"];
  if (!isPlainObject(raw)) {
    throw new HubError("E_SOURCE_SCHEMA", "sources.yaml sources must be a mapping");
  }
  const sources: Record<string, SourceConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    assertSourceId(name, `sources.yaml source ${name}`, "E_SOURCE_SCHEMA");
    if (!isPlainObject(entry)) {
      throw sourceFieldError(name, "must be a mapping");
    }
    for (const key of Object.keys(entry)) {
      if (!SOURCE_FIELDS.has(key)) {
        throw sourceFieldError(name, `unknown field "${key}"`);
      }
    }
    if (entry["type"] !== "git") {
      throw sourceFieldError(name, 'type must be "git"');
    }
    if (!isValidRepository(entry["repository"])) {
      throw sourceFieldError(name, "repository must be https:// (with host, no credentials), file:// (no credentials), or an absolute local path");
    }
    if (typeof entry["ref"] !== "string" || entry["ref"].length === 0) {
      throw sourceFieldError(name, "ref must be a non-empty string");
    }
    if (typeof entry["namespace"] !== "string" || !NAMESPACE_RE.test(entry["namespace"])) {
      throw sourceFieldError(name, "namespace invalid");
    }
    const selection = entry["selection"];
    if (!isPlainObject(selection) || !Array.isArray(selection["roots"]) || selection["roots"].length === 0) {
      throw new HubError("E_SOURCE_SELECTION", `sources.yaml source ${name} selection.roots must be a non-empty list`);
    }
    for (const key of Object.keys(selection)) {
      if (key !== "roots") throw new HubError("E_SOURCE_SELECTION", `sources.yaml source ${name} selection unknown field "${key}"`);
    }
    const roots = selection["roots"].map((root) => {
      if (typeof root !== "string" || root.length === 0) {
        throw new HubError("E_SOURCE_SELECTION", `sources.yaml source ${name} roots must be non-empty strings`);
      }
      assertRelativePosix(root, `sources.yaml source ${name} root`);
      return root;
    });
    assertSortedUnique(roots, `sources.yaml source ${name} selection.roots`);
    // Final Contract A: provenance_files MUST be non-empty; missing, null,
    // and empty all fail closed (no reviewed-exception record exists in v1).
    const provenanceRaw = entry["provenance_files"];
    if (!Array.isArray(provenanceRaw) || provenanceRaw.length === 0) {
      throw sourceFieldError(name, "provenance_files must be a non-empty list (missing and null are different; null is never valid)");
    }
    const provenanceFiles = provenanceRaw.map((file) => {
      if (typeof file !== "string") {
        throw new HubError("E_SOURCE_SELECTION", `sources.yaml source ${name} provenance files must be strings`);
      }
      assertRelativePosix(file, `sources.yaml source ${name} provenance file`);
      return file;
    });
    sources[name] = {
      namespace: entry["namespace"] as string,
      provenanceFiles,
      ref: entry["ref"] as string,
      repository: entry["repository"] as string,
      selection: { roots },
      type: "git",
    };
  }
  return { schemaVersion: 1, sources };
}

/** Normalized preimage for source_config_digest (Contract A section 4.1).
 *  Dedupe-then-sort exactly like the validator so digests byte-match. */
export function normalizeSourceConfig(src: SourceConfig): Record<string, unknown> {
  const sortedUnique = (items: readonly string[]): string[] => [...new Set(items)].sort();
  return {
    namespace: src.namespace,
    provenance_files: sortedUnique(src.provenanceFiles),
    repository: src.repository,
    requested_ref: src.ref,
    selection_roots: sortedUnique(src.selection.roots),
    type: src.type,
  };
}

export function sourceConfigDigest(src: SourceConfig): string {
  return `sha256:${sha256Hex(canonicalizeJson(normalizeSourceConfig(src)))}`;
}
