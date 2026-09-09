import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ImmutableObjectStore {
  put(digest: string, bytes: Uint8Array): Promise<void>;
  get(digest: string): Promise<Uint8Array | null>;
}

function verifyDigest(digest: string, bytes: Uint8Array): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("invalid object digest");
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== digest) throw new Error("object digest mismatch");
}

/** Local disposable object store used for non-production smoke and adapters. */
export class FileObjectStore implements ImmutableObjectStore {
  constructor(private readonly root: string) {}
  async put(digest: string, bytes: Uint8Array): Promise<void> {
    verifyDigest(digest, bytes);
    const path = join(this.root, digest.slice("sha256:".length, "sha256:".length + 2), digest.slice("sha256:".length));
    await mkdir(dirname(path), { recursive: true });
    try {
      const existing = await readFile(path);
      verifyDigest(digest, existing);
      return;
    } catch {
      await writeFile(path, bytes, { flag: "wx" }).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  }
  async get(digest: string): Promise<Uint8Array | null> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("invalid object digest");
    try { const bytes = await readFile(join(this.root, digest.slice(7, 9), digest.slice(7))); verifyDigest(digest, bytes); return bytes; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

/** Minimal R2/S3-compatible HTTP adapter; credentials stay outside this package. */
export class HttpObjectStore implements ImmutableObjectStore {
  constructor(private readonly baseUrl: string, private readonly headers: HeadersInit = {}) {}
  async put(digest: string, bytes: Uint8Array): Promise<void> {
    verifyDigest(digest, bytes);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/${digest}`, { method: "PUT", headers: this.headers, body: Buffer.from(bytes) });
    if (!response.ok) throw new Error(`object store put failed: ${response.status}`);
  }
  async get(digest: string): Promise<Uint8Array | null> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("invalid object digest");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/${digest}`, { headers: this.headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`object store get failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); verifyDigest(digest, bytes); return bytes;
  }
}
