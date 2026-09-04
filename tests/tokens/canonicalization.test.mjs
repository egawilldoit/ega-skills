import assert from "node:assert/strict";
import test from "node:test";

const internal = await import("../../packages/schema/dist/token-estimator-internal.js");

test("canonicalizes BOM and line endings before ordinary encoding", () => {
  const calls = [];
  const estimator = internal.createTokenEstimator(() => ({
    encode(text, allowedSpecial, disallowedSpecial) {
      calls.push({ text, allowedSpecial, disallowedSpecial });
      return [];
    },
  }));

  estimator.count("\uFEFFHello\r\nworld\r");

  assert.deepEqual(calls, [
    {
      text: "Hello\nworld\n",
      allowedSpecial: [],
      disallowedSpecial: [],
    },
  ]);
});

test("removes exactly one leading BOM", () => {
  let encodedText;
  const estimator = internal.createTokenEstimator(() => ({
    encode(text) {
      encodedText = text;
      return [];
    },
  }));

  estimator.count("\uFEFF\uFEFFHello");
  assert.equal(encodedText, "\uFEFFHello");
});

test("preserves NFC and NFD as code-point-distinct encoder inputs", () => {
  const inputs = [];
  const estimator = internal.createTokenEstimator(() => ({
    encode(text) {
      inputs.push(text);
      return [];
    },
  }));

  estimator.count("café");
  estimator.count("cafe\u0301");

  assert.deepEqual(inputs, ["café", "cafe\u0301"]);
  assert.notEqual(inputs[0], inputs[1]);
});

test("rejects binary before tokenizer initialization", () => {
  let initializationCount = 0;
  const estimator = internal.createTokenEstimator(() => {
    initializationCount += 1;
    return {
      encode() {
        throw new Error("binary input must never reach the encoder");
      },
    };
  });

  assert.throws(
    () => estimator.count(new Uint8Array([0x48, 0x69])),
    (error) => error?.code === "E_TOKEN_BINARY_INPUT",
  );
  assert.equal(initializationCount, 0);
});
