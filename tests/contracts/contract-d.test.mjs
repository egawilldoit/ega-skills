import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VALIDATOR = join(REPO, "scripts", "contracts", "validate-contract-d.mjs");
const VECTOR = join(REPO, "scripts", "contracts", "examples", "contract-d", "hosted-runtime.json");

function readVector() {
  return readFileSync(VECTOR, "utf8");
}

function withVector(mutator, fn) {
  const value = JSON.parse(readVector());
  mutator(value);
  const directory = mkdtempSync(join(tmpdir(), "ega-contract-d-"));
  const vectorPath = join(directory, "hosted-runtime.json");
  writeFileSync(vectorPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    return fn(vectorPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runOk() {
  return execFileSync("node", [VALIDATOR], { encoding: "utf8" });
}

function runBad(vectorPath) {
  try {
    execFileSync("node", [VALIDATOR], {
      encoding: "utf8",
      env: { ...process.env, EGA_CONTRACT_D_VECTOR: vectorPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  throw new Error("Contract D validator unexpectedly passed");
}

test("Contract D vector freezes the hosted MCP surface and boundaries", () => {
  const output = runOk();
  assert.match(output, /CONTRACT-D-OK/);
  assert.match(output, /exactly four tools/);
  assert.match(output, /startup integrity order valid/);
  assert.match(output, /scope matrix valid/);
});

test("Contract D rejects any fifth MCP tool", () => {
  const output = withVector((vector) => vector.tools.names.push("admin"), runBad);
  assert.match(output, /E_HOSTED_TOOLS/);
});

test("Contract D rejects inspect without explicit release or context scope", () => {
  const output = withVector((vector) => {
    vector.scope.inspect_get_content.requires_explicit_scope = false;
  }, runBad);
  assert.match(output, /E_SCOPE_CONTRACT/);
});

test("Contract D rejects a weakened transport limit", () => {
  const output = withVector((vector) => {
    vector.transport.limits.max_request_bytes = 0;
  }, runBad);
  assert.match(output, /E_TRANSPORT_LIMIT/);
});

test("Contract D rejects startup that marks healthy before deny policy", () => {
  const output = withVector((vector) => {
    const last = vector.startup.integrity_order.length - 1;
    [vector.startup.integrity_order[last - 1], vector.startup.integrity_order[last]] =
      [vector.startup.integrity_order[last], vector.startup.integrity_order[last - 1]];
  }, runBad);
  assert.match(output, /E_STARTUP_INTEGRITY/);
});

test("Contract D rejects weakened OAuth flow requirements", () => {
  const output = withVector((vector) => {
    vector.auth.oauth.browser_login = false;
  }, runBad);
  assert.match(output, /E_AUTH/);
});

test("Contract D rejects changed security error codes", () => {
  const output = withVector((vector) => {
    vector.errors.content_denied = "E_NOT_DENIED";
  }, runBad);
  assert.match(output, /E_ERRORS/);
});

test("Contract D rejects incomplete recovery backup scope", () => {
  const output = withVector((vector) => {
    vector.recovery.backup.pop();
  }, runBad);
  assert.match(output, /E_RECOVERY/);
});

test("Contract D rejects hosted tool schema drift", () => {
  const output = withVector((vector) => {
    vector.tools.schemas.resolve.optional.push("project_path");
  }, runBad);
  assert.match(output, /E_HOSTED_SCHEMA/);
});
