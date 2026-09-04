// SPEC-002 §5.1.3 + §5.1.11 + §5.1.15 canonical SkillVersion manifest (EGA-561).
//
// Behavior-defining manifest BEFORE JCS serialization (EGA-562 owns JCS/SHA-256).
// Exact snake_case wire keys; TypeScript camelCase names are never serialized.
// Absent optionals are omitted, never null/undefined. Raw ega.yaml is NOT a
// files[] record; normalized semantic routing metadata is the only EGA YAML
// identity input. Provenance/token counts/paths/trust/size classes never enter.

import type {
  CanonicalContentKind,
  CanonicalFileRecord,
  CanonicalFileRole,
} from "./enumeration.js";

export const SKILL_VERSION_HASH_SCHEMA_VERSION = 1;

export interface ManifestPortableInput {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
}

export interface ManifestRoutingInput {
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly antiTriggers: readonly string[];
  readonly aliases: readonly string[];
}

export interface ManifestFileInput {
  readonly path: string;
  readonly role: CanonicalFileRole;
  readonly blob_hash: string;
  readonly byte_size: number;
  readonly content_kind: CanonicalContentKind;
}

export interface BuildManifestInput {
  readonly skillId: string;
  readonly portable: ManifestPortableInput;
  readonly routing: ManifestRoutingInput;
  readonly files: readonly ManifestFileInput[];
}

export interface ManifestPortableWire {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowed_tools?: string;
}

export interface ManifestRoutingWire {
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly anti_triggers: readonly string[];
  readonly aliases: readonly string[];
}

export interface ManifestFileWire {
  readonly path: string;
  readonly role: CanonicalFileRole;
  readonly blob_hash: string;
  readonly byte_size: number;
  readonly content_kind: CanonicalContentKind;
}

export interface CanonicalSkillVersionManifest {
  readonly schema_version: 1;
  readonly skill_id: string;
  readonly portable: ManifestPortableWire;
  readonly routing: ManifestRoutingWire;
  readonly files: readonly ManifestFileWire[];
}

function compareUtf16(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort(compareUtf16);
}

function isRawEgaYamlPath(canonicalPath: string): boolean {
  return canonicalPath === "ega.yaml";
}

export function buildCanonicalSkillVersionManifest(
  input: BuildManifestInput,
): CanonicalSkillVersionManifest {
  if (typeof input.skillId !== "string" || input.skillId.length === 0) {
    throw new TypeError("buildCanonicalSkillVersionManifest requires a non-empty skillId.");
  }

  const portable: Record<string, unknown> = {
    name: input.portable.name,
    description: input.portable.description,
  };
  if (input.portable.license !== undefined) {
    portable["license"] = input.portable.license;
  }
  if (input.portable.compatibility !== undefined) {
    portable["compatibility"] = input.portable.compatibility;
  }
  if (input.portable.metadata !== undefined) {
    portable["metadata"] = Object.freeze({ ...input.portable.metadata });
  }
  if (input.portable.allowedTools !== undefined) {
    portable["allowed_tools"] = input.portable.allowedTools;
  }

  const routing: ManifestRoutingWire = Object.freeze({
    domains: Object.freeze(sortedCopy(input.routing.domains)),
    platforms: Object.freeze(sortedCopy(input.routing.platforms)),
    frameworks: Object.freeze(sortedCopy(input.routing.frameworks)),
    triggers: Object.freeze(sortedCopy(input.routing.triggers)),
    anti_triggers: Object.freeze(sortedCopy(input.routing.antiTriggers)),
    aliases: Object.freeze(sortedCopy(input.routing.aliases)),
  });

  const files: ManifestFileWire[] = [];
  for (const file of input.files) {
    if (isRawEgaYamlPath(file.path)) {
      continue;
    }
    files.push(
      Object.freeze({
        path: file.path,
        role: file.role,
        blob_hash: file.blob_hash,
        byte_size: file.byte_size,
        content_kind: file.content_kind,
      }),
    );
  }
  files.sort((a, b) => compareUtf16(a.path, b.path));

  return Object.freeze({
    schema_version: SKILL_VERSION_HASH_SCHEMA_VERSION,
    skill_id: input.skillId,
    portable: Object.freeze(portable) as unknown as ManifestPortableWire,
    routing,
    files: Object.freeze(files),
  });
}

export type { CanonicalFileRecord };
