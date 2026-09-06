// 1.1[B] hub.yaml runtime (EGA-624). Contract A section 3.

import { HubError } from "./errors.js";
import { NAMESPACE_RE, assertRelativePosix, isPlainObject, parseYamlMapping, rejectUnknownFields } from "./guards.js";
import type { SourcesConfig } from "./sources-config.js";

export interface OwnedEntry {
  path: string;
  namespace: string;
}

export interface HubConfig {
  schemaVersion: number;
  hubId: string;
  owned: OwnedEntry[];
  external: string[];
}

const TOP_FIELDS = new Set(["schema_version", "hub", "owned", "external"]);

export function parseHubYaml(text: string): HubConfig {
  const doc = parseYamlMapping(text, "hub.yaml");
  rejectUnknownFields(doc, TOP_FIELDS, "hub.yaml");
  if (doc["schema_version"] !== 1) {
    throw new HubError("E_HUB_SCHEMA", "hub.yaml schema_version must be 1");
  }
  const hub = doc["hub"];
  if (!isPlainObject(hub) || typeof hub["id"] !== "string" || hub["id"].length === 0) {
    throw new HubError("E_HUB_SCHEMA", "hub.yaml hub.id must be a non-empty string");
  }
  const ownedRaw = doc["owned"];
  if (!Array.isArray(ownedRaw)) {
    throw new HubError("E_HUB_SCHEMA", "hub.yaml owned must be a list");
  }
  const owned: OwnedEntry[] = ownedRaw.map((entry) => {
    if (!isPlainObject(entry) || typeof entry["path"] !== "string" || typeof entry["namespace"] !== "string") {
      throw new HubError("E_HUB_SCHEMA", "hub.yaml owned entries need {path, namespace} strings");
    }
    try {
      assertRelativePosix(entry["path"], "hub.yaml owned.path");
    } catch (e) {
      throw new HubError("E_HUB_SCHEMA", (e as Error).message);
    }
    if (!NAMESPACE_RE.test(entry["namespace"])) {
      throw new HubError("E_HUB_SCHEMA", `hub.yaml owned.namespace invalid: ${entry["namespace"]}`);
    }
    return { namespace: entry["namespace"], path: entry["path"] };
  });
  const externalRaw = doc["external"];
  if (!Array.isArray(externalRaw)) {
    throw new HubError("E_HUB_SCHEMA", "hub.yaml external must be a list");
  }
  const external: string[] = externalRaw.map((entry) => {
    if (!isPlainObject(entry) || typeof entry["source"] !== "string") {
      throw new HubError("E_HUB_SCHEMA", "hub.yaml external entries need {source} string");
    }
    return entry["source"];
  });
  return { external, hubId: hub["id"], owned, schemaVersion: 1 };
}

/** Every configured source is listed in the Hub and every listed source is configured. */
export function verifyHubCoverage(hub: HubConfig, config: SourcesConfig): void {
  const configured = Object.keys(config.sources).sort();
  const listed = [...hub.external].sort();
  if (JSON.stringify(configured) !== JSON.stringify(listed)) {
    throw new HubError(
      "E_HUB_SCHEMA",
      `hub.yaml external [${listed}] must equal configured sources [${configured}]`,
    );
  }
}
