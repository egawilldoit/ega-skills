// Contract E publication lifecycle seam.
//
// The store is intentionally an in-memory control-plane primitive: publishing
// retains an immutable artifact, while revocation is a separate mutable marker.
// It never reads or writes .egaskills.yaml/.egaskills.lock.

import {
  REMOTE_PROJECT_ERROR_CODES,
  RemoteProjectError,
  verifyProjectContext,
  type ProjectContext,
} from "./remote.js";

export interface PublishedProjectContext {
  readonly contextId: string;
  readonly context: ProjectContext;
}

export interface ProjectContextStoreRecord extends PublishedProjectContext {
  readonly revoked: boolean;
}

function fail(code: typeof REMOTE_PROJECT_ERROR_CODES[keyof typeof REMOTE_PROJECT_ERROR_CODES], message: string): never {
  throw new RemoteProjectError(code, message);
}

function assertContextId(contextId: string): void {
  if (typeof contextId !== "string" || contextId.length === 0 || contextId.includes("\u0000")) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "contextId must be a non-empty text identity");
  }
}

export class ProjectContextStore {
  readonly #contexts = new Map<string, ProjectContext>();
  readonly #revoked = new Set<string>();

  publish(input: PublishedProjectContext): ProjectContextStoreRecord {
    assertContextId(input.contextId);
    verifyProjectContext(input.context);
    if (this.#contexts.has(input.contextId)) {
      fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `context ${input.contextId} is already published`);
    }
    // Context artifacts are immutable records. Retain a fresh frozen record so
    // a caller cannot mutate a structurally valid object after publication.
    const context = Object.freeze({ ...input.context });
    this.#contexts.set(input.contextId, context);
    return this.get(input.contextId)!;
  }

  get(contextId: string): ProjectContextStoreRecord | undefined {
    const context = this.#contexts.get(contextId);
    if (context === undefined) return undefined;
    return Object.freeze({
      contextId,
      context,
      revoked: this.#revoked.has(contextId),
    });
  }

  list(): readonly ProjectContextStoreRecord[] {
    return Object.freeze([...this.#contexts.keys()].sort().map((contextId) => this.get(contextId)!));
  }

  revoke(contextId: string): ProjectContextStoreRecord {
    if (!this.#contexts.has(contextId)) {
      fail(REMOTE_PROJECT_ERROR_CODES.CONTEXT_NOT_FOUND, `context ${contextId} is not published`);
    }
    this.#revoked.add(contextId);
    return this.get(contextId)!;
  }

  isRevoked(contextId: string): boolean {
    return this.#revoked.has(contextId);
  }
}

export function createProjectContextStore(): ProjectContextStore {
  return new ProjectContextStore();
}
