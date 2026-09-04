// SPEC-003 §5.1.8–§5.1.9 content-addressed blob cache (EGA-565).
//
// Layout: cache/sha256/ab/<remaining-digest> (ab = first 2 lowercase hex).
// TEXT identity uses SPEC-002 canonical bytes; BINARY uses exact bytes —
// the caller supplies those bytes, this module hashes what it is given.
// Write protocol (exact order): temp write → fsync → close → verify SHA →
// atomic rename. The DB transaction may commit references ONLY to finalized
// blobs: orphan blobs after a failed DB tx are acceptable, broken COMMITTED
// references are forbidden. No cache GC, no remote store.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { RegistryError } from "./errors.js";

export const BLOB_HASH_PREFIX = "sha256:";
const DIGEST_HEX_RE = /^[0-9a-f]{64}$/;

let tempCounter = 0;

export interface PutBlobResult {
  readonly hash: string;
  readonly path: string;
  readonly reused: boolean;
}

export function parseBlobDigest(blobHash: string): string {
  if (!blobHash.startsWith(BLOB_HASH_PREFIX)) {
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      `Blob hash ${JSON.stringify(blobHash)} must use the sha256:<hex> identity.`,
    );
  }
  const digest = blobHash.slice(BLOB_HASH_PREFIX.length);
  if (!DIGEST_HEX_RE.test(digest)) {
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      `Blob hash ${JSON.stringify(blobHash)} must carry 64 lowercase hex characters.`,
    );
  }
  return digest;
}

export function cacheBlobPath(cacheSha256Dir: string, digestHex: string): string {
  if (!DIGEST_HEX_RE.test(digestHex)) {
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      "Cache digest must be 64 lowercase hex characters.",
    );
  }
  return join(cacheSha256Dir, digestHex.slice(0, 2), digestHex.slice(2));
}

export function cacheBlobPathForHash(cacheSha256Dir: string, blobHash: string): string {
  return cacheBlobPath(cacheSha256Dir, parseBlobDigest(blobHash));
}

export function sha256DigestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyBytesAtPath(path: string, digestHex: string): boolean {
  let onDisk: Uint8Array;
  try {
    onDisk = readFileSync(path);
  } catch {
    return false;
  }
  return sha256DigestHex(onDisk) === digestHex;
}

function removeTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort: a stray temp file never affects committed references.
  }
}

function writeTempFile(directory: string, bytes: Uint8Array): string {
  tempCounter += 1;
  const tempPath = join(
    directory,
    `tmp-${process.pid}-${Date.now()}-${tempCounter}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
  );
  let fd: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(tempPath, "w");
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure while already handling a write failure.
      }
    }
    removeTempFile(tempPath);
    throw new RegistryError("E_CACHE_WRITE", `Cache write failed for ${tempPath}.`, error);
  }
  return tempPath;
}

export function putCacheBlob(
  cacheSha256Dir: string,
  bytes: Uint8Array,
  expectedHash?: string,
): PutBlobResult {
  const digest = sha256DigestHex(bytes);
  const hash = `${BLOB_HASH_PREFIX}${digest}`;
  if (expectedHash !== undefined && expectedHash !== hash) {
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      `Blob bytes hash to ${hash}, expected ${expectedHash}.`,
    );
  }

  const finalPath = cacheBlobPath(cacheSha256Dir, digest);
  if (existsSync(finalPath)) {
    if (!verifyBytesAtPath(finalPath, digest)) {
      throw new RegistryError(
        "E_CACHE_HASH_MISMATCH",
        `Cached blob at ${finalPath} failed hash verification.`,
      );
    }
    return { hash, path: finalPath, reused: true };
  }

  const subdir = join(cacheSha256Dir, digest.slice(0, 2));
  const tempPath = writeTempFile(subdir, bytes);
  if (!verifyBytesAtPath(tempPath, digest)) {
    removeTempFile(tempPath);
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      "Staged cache blob failed SHA verification before finalize.",
    );
  }
  try {
    renameSync(tempPath, finalPath);
  } catch (error) {
    removeTempFile(tempPath);
    if (existsSync(finalPath)) {
      if (!verifyBytesAtPath(finalPath, digest)) {
        throw new RegistryError(
          "E_CACHE_HASH_MISMATCH",
          `Cached blob at ${finalPath} failed hash verification.`,
        );
      }
      return { hash, path: finalPath, reused: true };
    }
    throw new RegistryError("E_CACHE_WRITE", `Cache finalize failed for ${finalPath}.`, error);
  }
  return { hash, path: finalPath, reused: false };
}

export function getCacheBlob(cacheSha256Dir: string, expectedHash: string): Uint8Array {
  const digest = parseBlobDigest(expectedHash);
  const finalPath = cacheBlobPath(cacheSha256Dir, digest);
  let onDisk: Uint8Array;
  try {
    onDisk = readFileSync(finalPath);
  } catch (error) {
    // A reference to a missing blob is a broken reference: verification fails.
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      `Cached blob ${expectedHash} is missing at ${finalPath}.`,
      error,
    );
  }
  if (sha256DigestHex(onDisk) !== digest) {
    throw new RegistryError(
      "E_CACHE_HASH_MISMATCH",
      `Cached blob at ${finalPath} failed hash verification before read.`,
    );
  }
  return onDisk;
}
