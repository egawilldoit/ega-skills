import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { TOKEN_VECTORS } from "./vectors.mjs";

let schema;

before(async () => {
  schema = await import("../../packages/schema/dist/index.js");
});

describe("ega-o200k-v1 frozen estimator contract", () => {
  test("exposes the exact estimator identity", () => {
    assert.equal(schema.tokenEstimator?.id, "ega-o200k-v1");
  });

  test("accepts the complete frozen vector set as compatible", () => {
    assert.doesNotThrow(() =>
      schema.assertTokenEstimatorCompatibility(schema.tokenEstimator, TOKEN_VECTORS),
    );
  });

  for (const vector of TOKEN_VECTORS) {
    test(`${vector.id} counts the exact frozen input`, () => {
      assert.equal(typeof schema.tokenEstimator?.count, "function");
      assert.equal(schema.tokenEstimator.count(vector.input), vector.expectedTokens);
    });
  }

  test("CRLF and LF converge before counting", () => {
    assert.equal(
      schema.tokenEstimator.count("Hello\r\nworld"),
      schema.tokenEstimator.count("Hello\nworld"),
    );
  });

  test("one leading BOM is removed before counting", () => {
    assert.equal(schema.tokenEstimator.count("\uFEFFHello"), schema.tokenEstimator.count("Hello"));
  });

  test("N003 preserves NFC and NFD as code-point-distinct strings", () => {
    const nfc = "café";
    const nfd = "cafe\u0301";
    assert.notEqual(nfc, nfd);
    assert.equal(Number.isInteger(schema.tokenEstimator.count(nfc)), true);
    assert.equal(Number.isInteger(schema.tokenEstimator.count(nfd)), true);
  });

  test("treats <|endoftext|> as ordinary text", () => {
    assert.equal(typeof schema.tokenEstimator?.count, "function");
    const count = schema.tokenEstimator.count("<|endoftext|>");
    assert.equal(Number.isInteger(count), true);
    assert.ok(count > 1, "ordinary text must not receive privileged single-special-token handling");
  });

  test("rejects direct binary input with E_TOKEN_BINARY_INPUT", () => {
    assert.equal(typeof schema.tokenEstimator?.count, "function");
    assert.throws(
      () => schema.tokenEstimator.count(new Uint8Array([0x48, 0x69])),
      (error) => error?.code === "E_TOKEN_BINARY_INPUT",
    );
  });

  test("rejects a wrong estimator identity as incompatible", () => {
    assert.equal(typeof schema.assertTokenEstimatorId, "function");
    assert.throws(
      () => schema.assertTokenEstimatorId("other-estimator"),
      (error) => error?.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
    );
  });

  test("maps a reference-vector mismatch to E_TOKEN_ESTIMATOR_INCOMPATIBLE", () => {
    assert.equal(typeof schema.assertTokenEstimatorCompatibility, "function");
    assert.throws(
      () =>
        schema.assertTokenEstimatorCompatibility(schema.tokenEstimator, [
          { id: "mismatch", input: "Hello", expectedTokens: 999 },
        ]),
      (error) => error?.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
    );
  });
});
