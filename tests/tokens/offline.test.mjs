import assert from "node:assert/strict";
import test from "node:test";

test("initializes and counts with network access disabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access is disabled by TEST-002");
  };

  try {
    const { tokenEstimator } = await import("../../packages/schema/dist/index.js");
    assert.equal(tokenEstimator?.id, "ega-o200k-v1");
    assert.equal(tokenEstimator.count("Hello"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
