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
import { execFileSync } from "node:child_process";
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
  blob_sha256: string;
  scope: ManifestScope;
}

export interface CanonicalSourceManifestEntry {
  path: string;
  kind: "file";
  blob_sha256: string;
}

export interface ExtractedTree {
  manifest: TreeManifestEntry[];
  treeDigest: string;
  snapshotDigest: string;
}

function blobDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalManifest(entries: readonly TreeManifestEntry[] | readonly CanonicalSourceManifestEntry[]): CanonicalSourceManifestEntry[] {
  const byPath = new Map<string, CanonicalSourceManifestEntry>();
  for (const entry of entries) {
    byPath.set(entry.path, { blob_sha256: entry.blob_sha256, kind: "file", path: entry.path });
  }
  const encoder = new TextEncoder();
  return [...byPath.values()].sort((a, b) => {
    const left = encoder.encode(a.path);
    const right = encoder.encode(b.path);
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      if (left[i] !== right[i]) return (left[i] as number) - (right[i] as number);
    }
    return left.length - right.length;
  });
}

export function canonicalSourceManifestDigest(entries: readonly TreeManifestEntry[] | readonly CanonicalSourceManifestEntry[]): string {
  return `sha256:${sha256Hex(canonicalizeJson(canonicalManifest(entries)))}`;
}

function digestEntries(entries: readonly TreeManifestEntry[]): string {
  return canonicalSourceManifestDigest(entries);
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

function copyTree(
  srcDir: string,
  relBase: string,
  destDir: string,
  scope: ManifestScope,
  out: Collector,
  seenFiles: Set<string>,
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const abs = join(srcDir, entry.name);
    const rel = relBase.length > 0 ? `${relBase}/${entry.name}` : entry.name;
    if (entry.name === ".git" || entry.name === ".gitmodules") {
      throw new HubError("E_EXTRACTION_POLICY", `forbidden upstream entry: ${rel}`);
    }
    checkSpecial(abs, rel);
    if (entry.isDirectory()) {
      mkdirSync(join(destDir, ...rel.split("/")), { recursive: true });
      copyTree(abs, rel, destDir, scope, out, seenFiles);
    } else if (entry.isFile()) {
      // Contract A uses canonical set-union semantics for selected roots and
      // provenance. Overlapping declarations must produce one manifest entry
      // so extraction and apply-time tree digests cannot disagree.
      if (seenFiles.has(rel)) continue;
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
      out.manifest.push({ blob_sha256: blobDigest(bytes), kind: "file", path: rel, scope });
      seenFiles.add(rel);
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
  const seenFiles = new Set<string>();
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
      copyTree(abs, rel, destDir, scope, out, seenFiles);
    } else if (st.isFile()) {
      if (seenFiles.has(rel)) return;
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
      out.manifest.push({ blob_sha256: blobDigest(bytes), kind: "file", path: rel, scope });
      seenFiles.add(rel);
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
 * Digest an already-extracted tree (e.g. apply-time stage verification)
 * without copying: entries under `roots` are selected, the rest provenance.
 */
export function digestStagedTree(stageDir: string, roots: readonly string[]): Omit<ExtractedTree, "manifest"> & { manifest: TreeManifestEntry[] } {
  const base = resolve(stageDir);
  const manifest: TreeManifestEntry[] = [];
  const under = (rel: string): boolean => roots.some((root) => rel === root || rel.startsWith(`${root}/`));
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === ".git" || entry.name === ".gitmodules") {
        throw new HubError("E_EXTRACTION_POLICY", `forbidden entry in staged tree: ${childRel}`);
      }
      checkSpecial(childAbs, childRel);
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        const bytes = readFileSync(childAbs);
        manifest.push({
          blob_sha256: blobDigest(bytes),
          kind: "file",
          path: childRel,
          scope: under(childRel) ? "selected" : "provenance",
        });
      } else {
        throw new HubError("E_EXTRACTION_POLICY", `non-regular file in staged tree: ${childRel}`);
      }
    }
  };
  walk(base, "");
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const selected = manifest.filter((entry) => entry.scope === "selected");
  return { manifest, snapshotDigest: digestEntries(manifest), treeDigest: digestEntries(selected) };
}

interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  size: number;
  path: string;
}

function gitTreeEntries(repoDir: string, commit: string): GitTreeEntry[] {
  let raw: Uint8Array;
  try {
    execFileSync("git", ["-C", repoDir, "cat-file", "-e", `${commit}^{commit}`], { stdio: ["ignore", "pipe", "pipe"] });
    raw = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "-z", "-l", "--full-tree", commit], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new HubError("E_PLAN_FETCH", `cannot read exact upstream Git tree: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  const entries: GitTreeEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  while (start < raw.length) {
    let end = start;
    while (end < raw.length && raw[end] !== 0) end += 1;
    if (end === start) { start += 1; continue; }
    let tab = start;
    while (tab < end && raw[tab] !== 9) tab += 1;
    if (tab >= end) throw new HubError("E_EXTRACTION_POLICY", "malformed Git tree entry");
    const header = decoder.decode(raw.slice(start, tab));
    const match = header.match(/^(\d+) ([a-z]+) ([0-9a-f]{40})\s+(\d+)$/);
    if (!match) {
      throw new HubError("E_EXTRACTION_POLICY", "malformed Git tree entry");
    }
    const path = decoder.decode(raw.slice(tab + 1, end));
    assertRelativePosix(path, "upstream Git path");
    entries.push({ mode: match[1] as string, type: match[2] as string, object: match[3] as string, size: Number(match[4]), path });
    start = end + 1;
  }
  return entries;
}

function admittedGitPath(path: string, roots: readonly string[], provenanceFiles: readonly string[]): ManifestScope | undefined {
  if (roots.some((root) => path === root || path.startsWith(`${root}/`))) return "selected";
  if (provenanceFiles.includes(path)) return "provenance";
  return undefined;
}

/** Extract directly from the exact commit's Git tree and blob objects.
 * No checkout, attributes, smudge, clean filter, textconv, or LFS operation
 * is involved. The destination receives the exact committed blob bytes. */
export function extractSelectedRootsFromGit(
  repoDir: string,
  commit: string,
  roots: readonly string[],
  provenanceFiles: readonly string[],
  destDir: string,
): ExtractedTree {
  for (const path of [...roots, ...provenanceFiles]) assertRelativePosix(path, "quarantine path");
  const entries = gitTreeEntries(repoDir, commit);
  const admitted = entries.filter((entry) => admittedGitPath(entry.path, roots, provenanceFiles) !== undefined);
  const declaredPresent = new Set(admitted.map((entry) => entry.path));
  for (const root of roots) {
    if (!entries.some((entry) => entry.path === root || entry.path.startsWith(`${root}/`))) {
      throw new HubError("E_EXTRACTION_POLICY", `declared path missing upstream: ${root}`);
    }
  }
  for (const file of provenanceFiles) {
    if (!declaredPresent.has(file)) throw new HubError("E_EXTRACTION_POLICY", `declared path missing upstream: ${file}`);
  }
  const out: Collector = { bytes: 0, files: 0, manifest: [] };
  const seen = new Set<string>();
  for (const entry of admitted) {
    const scope = admittedGitPath(entry.path, roots, provenanceFiles) as ManifestScope;
    if (seen.has(entry.path)) continue;
    if (entry.path === ".gitmodules" || entry.path.endsWith("/.gitmodules") || entry.path === ".git") {
      throw new HubError("E_EXTRACTION_POLICY", `forbidden upstream entry: ${entry.path}`);
    }
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new HubError("E_EXTRACTION_POLICY", `non-regular Git entry forbidden in upstream tree: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size > QUARANTINE_MAX_FILE_BYTES) {
      throw new HubError("E_EXTRACTION_POLICY", `file exceeds quarantine cap: ${entry.path}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = execFileSync("git", ["-C", repoDir, "cat-file", "blob", entry.object], {
        encoding: "buffer",
        maxBuffer: QUARANTINE_MAX_FILE_BYTES + 1,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      throw new HubError("E_EXTRACTION_POLICY", `cannot read upstream Git blob for ${entry.path}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    if (bytes.length !== entry.size) throw new HubError("E_EXTRACTION_POLICY", `Git blob size mismatch: ${entry.path}`);
    out.files += 1;
    out.bytes += bytes.length;
    if (out.files > QUARANTINE_MAX_FILES || out.bytes > QUARANTINE_MAX_TOTAL_BYTES) {
      throw new HubError("E_EXTRACTION_POLICY", "upstream tree exceeds quarantine caps");
    }
    const parent = join(destDir, ...entry.path.split("/").slice(0, -1));
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(destDir, ...entry.path.split("/")), bytes);
    out.manifest.push({ blob_sha256: blobDigest(bytes), kind: "file", path: entry.path, scope });
    seen.add(entry.path);
  }
  const selected = out.manifest.filter((entry) => entry.scope === "selected");
  return { manifest: canonicalManifest(out.manifest).map((entry) => ({ ...entry, scope: (selected.some((x) => x.path === entry.path) ? "selected" : "provenance") as ManifestScope })), treeDigest: digestEntries(selected), snapshotDigest: digestEntries(out.manifest) };
}

/** Discover unselected SKILL.md roots from raw Git tree paths. */
export function discoverUnselectedSkillsFromGit(repoDir: string, commit: string, roots: readonly string[]): string[] {
  const entries = gitTreeEntries(repoDir, commit);
  const under = (dir: string): boolean => roots.some((root) => dir === root || dir.startsWith(`${root}/`));
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.path.endsWith("/SKILL.md") && entry.path !== "SKILL.md") continue;
    const dir = entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length);
    if (!under(dir)) found.add(dir);
  }
  return [...found].sort();
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
