import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileObjectStore } from "../../packages/object-store/dist/index.js";

test("immutable file object store verifies content digests and preserves objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ega-objects-"));
  const store = new FileObjectStore(root);
  const bytes = new TextEncoder().encode("immutable release blob");
  const digest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  await store.put(digest, bytes);
  assert.deepEqual([...await store.get(digest)], [...bytes]);
  await assert.rejects(() => store.put("sha256:" + "0".repeat(64), bytes), /digest mismatch/);
  assert.equal(await store.get("sha256:" + "f".repeat(64)), null);
});

test("immutable file object store rejects a corrupt existing object", async () => {
  const root = await mkdtemp(join(tmpdir(), "ega-objects-corrupt-"));
  const store = new FileObjectStore(root);
  const bytes = new TextEncoder().encode("immutable release blob");
  const digest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  const objectDir = join(root, digest.slice(7, 9));
  await mkdir(objectDir, { recursive: true });
  await writeFile(join(objectDir, digest.slice(7)), "corrupt");
  await assert.rejects(() => store.put(digest, bytes), /object digest mismatch/);
});
