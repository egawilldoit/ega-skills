import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MutationLock {
  release(): void;
}

export interface MutationLockOptions {
  readonly error: (message: string) => Error;
  /** Validate transaction metadata before a dead owner is reclaimed. */
  readonly beforeReclaim?: () => void;
}

interface Owner {
  readonly pid: number;
  readonly token: string;
}

interface Snapshot {
  readonly ownerPath: string;
  readonly marker: string;
}

let generation = 0;

function token(): string {
  generation += 1;
  const nodeProcess = (globalThis as { process?: { pid?: number } }).process;
  const seed = `${nodeProcess?.pid ?? 0}:${Date.now()}:${generation}:${Math.random()}`;
  return createHash("sha256").update(new TextEncoder().encode(seed)).digest("hex");
}

function parseOwner(path: string): Owner | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid < 1 || typeof record.token !== "string" || !/^[0-9a-f]{64}$/.test(record.token)) return undefined;
    return { pid: record.pid, token: record.token };
  } catch {
    return undefined;
  }
}

function snapshot(lockPath: string): Snapshot | undefined {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) return undefined;
  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const owners = entries.filter((entry) => entry.name.startsWith("owner."));
  if (owners.length !== 1 || !owners[0]?.isFile()) return undefined;
  const ownerPath = join(lockPath, owners[0].name);
  let marker: string;
  try {
    marker = readFileSync(ownerPath, "utf8");
  } catch {
    return undefined;
  }
  if (parseOwner(ownerPath) === undefined) return undefined;
  return { ownerPath, marker };
}

function ownerAlive(ownerPath: string): boolean {
  const owner = parseOwner(ownerPath);
  if (owner === undefined) return true;
  try {
    const nodeProcess = (globalThis as { process?: { kill(pid: number, signal: number): void } }).process;
    if (nodeProcess === undefined) return true;
    nodeProcess.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

function create(lockPath: string): Snapshot {
  mkdirSync(lockPath);
  const nodeProcess = (globalThis as { process?: { pid?: number } }).process;
  const owner = { pid: nodeProcess?.pid ?? 0, token: token() } satisfies Owner;
  const ownerPath = join(lockPath, `owner.${owner.token}`);
  const marker = JSON.stringify(owner);
  try {
    const fd = openSync(ownerPath, "wx");
    try {
      writeSync(fd, marker);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    try { rmSync(ownerPath, { force: false }); } catch { /* best effort for a failed acquisition */ }
    try { rmdirSync(lockPath); } catch { /* another contender may have arrived */ }
    throw error;
  }
  return { marker, ownerPath };
}

/**
 * Acquire an owner-token directory lock. Reclamation is deliberately narrow:
 * only the exact dead owner observed by this attempt may be removed, and the
 * directory is removed only with rmdir so a replacement owner cannot be
 * deleted. Malformed or unreadable owners fail closed.
 */
export function acquireOwnerTokenLock(lockPath: string, options: MutationLockOptions): MutationLock {
  mkdirSync(dirname(lockPath), { recursive: true });
  let owned: Snapshot;
  try {
    owned = create(lockPath);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    const observed = snapshot(lockPath);
    if (observed === undefined || ownerAlive(observed.ownerPath)) throw options.error("mutation lock is held or cannot be read");
    options.beforeReclaim?.();
    try {
      rmSync(observed.ownerPath, { force: false });
      rmdirSync(lockPath);
    } catch {
      throw options.error("mutation lock owner changed during reclamation");
    }
    try {
      owned = create(lockPath);
    } catch {
      throw options.error("mutation lock is held by another process");
    }
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const current = snapshot(lockPath);
      if (current?.ownerPath !== owned.ownerPath || current.marker !== owned.marker) return;
      try { rmSync(owned.ownerPath, { force: false }); } catch { return; }
      try { rmdirSync(lockPath); } catch { /* a replacement owner is now present */ }
    },
  };
}
