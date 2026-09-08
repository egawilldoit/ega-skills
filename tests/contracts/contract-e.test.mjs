import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VALIDATOR = join(REPO, "scripts", "contracts", "validate-contract-e.mjs");
const VECTOR = join(REPO, "scripts", "contracts", "examples", "contract-e", "remote-projects.json");

function withVector(mutator, fn) {
  const value = JSON.parse(readFileSync(VECTOR, "utf8"));
  mutator(value);
  const directory = mkdtempSync(join(tmpdir(), "ega-contract-e-"));
  const vectorPath = join(directory, "remote-projects.json");
  writeFileSync(vectorPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    return fn(vectorPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runOk(vectorPath = VECTOR) {
  return execFileSync("node", [VALIDATOR], { encoding: "utf8", env: { ...process.env, EGA_CONTRACT_E_VECTOR: vectorPath } });
}

function runBad(vectorPath = VECTOR) {
  try {
    execFileSync("node", [VALIDATOR], {
      encoding: "utf8",
      env: { ...process.env, EGA_CONTRACT_E_VECTOR: vectorPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
