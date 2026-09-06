// 1.1[B] sources.yaml runtime (EGA-624). Contract A section 4.

import { canonicalizeJson, sha256Hex } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import {
  NAMESPACE_RE,
  assertRelativePosix,
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
    if (typeof entry["repository"] !== "string" || !entry["repository"].startsWith("https://")) {
      throw sourceFieldError(name, "repository must be an https URL");
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
    const roots = selection["roots"].map((root) => {
      if (typeof root !== "string" || root.length === 0) {
        throw new HubError("E_SOURCE_SELECTION", `sources.yaml source ${name} roots must be non-empty strings`);
      }
      assertRelativePosix(root, `sources.yaml source ${name} root`);
      return root;
    });
    assertSortedUnique(roots, `sources.yaml source ${name} selection.roots`);
    const provenanceRaw = entry["provenance_files"] ?? [];
    if (!Array.isArray(provenanceRaw)) {
      throw new HubError("E_SOURCE_SELECTION", `sources.yaml source ${name} provenance_files must be a list`);
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

/** Normalized preimage for source_config_digest (Contract A section 4.1). */
export function normalizeSourceConfig(src: SourceConfig): Record<string, unknown> {
  return {
    namespace: src.namespace,
    provenance_files: [...src.provenanceFiles].sort(),
    repository: src.repository,
    requested_ref: src.ref,
    selection_roots: [...src.selection.roots].sort(),
    type: src.type,
  };
}

export function sourceConfigDigest(src: SourceConfig): string {
  return `sha256:${sha256Hex(canonicalizeJson(normalizeSourceConfig(src)))}`;
}
