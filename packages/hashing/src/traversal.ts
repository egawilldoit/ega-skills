import type { BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type HashTraversalErrorCode =
  | 'E_HASH_LINK_BROKEN'
  | 'E_HASH_LINK_ESCAPE'
  | 'E_HASH_LINK_CYCLE'
  | 'E_HASH_PATH_ESCAPE'
  | 'E_IMPORT_SOURCE_CHANGED';

export class HashTraversalError extends Error {
  readonly code: HashTraversalErrorCode;
  readonly lexicalPath: string;

  constructor(code: HashTraversalErrorCode, lexicalPath: string, message: string) {
    super(message);
    this.name = 'HashTraversalError';
    this.code = code;
    this.lexicalPath = lexicalPath;
  }
}

export interface TraversalRoot {
  readonly lexicalRoot: string;
  readonly realRoot: string;
}

export interface TraversalFile {
  readonly relativePath: string;
  readonly lexicalPath: string;
  readonly realPath: string;
  read(): Promise<Buffer>;
}

interface FileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

class SafeTraversalFile implements TraversalFile {
  readonly relativePath: string;
  readonly lexicalPath: string;
  readonly realPath: string;
  readonly #snapshot: FileSnapshot;

  constructor(
    relativePath: string,
    lexicalPath: string,
    realPath: string,
    snapshot: FileSnapshot,
  ) {
    this.relativePath = relativePath;
    this.lexicalPath = lexicalPath;
    this.realPath = realPath;
    this.#snapshot = snapshot;
  }

  async read(): Promise<Buffer> {
    let handle;
    try {
      handle = await open(this.lexicalPath, 'r');
    } catch (error) {
      if (isSourceMutationFsError(error)) {
        throw sourceChanged(this.lexicalPath);
      }
      throw error;
    }

    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameSnapshot(this.#snapshot, snapshotOf(before))) {
        throw sourceChanged(this.lexicalPath);
      }

      await verifyCurrentRealPath(this.lexicalPath, this.realPath);
      const bytes = await handle.readFile();

      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || !sameSnapshot(this.#snapshot, snapshotOf(after))) {
        throw sourceChanged(this.lexicalPath);
      }
      await verifyCurrentRealPath(this.lexicalPath, this.realPath);

      return bytes;
    } finally {
      await handle.close();
    }
  }
}

export async function resolveTraversalRoot(rootPath: string): Promise<TraversalRoot> {
  const lexicalRoot = path.resolve(rootPath);
  let realRoot: string;

  try {
    realRoot = await realpath(lexicalRoot);
  } catch (error) {
    if (hasFsCode(error, 'ENOENT') || hasFsCode(error, 'ENOTDIR')) {
      throw new Error(`Traversal root does not exist: ${lexicalRoot}`);
    }
    throw error;
  }

  let rootStat: BigIntStats;
  try {
    rootStat = await stat(realRoot, { bigint: true });
  } catch (error) {
    if (hasFsCode(error, 'ENOENT') || hasFsCode(error, 'ENOTDIR')) {
      throw new Error(`Traversal root does not exist: ${lexicalRoot}`);
    }
    throw error;
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`Traversal root is not a directory: ${lexicalRoot}`);
  }

  return Object.freeze({ lexicalRoot, realRoot });
}

export function isPathContained(root: string, candidate: string): boolean {
  const comparisonRoot = securityComparisonPath(root);
  const comparisonCandidate = securityComparisonPath(candidate);
  const relativePath = path.relative(comparisonRoot, comparisonCandidate);

  if (relativePath === '') {
    return true;
  }
  if (path.isAbsolute(relativePath)) {
    return false;
  }

  const firstSegment = relativePath.split(path.sep)[0];
  return firstSegment !== '..';
}

export async function traverseFiles(root: TraversalRoot): Promise<TraversalFile[]> {
  const files: TraversalFile[] = [];
  const activeDirectories = new Set<string>();
  await walkDirectory(root, root.lexicalRoot, root.realRoot, activeDirectories, files);
  return files;
}

export async function resolveTraversalFile(
  root: TraversalRoot,
  relativePath: string,
): Promise<TraversalFile> {
  const lexicalPath = path.resolve(root.lexicalRoot, relativePath);
  if (!isPathContained(root.lexicalRoot, lexicalPath)) {
    throw pathEscape(lexicalPath);
  }

  const candidate = await inspectFileCandidate(root, lexicalPath, relativePath);
  if (candidate === null) {
    throw sourceChanged(lexicalPath);
  }
  return candidate;
}

async function walkDirectory(
  root: TraversalRoot,
  lexicalDirectory: string,
  realDirectory: string,
  activeDirectories: Set<string>,
  files: TraversalFile[],
): Promise<void> {
  const identity = await directoryIdentity(realDirectory);
  if (activeDirectories.has(identity)) {
    throw linkCycle(lexicalDirectory);
  }

  activeDirectories.add(identity);
  try {
    let entries;
    try {
      entries = await readdir(lexicalDirectory, { withFileTypes: true });
    } catch (error) {
      if (isSourceMutationFsError(error)) {
        throw sourceChanged(lexicalDirectory);
      }
      throw error;
    }

    for (const entry of entries) {
      const lexicalPath = path.join(lexicalDirectory, entry.name);
      if (!isPathContained(root.lexicalRoot, lexicalPath)) {
        throw pathEscape(lexicalPath);
      }
      const relativePath = path.relative(root.lexicalRoot, lexicalPath);
      await inspectCandidate(root, lexicalPath, relativePath, activeDirectories, files);
    }
  } finally {
    activeDirectories.delete(identity);
  }
}

async function inspectCandidate(
  root: TraversalRoot,
  lexicalPath: string,
  relativePath: string,
  activeDirectories: Set<string>,
  files: TraversalFile[],
): Promise<void> {
  let candidateStat: BigIntStats;
  try {
    candidateStat = await lstat(lexicalPath, { bigint: true });
  } catch (error) {
    if (isSourceMutationFsError(error)) {
      throw sourceChanged(lexicalPath);
    }
    throw error;
  }

  if (candidateStat.isSymbolicLink()) {
    const targetRealPath = await resolveLinkTarget(lexicalPath);
    if (!isPathContained(root.realRoot, targetRealPath)) {
      throw linkEscape(lexicalPath);
    }

    let targetStat: BigIntStats;
    try {
      targetStat = await stat(targetRealPath, { bigint: true });
    } catch (error) {
      if (hasFsCode(error, 'ENOENT') || hasFsCode(error, 'ENOTDIR')) {
        throw linkBroken(lexicalPath);
      }
      throw error;
    }

    if (targetStat.isDirectory()) {
      await walkDirectory(root, lexicalPath, targetRealPath, activeDirectories, files);
      return;
    }
    if (targetStat.isFile()) {
      files.push(new SafeTraversalFile(
        relativePath,
        lexicalPath,
        targetRealPath,
        snapshotOf(targetStat),
      ));
    }
    return;
  }

  let candidateRealPath: string;
  try {
    candidateRealPath = await realpath(lexicalPath);
  } catch (error) {
    if (isSourceMutationFsError(error)) {
      throw sourceChanged(lexicalPath);
    }
    throw error;
  }

  if (!isPathContained(root.realRoot, candidateRealPath)) {
    throw pathEscape(lexicalPath);
  }

  if (candidateStat.isDirectory()) {
    await walkDirectory(root, lexicalPath, candidateRealPath, activeDirectories, files);
    return;
  }
  if (candidateStat.isFile()) {
    files.push(new SafeTraversalFile(
      relativePath,
      lexicalPath,
      candidateRealPath,
      snapshotOf(candidateStat),
    ));
  }
}

async function inspectFileCandidate(
  root: TraversalRoot,
  lexicalPath: string,
  relativePath: string,
): Promise<TraversalFile | null> {
  let candidateStat: BigIntStats;
  try {
    candidateStat = await lstat(lexicalPath, { bigint: true });
  } catch (error) {
    if (isSourceMutationFsError(error)) {
      throw sourceChanged(lexicalPath);
    }
    throw error;
  }

  if (candidateStat.isSymbolicLink()) {
    const targetRealPath = await resolveLinkTarget(lexicalPath);
    if (!isPathContained(root.realRoot, targetRealPath)) {
      throw linkEscape(lexicalPath);
    }
    const targetStat = await stat(targetRealPath, { bigint: true });
    return targetStat.isFile()
      ? new SafeTraversalFile(relativePath, lexicalPath, targetRealPath, snapshotOf(targetStat))
      : null;
  }

  const candidateRealPath = await realpath(lexicalPath);
  if (!isPathContained(root.realRoot, candidateRealPath)) {
    throw pathEscape(lexicalPath);
  }
  return candidateStat.isFile()
    ? new SafeTraversalFile(relativePath, lexicalPath, candidateRealPath, snapshotOf(candidateStat))
    : null;
}

async function resolveLinkTarget(lexicalPath: string): Promise<string> {
  try {
    return await realpath(lexicalPath);
  } catch (error) {
    if (hasFsCode(error, 'ELOOP')) {
      throw linkCycle(lexicalPath);
    }
    if (hasFsCode(error, 'ENOENT') || hasFsCode(error, 'ENOTDIR')) {
      throw linkBroken(lexicalPath);
    }
    throw error;
  }
}

async function directoryIdentity(realDirectory: string): Promise<string> {
  if (process.platform === 'win32') {
    return `path:${securityComparisonPath(realDirectory)}`;
  }

  const directoryStat = await stat(realDirectory, { bigint: true });
  return `inode:${directoryStat.dev}:${directoryStat.ino}`;
}

async function verifyCurrentRealPath(lexicalPath: string, expectedRealPath: string): Promise<void> {
  let currentRealPath: string;
  try {
    currentRealPath = await realpath(lexicalPath);
  } catch (error) {
    if (isSourceMutationFsError(error) || hasFsCode(error, 'ELOOP')) {
      throw sourceChanged(lexicalPath);
    }
    throw error;
  }

  if (securityComparisonPath(currentRealPath) !== securityComparisonPath(expectedRealPath)) {
    throw sourceChanged(lexicalPath);
  }
}

function snapshotOf(fileStat: BigIntStats): FileSnapshot {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    mode: fileStat.mode,
    size: fileStat.size,
    mtimeNs: fileStat.mtimeNs,
    ctimeNs: fileStat.ctimeNs,
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function securityComparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasFsCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function isSourceMutationFsError(error: unknown): boolean {
  return hasFsCode(error, 'ENOENT')
    || hasFsCode(error, 'ENOTDIR')
    || hasFsCode(error, 'EISDIR');
}

function pathEscape(lexicalPath: string): HashTraversalError {
  return new HashTraversalError(
    'E_HASH_PATH_ESCAPE',
    lexicalPath,
    `Traversal path escapes lexical root: ${lexicalPath}`,
  );
}

function linkBroken(lexicalPath: string): HashTraversalError {
  return new HashTraversalError(
    'E_HASH_LINK_BROKEN',
    lexicalPath,
    `Link target is broken: ${lexicalPath}`,
  );
}

function linkEscape(lexicalPath: string): HashTraversalError {
  return new HashTraversalError(
    'E_HASH_LINK_ESCAPE',
    lexicalPath,
    `Link target escapes traversal root: ${lexicalPath}`,
  );
}

function linkCycle(lexicalPath: string): HashTraversalError {
  return new HashTraversalError(
    'E_HASH_LINK_CYCLE',
    lexicalPath,
    `Link cycle detected: ${lexicalPath}`,
  );
}

function sourceChanged(lexicalPath: string): HashTraversalError {
  return new HashTraversalError(
    'E_IMPORT_SOURCE_CHANGED',
    lexicalPath,
    `Import source changed during traversal: ${lexicalPath}`,
  );
}
