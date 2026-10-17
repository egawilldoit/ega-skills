// Contract E publication lifecycle seam.
//
// The store retains an immutable context artifact, while revocation is a
// separate mutable marker. Its persistence adapter is control-plane-owned and
// never reads or writes .egaskills.yaml/.egaskills.lock.
//
// This is the smallest durable seam ported from the historical
// packages/project/src/context-store.ts (PR #77/#78): load-on-construction,
// revoke persistence, and an atomic temp+rename file adapter. It does not
// re-introduce the local HTTP control-plane handler or the hosted authority
// record; those concerns are owned by the current candidate's authenticated
// control-plane/Supabase path.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifyProjectContext, type ProjectContextDocument } from "./remote-projects.js";

export interface PublishedProjectContext {
  readonly contextId: string;
  readonly context: ProjectContextDocument;
}

export interface ProjectContextStoreRecord extends PublishedProjectContext {
  readonly revoked: boolean;
}

/** Durable control-plane seam. Implementations may be a database adapter or
 * the file adapter below; the MCP runtime never receives this capability. */
export interface ProjectContextPersistence {
  load(): readonly ProjectContextStoreRecord[];
  save(record: ProjectContextStoreRecord): void;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Deep-copy a JSON-shaped value and freeze every level of the copy. Retaining
 * a deep copy means the store shares no mutable object with the caller (not
 * even the nested `payload`), and freezing every level means no returned
 * nested object or array can be mutated after publication. */
function freezeContext<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeContext(item))) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) copy[key] = freezeContext(nested);
    return Object.freeze(copy) as T;
  }
  return value;
}

function assertContextId(contextId: string): void {
  if (typeof contextId !== "string" || contextId.length === 0 || contextId.includes("\u0000")) {
    fail("contextId must be a non-empty text identity");
  }
}

export class ProjectContextStore {
  readonly #contexts = new Map<string, ProjectContextDocument>();
  readonly #revoked = new Set<string>();
  readonly #persistence: ProjectContextPersistence | undefined;

  constructor(persistence?: ProjectContextPersistence) {
    this.#persistence = persistence;
    for (const record of persistence?.load() ?? []) {
      assertContextId(record.contextId);
      if (typeof record.revoked !== "boolean") {
        fail(`context ${record.contextId} has an invalid revocation state`);
      }
      verifyProjectContext(record.context);
      if (this.#contexts.has(record.contextId)) {
        fail(`context ${record.contextId} is duplicated in persistence`);
      }
      this.#contexts.set(record.contextId, freezeContext(record.context));
      if (record.revoked) this.#revoked.add(record.contextId);
    }
  }

  publish(input: PublishedProjectContext): ProjectContextStoreRecord {
    assertContextId(input.contextId);
    verifyProjectContext(input.context);
    if (this.#contexts.has(input.contextId)) {
      fail(`context ${input.contextId} is already published`);
    }
    // Context artifacts are immutable records. Retain a deep-frozen copy so a
    // caller cannot mutate a structurally valid object after publication: the
    // retained context shares no object with the caller's input graph, every
    // nested field (including `payload`) is frozen, and no returned nested
    // object can be mutated.
    const context = freezeContext(input.context);
    const record = Object.freeze({ contextId: input.contextId, context, revoked: false });
    // Persistence is the visibility boundary. A failed durable write must not
    // leave a context addressable in this process.
    this.#persistence?.save(record);
    this.#contexts.set(input.contextId, context);
    return record;
  }

  get(contextId: string): ProjectContextStoreRecord | undefined {
    const context = this.#contexts.get(contextId);
    if (context === undefined) return undefined;
    return Object.freeze({ contextId, context, revoked: this.#revoked.has(contextId) });
  }

  list(): readonly ProjectContextStoreRecord[] {
    return Object.freeze([...this.#contexts.keys()].sort().map((contextId) => this.get(contextId)!));
  }

  revoke(contextId: string): ProjectContextStoreRecord {
    if (!this.#contexts.has(contextId)) {
      fail(`context ${contextId} is not published`);
    }
    const context = this.#contexts.get(contextId)!;
    const record = Object.freeze({ contextId, context, revoked: true });
    // Do not expose the revocation until its durable marker is written.
    this.#persistence?.save(record);
    this.#revoked.add(contextId);
    return record;
  }

  isRevoked(contextId: string): boolean {
    return this.#revoked.has(contextId);
  }
}

export function createProjectContextStore(persistence?: ProjectContextPersistence): ProjectContextStore {
  return new ProjectContextStore(persistence);
}

/** Small single-writer local/dev adapter for staging/integration tests.
 * Production may replace it with the authenticated database control-plane
 * implementation. Cross-process coordination is intentionally not provided by
 * this file adapter. */
export class FileProjectContextPersistence implements ProjectContextPersistence {
  constructor(
    readonly path: string,
    private readonly renameFile: typeof renameSync = renameSync,
    private readonly removePath: (path: string, options: { recursive?: boolean; force?: boolean }) => void = (path, options) => rmSync(path, options),
  ) {}

  load(): readonly ProjectContextStoreRecord[] {
    if (!existsSync(this.path)) return [];
    const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(value)) throw new Error("context persistence must contain an array");
    for (const [index, record] of value.entries()) {
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        throw new Error(`context persistence record ${index} must be an object`);
      }
      const candidate = record as Record<string, unknown>;
      if (typeof candidate["contextId"] !== "string" || typeof candidate["context"] !== "object" || candidate["context"] === null || Array.isArray(candidate["context"]) || typeof candidate["revoked"] !== "boolean") {
        throw new Error(`context persistence record ${index} has an invalid shape`);
      }
    }
    return value as readonly ProjectContextStoreRecord[];
  }

  save(record: ProjectContextStoreRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryDirectory = mkdtempSync(join(dirname(this.path), ".ega-context-store-"));
    const temporaryPath = join(temporaryDirectory, "contexts.json");
    let backupDirectory: string | undefined;
    let retainedBackupPath: string | undefined;
    let committed = false;
    try {
      const records = this.load().filter((current) => current.contextId !== record.contextId);
      records.push(record);
      records.sort((a, b) => a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0);
      writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`);
      try {
        this.renameFile(temporaryPath, this.path);
        committed = true;
      } catch (error) {
        // Windows does not replace an existing destination with renameSync.
        // Move the old file aside before replacement so a second rename failure
        // can restore the last durable store. Never delete the only durable
        // copy before a complete replacement exists.
        if (!existsSync(this.path)) throw error;
        // Keep the backup outside the temporary directory. If restoration
        // fails, the finally block must not remove the only remaining durable
        // copy while cleaning up the failed replacement.
        backupDirectory = mkdtempSync(join(dirname(this.path), ".ega-context-backup-"));
        const backupPath = join(backupDirectory, "previous-contexts.json");
        this.renameFile(this.path, backupPath);
        try {
          this.renameFile(temporaryPath, this.path);
          committed = true;
        } catch (replacementError) {
          try {
            if (existsSync(this.path)) this.removePath(this.path, { force: true });
            this.renameFile(backupPath, this.path);
          } catch (restoreError) {
            retainedBackupPath = backupPath;
            const replacementMessage = replacementError instanceof Error ? replacementError.message : String(replacementError);
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new Error(`${replacementMessage}; restoration failed: ${restoreMessage}; context backup retained at ${backupPath}`);
          }
          throw replacementError;
        }
        try {
          this.removePath(backupDirectory, { recursive: true, force: true });
        } catch {
          // The replacement is already durable. Keep the backup for manual
          // cleanup rather than reporting a false persistence failure.
        }
        backupDirectory = undefined;
      }
    } finally {
      try {
        this.removePath(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        // Once the replacement is durable, temporary cleanup is housekeeping,
        // not part of the logical save. Before that boundary, preserve the
        // cleanup error so a failed replacement cannot look successful.
        if (!committed) throw error;
      }
      if (backupDirectory !== undefined && retainedBackupPath === undefined) {
        this.removePath(backupDirectory, { recursive: true, force: true });
      }
    }
  }
}
