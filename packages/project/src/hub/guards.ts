// 1.1[B] shared Hub YAML guards (EGA-624). Contract A sections 3-4.

import { parse as parseYaml } from "yaml";
import { HubError } from "./errors.js";

export const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Repository-relative posix path, byte-aligned with the Contract A validator:
 *  reject empty, backslashes, leading slash, `..` segments, and
 *  drive-letter prefixes. Dotted/empty segments the validator accepts stay
 *  accepted here: runtime MUST NOT reject validator-valid input. */
export function assertRelativePosix(path: string, what: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    segments.includes("..") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new HubError("E_SOURCE_SELECTION", `${what} must be a repository-relative posix path: ${path}`);
  }
}

export function assertSortedUnique(items: readonly string[], what: string): void {
  const sorted = [...items].sort();
  if (JSON.stringify(items) !== JSON.stringify(sorted)) {
    throw new HubError("E_SOURCE_SELECTION", `${what} must be sorted`);
  }
  if (new Set(items).size !== items.length) {
    throw new HubError("E_SOURCE_SELECTION", `${what} must be unique`);
  }
}

export function parseYamlMapping(text: string, file: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new HubError("E_HUB_SCHEMA", `${file} is not valid YAML: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  if (!isPlainObject(doc)) {
    throw new HubError("E_HUB_SCHEMA", `${file} top level must be a mapping`);
  }
  return doc;
}

export function rejectUnknownFields(doc: Record<string, unknown>, allowed: ReadonlySet<string>, file: string): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      throw new HubError("E_HUB_SCHEMA", `${file} unknown field "${key}"`);
    }
  }
}
