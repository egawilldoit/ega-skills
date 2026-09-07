import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VALIDATOR = join(REPO, "scripts", "contracts", "validate-contract-e.mjs");
const VECTOR = join(REPO, "scripts", "contracts", "examples", "contract-e", "remote-projects.json");

function withVector(mutator, fn) {
  const original = readFileSync(VECTOR, "utf8");
  const value = JSON.parse(original);
  mutator(value);
  writeFileSync(VECTOR, `${JSON.stringify(value, null, 2)}\n`);
  try {
    return fn();
  } finally {
    writeFileSync(VECTOR, original);
  }
}

function runOk() {
  return execFileSync("node", [VALIDATOR], { encoding: "utf8" });
}

function runBad() {
  try {
    execFileSync("node", [VALIDATOR], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  throw new Error("Contract E validator unexpectedly passed");
}

test("Contract E vector freezes immutable remote-project boundaries", () => {
  const output = runOk();
  assert.match(output, /CONTRACT-E-OK/);
  assert.match(output, /immutable contexts/);
  assert.match(output, /single-release locks/);
});

test("Contract E rejects cross-release lock fallback", () => {
  const output = withVector((vector) => {
    vector.lock.cross_release_behavior = "union";
  }, runBad);
  assert.match(output, /E_LOCK/);
});

test("Contract E rejects absolute fingerprint paths", () => {
  const output = withVector((vector) => {
    vector.fingerprint.roots = "absolute-filesystem-paths";
  }, runBad);
  assert.match(output, /E_FINGERPRINT/);
});

test("Contract E rejects context fallback or substitution", () => {
  const output = withVector((vector) => {
    vector.selection.failure_fallback = "personal-stable-release";
  }, runBad);
  assert.match(output, /E_CONTEXT_SELECTION/);
});

test("Contract E rejects mutable context lifecycle", () => {
  const output = withVector((vector) => {
    vector.lifecycle.republication = "reuse-context-id";
  }, runBad);
  assert.match(output, /E_CONTEXT_LIFECYCLE/);
});

test("Contract E rejects incomplete cache identity", () => {
  const output = withVector((vector) => {
    vector.cache.key_fields.pop();
  }, runBad);
  assert.match(output, /E_CONTEXT_CACHE/);
});
