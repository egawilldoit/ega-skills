// 1.1[C] quarantine extraction (EGA-625). Contract A section 8
// (extraction_contract 1) + Contract B section 2 (check).
//
// Copies ONLY declared roots + provenance files out of a fetched upstream
// checkout into a clean destination, enforcing the extraction policy:
// no symlinks, no traversal escape, no submodules, no device/special files,
// bounded sizes. Never executes anything.
//
// Two digests come out of one extraction (Contract A section 6):
//   treeDigest     — selected skill roots only
//   snapshotDigest — selected roots PLUS provenance files

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { canonicalizeJson, sha256Hex } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import { assertRelativePosix } from "./guards.js";

/** Quarantine caps (Contract A: bounded extraction, no resource exhaustion). */
export const QUARANTINE_MAX_FILES = 2000;
export const QUARANTINE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const QUARANTINE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export type ManifestScope = "selected" | "provenance";

export interface TreeManifestEntry {
  path: string;
  kind: "file";
  blobSha256: string;
  scope: ManifestScope;
}

export interface ExtractedTree {
  manifest: TreeManifestEntry[];
  treeDigest: string;
  snapshotDigest: string;
}

function blobDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestEntries(entries: readonly TreeManifestEntry[]): string {
  return `sha256:${sha256Hex(canonicalizeJson([...entries]))}`;
}

interface Collector {
  manifest: TreeManifestEntry[];
  files: number;
  bytes: number;
}

function checkSpecial(abs: string, rel: string): void {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new HubError("E_EXTRACTION_POLICY", `symlink forbidden in upstream tree: ${rel}`);
  }
  if (st.isFIFO() || st.isSocket() || st.isBlockDevice() || st.isCharacterDevice()) {
    throw new HubError("E_EXTRACTION_POLICY", `special file forbidden in upstream tree: ${rel}`);
  }
}

function copyTree(srcDir: string, relBase: string, destDir: string, scope: ManifestScope, out: Collector): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const abs = join(srcDir, entry.name);
    const rel = relBase.length > 0 ? `${relBase}/${entry.name}` : entry.name;
    if (entry.name === ".git" || entry.name === ".gitmodules") {
      throw new HubError("E_EXTRACTION_POLICY", `forbidden upstream entry: ${rel}`);
    }
    checkSpecial(abs, rel);
    if (entry.isDirectory()) {
      mkdirSync(join(destDir, ...rel.split("/")), { recursive: true });
      copyTree(abs, rel, destDir, scope, out);
    } else if (entry.isFile()) {
      const bytes = readFileSync(abs);
      if (bytes.length > QUARANTINE_MAX_FILE_BYTES) {
        throw new HubError("E_EXTRACTION_POLICY", `file exceeds quarantine cap: ${rel}`);
      }
      out.files += 1;
      out.bytes += bytes.length;
      if (out.files > QUARANTINE_MAX_FILES || out.bytes > QUARANTINE_MAX_TOTAL_BYTES) {
        throw new HubError("E_EXTRACTION_POLICY", "upstream tree exceeds quarantine caps");
      }
      writeFileSync(join(destDir, ...rel.split("/")), bytes);
      out.manifest.push({ blobSha256: blobDigest(bytes), kind: "file", path: rel, scope });
    } else {
      throw new HubError("E_EXTRACTION_POLICY", `non-regular file forbidden in upstream tree: ${rel}`);
    }
  }
}

/**
 * Extract declared roots + provenance files from a fetched checkout.
 * `destDir` must be an empty directory; admitted content preserves
 * upstream-relative posix paths. Returns the sorted manifest plus the
 * selected-tree digest and the vendored-snapshot digest.
 */
export function extractSelectedRoots(
  repoDir: string,
  roots: readonly string[],
  provenanceFiles: readonly string[],
  destDir: string,
): ExtractedTree {
  const base = resolve(repoDir);
  const out: Collector = { bytes: 0, files: 0, manifest: [] };
  const admit = (rel: string, scope: ManifestScope): void => {
    assertRelativePosix(rel, "quarantine path");
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) {
      throw new HubError("E_EXTRACTION_POLICY", `path escapes upstream checkout: ${rel}`);
    }
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new HubError("E_EXTRACTION_POLICY", `declared path missing upstream: ${rel}`);
    }
    if (st.isSymbolicLink()) {
      throw new HubError("E_EXTRACTION_POLICY", `symlink forbidden in upstream tree: ${rel}`);
    }
    if (st.isDirectory()) {
      mkdirSync(join(destDir, ...rel.split("/")), { recursive: true });
      copyTree(abs, rel, destDir, scope, out);
    } else if (st.isFile()) {
      checkSpecial(abs, rel);
      const bytes = readFileSync(abs);
      if (bytes.length > QUARANTINE_MAX_FILE_BYTES) {
        throw new HubError("E_EXTRACTION_POLICY", `file exceeds quarantine cap: ${rel}`);
      }
      out.files += 1;
      out.bytes += bytes.length;
      if (out.files > QUARANTINE_MAX_FILES || out.bytes > QUARANTINE_MAX_TOTAL_BYTES) {
        throw new HubError("E_EXTRACTION_POLICY", "upstream tree exceeds quarantine caps");
      }
      const parentParts = rel.split("/");
      parentParts.pop();
      if (parentParts.length > 0) mkdirSync(join(destDir, ...parentParts), { recursive: true });
      writeFileSync(join(destDir, ...rel.split("/")), bytes);
      out.manifest.push({ blobSha256: blobDigest(bytes), kind: "file", path: rel, scope });
    } else {
      throw new HubError("E_EXTRACTION_POLICY", `non-regular file forbidden in upstream tree: ${rel}`);
    }
  };
  for (const root of roots) admit(root, "selected");
  for (const file of provenanceFiles) admit(file, "provenance");
  out.manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const selected = out.manifest.filter((entry) => entry.scope === "selected");
  return { manifest: out.manifest, snapshotDigest: digestEntries(out.manifest), treeDigest: digestEntries(selected) };
}

/**
 * Report SKILL.md packages outside the selected roots (reported, never
 * adopted — explicit-selection-only, Contract A section 4).
 */
export function discoverUnselectedSkills(repoDir: string, roots: readonly string[]): string[] {
  const base = resolve(repoDir);
  const under = (dir: string): boolean => roots.some((root) => dir === root || dir.startsWith(`${root}/`));
  const found: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile() && entry.name === "SKILL.md" && !under(rel) && !found.includes(rel)) {
        found.push(rel);
      }
    }
  };
  walk(base, "");
  return found.sort();
}
