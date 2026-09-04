import assert from "node:assert/strict";
import test from "node:test";

import {
  isContiguousSubsequence,
  matchesStrongAntiTrigger,
  normalizeIdentifierPhrase,
  normalizeTaskTerms,
} from "../../packages/router/dist/index.js";
import { RouterError } from "../../packages/router/dist/errors.js";

function isRouterError(code) {
  return (error) => error instanceof RouterError && error.code === code;
}

// SPEC-004 §5.1.11 primitives.

test("SPEC-004 §5.1.11: task terms extract Unicode runs lowercased", () => {
  assert.deepEqual(normalizeTaskTerms("  Build-It NOW, please!  "), ["build", "it", "now", "please"]);
  assert.deepEqual(normalizeTaskTerms("Déjà vu 123"), ["déjà", "vu", "123"]);
  assert.deepEqual(normalizeTaskTerms("***"), []);
  assert.deepEqual(normalizeTaskTerms(""), []);
});

test("SPEC-004 §5.1.11: identifier phrases collapse separators, keep + and #", () => {
  assert.equal(normalizeIdentifierPhrase("react-native"), "react native");
  assert.equal(normalizeIdentifierPhrase("a__b..c"), "a b c");
  assert.equal(normalizeIdentifierPhrase("C++"), "c++");
  assert.equal(normalizeIdentifierPhrase("C#"), "c#");
  assert.equal(normalizeIdentifierPhrase("  Vite  "), "vite");
});

test("SPEC-004 §5.1.11: contiguous subsequence is exact", () => {
  assert.equal(isContiguousSubsequence(["a", "b", "c"], ["b", "c"]), true);
  assert.equal(isContiguousSubsequence(["a", "b", "c"], ["a", "c"]), false);
  assert.equal(isContiguousSubsequence(["a"], ["a", "b"]), false);
  assert.equal(isContiguousSubsequence(["a", "b"], []), false);
  assert.equal(isContiguousSubsequence([], []), false);
  assert.equal(isContiguousSubsequence(["a", "b"], ["a", "b"]), true);
});

test("SPEC-004 §5.1.11: strong anti-trigger needs contiguity", () => {
  const terms = normalizeTaskTerms("please do it with no react here");
  assert.equal(matchesStrongAntiTrigger("no-react", terms), true);
  assert.equal(matchesStrongAntiTrigger("react", terms), true);
  assert.equal(matchesStrongAntiTrigger("no-please", terms), false);
  assert.equal(matchesStrongAntiTrigger("***", terms), false);
  assert.equal(matchesStrongAntiTrigger("react", []), false);
});
