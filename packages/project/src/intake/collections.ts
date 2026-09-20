// Contract E3: Hub-local browse collections.
//
// Collections are deliberately outside imported skill roots and are read-only
// browse metadata. They do not alter canonical package bytes, routing fields,
// release membership, or SkillVersion identities.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createEnvelope, hashBytes, type ArtifactEnvelope } from "@ega-skills/hashing";
import { parseCanonicalSkillId } from "@ega-skills/registry";
import { buildHub, type HubBuildResult } from "../hub/builder.js";
import { HubError } from "../hub/errors.js";
import { isPlainObject } from "../hub/guards.js";

export const COLLECTIONS_OBJECT_TYPE = "ega.collection-validation" as const;
export const COLLECTIONS_SCHEMA_VERSION = 1 as const;
export const COLLECTIONS_PATH = join("intake", "collections.yaml");

export type CollectionDiagnosticSeverity = "ERROR" | "WARNING";

export type CollectionDiagnosticCode =
  | "INVALID_COLLECTION_KEY"
  | "DUPLICATE_NORMALIZED_KEY"
  | "UNKNOWN_PARENT"
  | "PARENT_CYCLE"
  | "UNKNOWN_COLLECTION"
  | "DUPLICATE_MEMBERSHIP"
  | "UNSORTED_MEMBERSHIPS"
  | "INVALID_SKILL_ID"
  | "UNKNOWN_SKILL_REFERENCE";

export interface CollectionDefinition {
  readonly key: string;
  readonly label: string;
  readonly parent: string | null;
}

export interface CollectionsConfig {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly collections: readonly CollectionDefinition[];
  readonly memberships: Readonly<Record<string, readonly string[]>>;
}

export interface CollectionDiagnostic {
  readonly code: CollectionDiagnosticCode;
  readonly severity: CollectionDiagnosticSeverity;
  readonly message: string;
  readonly collection_key?: string;
  readonly skill_id?: string;
}

export interface CollectionValidationPayload {
  readonly hub_id: string;
  readonly collection_revision: number;
  readonly source_digest: string | null;
  readonly collections: readonly CollectionDefinition[];
  readonly memberships: Readonly<Record<string, readonly string[]>>;
  readonly catalog: Readonly<Record<string, string>>;
  readonly diagnostics: readonly CollectionDiagnostic[];
  readonly status: "VALID" | "BLOCKED";
}

export type CollectionValidationDocument = ArtifactEnvelope & {
  readonly object_type: "ega.collection-validation";
  readonly schema_version: 1;
  readonly payload: CollectionValidationPayload;
};

function fail(message: string): never {
  throw new HubError("E_COLLECTION", `E_COLLECTION: ${message}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function normalizeCollectionKey(key: string): string {
  return key.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, "-");
}

function parseCollections(text: string): CollectionsConfig {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    fail(`intake/collections.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value) || !exactKeys(value, ["schema_version", "revision", "collections", "memberships"])) {
    fail("intake/collections.yaml must contain exactly schema_version, revision, collections, and memberships");
  }
  if (value["schema_version"] !== 1) fail("schema_version must be 1");
  if (!Number.isSafeInteger(value["revision"]) || (value["revision"] as number) < 1) fail("revision must be a positive integer");
  if (!Array.isArray(value["collections"])) fail("collections must be a list");
  if (!isPlainObject(value["memberships"])) fail("memberships must be a mapping");

  const collections: CollectionDefinition[] = value["collections"].map((entry, index) => {
    if (!isPlainObject(entry) || !(exactKeys(entry, ["key", "label", "parent"]) || exactKeys(entry, ["key", "label"]))) {
      fail(`collections[${index}] must contain key, label, and optional parent`);
    }
    if (typeof entry["key"] !== "string" || entry["key"].length === 0 || entry["key"].length > 128) fail(`collections[${index}].key is invalid`);
    if (typeof entry["label"] !== "string" || entry["label"].length === 0 || entry["label"].length > 256) fail(`collections[${index}].label is invalid`);
    const parent = entry["parent"] === undefined || entry["parent"] === null ? null : entry["parent"];
    if (parent !== null && (typeof parent !== "string" || parent.length === 0 || parent.length > 128)) fail(`collections[${index}].parent is invalid`);
    return { key: entry["key"], label: entry["label"], parent };
  });
  const memberships: Record<string, readonly string[]> = {};
  for (const [skillId, raw] of Object.entries(value["memberships"])) {
    if (!Array.isArray(raw) || raw.some((key) => typeof key !== "string")) fail(`memberships.${skillId} must be a list of collection keys`);
    memberships[skillId] = raw as string[];
  }
  return { collections, memberships, revision: value["revision"] as number, schemaVersion: 1 };
}

function diagnostic(
  code: CollectionDiagnosticCode,
  message: string,
  collectionKey?: string,
  skillId?: string,
): CollectionDiagnostic {
  return {
    code,
    message,
    ...(collectionKey === undefined ? {} : { collection_key: collectionKey }),
    ...(skillId === undefined ? {} : { skill_id: skillId }),
    severity: "ERROR",
  };
}

function catalogMap(build: HubBuildResult): Record<string, string> {
  return Object.fromEntries(build.skills.map((skill) => [skill.skillId, skill.versionHash]));
}

function validateConfig(config: CollectionsConfig, build: HubBuildResult): CollectionDiagnostic[] {
  const diagnostics: CollectionDiagnostic[] = [];
  const byNormalized = new Map<string, CollectionDefinition>();
  const byKey = new Map<string, CollectionDefinition>();
  for (const collection of config.collections) {
    const normalized = normalizeCollectionKey(collection.key);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized) || normalized !== collection.key) {
      diagnostics.push(diagnostic("INVALID_COLLECTION_KEY", `collection key must be a normalized stable key: ${collection.key}`, collection.key));
    }
    if (byNormalized.has(normalized)) {
      diagnostics.push(diagnostic("DUPLICATE_NORMALIZED_KEY", `collection keys normalize to the same key: ${normalized}`, collection.key));
    } else {
      byNormalized.set(normalized, collection);
    }
    if (byKey.has(collection.key)) {
      diagnostics.push(diagnostic("DUPLICATE_NORMALIZED_KEY", `collection key is repeated: ${collection.key}`, collection.key));
    } else {
      byKey.set(collection.key, collection);
    }
  }

  for (const collection of config.collections) {
    if (collection.parent !== null && !byKey.has(collection.parent)) {
      diagnostics.push(diagnostic("UNKNOWN_PARENT", `parent collection does not exist: ${collection.parent}`, collection.key));
    }
  }
  const states = new Map<string, "VISITING" | "DONE">();
  const reportedCycles = new Set<string>();
  const visit = (key: string, path: readonly string[]): void => {
    const state = states.get(key);
    if (state === "DONE") return;
    if (state === "VISITING") {
      const cycleStart = path.indexOf(key);
      const cycle = [...path.slice(cycleStart), key].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        diagnostics.push(diagnostic("PARENT_CYCLE", `parent cycle detected: ${cycle}`, key));
        reportedCycles.add(cycle);
      }
      return;
    }
    const current = byKey.get(key);
    if (current === undefined) return;
    states.set(key, "VISITING");
    if (current.parent !== null && byKey.has(current.parent)) visit(current.parent, [...path, key]);
    states.set(key, "DONE");
  };
  for (const collection of config.collections) visit(collection.key, []);

  const catalog = new Set(build.skills.map((skill) => skill.skillId));
  for (const [skillId, collectionKeys] of Object.entries(config.memberships)) {
    try {
      parseCanonicalSkillId(skillId);
    } catch {
      diagnostics.push(diagnostic("INVALID_SKILL_ID", `membership key is not a canonical Skill ID: ${skillId}`, undefined, skillId));
    }
    if (!catalog.has(skillId)) {
      diagnostics.push(diagnostic("UNKNOWN_SKILL_REFERENCE", `membership references a skill outside the Hub catalog: ${skillId}`, undefined, skillId));
    }
    const sorted = [...collectionKeys].sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(sorted) !== JSON.stringify(collectionKeys)) {
      diagnostics.push(diagnostic("UNSORTED_MEMBERSHIPS", `membership keys must be sorted for ${skillId}`, undefined, skillId));
    }
    if (new Set(collectionKeys).size !== collectionKeys.length) {
      diagnostics.push(diagnostic("DUPLICATE_MEMBERSHIP", `skill is listed more than once in a collection: ${skillId}`, undefined, skillId));
    }
    for (const collectionKey of collectionKeys) {
      if (!byKey.has(collectionKey)) {
        diagnostics.push(diagnostic("UNKNOWN_COLLECTION", `membership references an unknown collection: ${collectionKey}`, collectionKey, skillId));
      }
    }
  }
  return diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/** Validate Hub-local browse metadata against the fresh exact Hub catalog. */
export async function validateCollections(hubPath: string): Promise<CollectionValidationDocument> {
  const hubDir = resolve(hubPath);
  const build = await buildHub(hubDir);
  const path = join(hubDir, COLLECTIONS_PATH);
  const present = existsSync(path);
  const text = present ? readFileSync(path, "utf8") : undefined;
  const config = text === undefined
    ? { collections: [], memberships: {}, revision: 0, schemaVersion: 1 as const }
    : parseCollections(text);
  const diagnostics = validateConfig(config, build);
  const payload: CollectionValidationPayload = {
    catalog: catalogMap(build),
    collection_revision: config.revision,
    collections: [...config.collections].sort((left, right) => left.key.localeCompare(right.key)),
    diagnostics,
    hub_id: build.hubId,
    memberships: Object.fromEntries(Object.entries(config.memberships).sort(([left], [right]) => left.localeCompare(right))),
    source_digest: text === undefined ? null : hashBytes(new TextEncoder().encode(text)),
    status: diagnostics.some((entry) => entry.severity === "ERROR") ? "BLOCKED" : "VALID",
  };
  return createEnvelope({ object_type: COLLECTIONS_OBJECT_TYPE, payload, schema_version: COLLECTIONS_SCHEMA_VERSION }) as CollectionValidationDocument;
}
