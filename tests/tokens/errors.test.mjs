import assert from "node:assert/strict";
import test from "node:test";

test("maps tokenizer initialization failure to E_TOKEN_ESTIMATOR_UNAVAILABLE", async () => {
  let internal;
  try {
    internal = await import("../../packages/schema/dist/token-estimator-internal.js");
  } catch {
    internal = undefined;
  }

  assert.equal(typeof internal?.createTokenEstimator, "function");
  const estimator = internal.createTokenEstimator(() => {
    throw new Error("opaque tokenizer initialization failure");
  });

  assert.throws(
    () => estimator.count("Hello"),
    (error) => error?.code === "E_TOKEN_ESTIMATOR_UNAVAILABLE" &&
      error?.cause === undefined &&
      !String(error.message).includes("opaque tokenizer"),
  );
});

test("does not leak opaque tokenizer encode exceptions", async () => {
  let internal;
  try {
    internal = await import("../../packages/schema/dist/token-estimator-internal.js");
  } catch {
    internal = undefined;
  }

  assert.equal(typeof internal?.createTokenEstimator, "function");
  const estimator = internal.createTokenEstimator(() => ({
    encode() {
      throw new Error("opaque encode failure");
    },
  }));

  assert.throws(
    () => estimator.count("Hello"),
    (error) => error?.code === "E_TOKEN_ESTIMATOR_UNAVAILABLE" &&
      error?.cause === undefined &&
      !String(error.message).includes("opaque encode"),
  );
});
