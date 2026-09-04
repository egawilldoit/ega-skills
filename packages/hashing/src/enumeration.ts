import path from 'node:path';
import {
  HashTraversalError,
  traverseFiles,
  type TraversalFile,
  type TraversalRoot,
} from './traversal.js';

export type CanonicalContentKind = 'TEXT' | 'BINARY';

export type CanonicalFileRole =
  | 'skill-body'
  | 'core'
  | 'ega-metadata'
  | 'reference'
  | 'asset'
  | 'script'
  | 'other';

export interface CanonicalContentAnalysis {
  readonly role: CanonicalFileRole;
  readonly blob_hash: string;
  readonly byte_size: number;
  readonly content_kind: CanonicalContentKind;
}

export interface CanonicalFileRecord extends CanonicalContentAnalysis {
  readonly path: string;
}

export type AnalyzeCanonicalFile = (
  file: TraversalFile,
) => CanonicalContentAnalysis | Promise<CanonicalContentAnalysis>;

export class HashDuplicatePathError extends Error {
  readonly code = 'E_HASH_DUPLICATE_PATH' as const;
  readonly path: string;

  constructor(canonicalPath: string) {
    super(`Duplicate canonical package path: ${canonicalPath}`);
    this.name = 'HashDuplicatePathError';
    this.path = canonicalPath;
  }
}

const HASHING_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
]);

const HASHING_EXCLUDED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

export async function enumerateCanonicalFileRecords(
  root: TraversalRoot,
  analyze: AnalyzeCanonicalFile,
): Promise<CanonicalFileRecord[]> {
  const files = await traverseFiles(root, {
    shouldVisit(relativePath) {
      return !isHashingExcludedPath(relativePath);
    },
  });

  return buildCanonicalFileRecords(files, analyze);
}

export async function buildCanonicalFileRecords(
  files: readonly TraversalFile[],
  analyze: AnalyzeCanonicalFile,
): Promise<CanonicalFileRecord[]> {
  const candidates: Array<{ file: TraversalFile; canonicalPath: string }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    const canonicalPath = canonicalPackagePath(file.relativePath);
    if (isHashingExcludedCanonicalPath(canonicalPath)) {
      continue;
    }
    if (seen.has(canonicalPath)) {
      throw new HashDuplicatePathError(canonicalPath);
    }
    seen.add(canonicalPath);
    candidates.push({ file, canonicalPath });
  }

  candidates.sort((left, right) => compareUtf16(left.canonicalPath, right.canonicalPath));

  const records: CanonicalFileRecord[] = [];
  for (const candidate of candidates) {
    const analysis = await analyze(candidate.file);
    records.push(Object.freeze({
      path: candidate.canonicalPath,
      role: analysis.role,
      blob_hash: analysis.blob_hash,
      byte_size: analysis.byte_size,
      content_kind: analysis.content_kind,
    }));
  }

  return records;
}

export function canonicalPackagePath(relativePath: string): string {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw canonicalPathEscape(relativePath);
  }

  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw canonicalPathEscape(relativePath);
  }

  return segments.join('/');
}

export function isHashingExcludedPath(relativePath: string): boolean {
  return isHashingExcludedCanonicalPath(canonicalPackagePath(relativePath));
}

function isHashingExcludedCanonicalPath(canonicalPath: string): boolean {
  const segments = canonicalPath.split('/');
  const firstSegment = segments[0];
  if (firstSegment !== undefined && HASHING_EXCLUDED_DIRECTORIES.has(firstSegment)) {
    return true;
  }

  return segments.length === 1
    && firstSegment !== undefined
    && HASHING_EXCLUDED_FILES.has(firstSegment);
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalPathEscape(relativePath: string): HashTraversalError {
  return new HashTraversalError(
    'E_HASH_PATH_ESCAPE',
    relativePath,
    `Canonical package path is not a safe relative path: ${relativePath}`,
  );
}
