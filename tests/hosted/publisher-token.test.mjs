import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { vercelToken } from "../../scripts/hosted/publish-production.mjs";

test("publisher credential requires an owner-only regular file without symlinks", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "publisher-token-"));
  try {
    const file = join(dir, "token");
    writeFileSync(file, "test-token\n", { mode: 0o600 });
    assert.equal(vercelToken(file), "test-token");
    chmodSync(file, 0o644);
    assert.throws(() => vercelToken(file), { code: "E_VERCEL_TOKEN" });
    chmodSync(file, 0o600);
    const link = join(dir, "link");
    symlinkSync(file, link);
    assert.throws(() => vercelToken(link), { code: "E_VERCEL_TOKEN" });
    assert.throws(() => vercelToken(dir), { code: "E_VERCEL_TOKEN" });
    writeFileSync(file, "");
    assert.throws(() => vercelToken(file), { code: "E_VERCEL_TOKEN" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
