import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
