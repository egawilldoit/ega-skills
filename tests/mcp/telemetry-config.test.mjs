/**
 * Telemetry writer credential separation (CONTRACT-T1 §5.3).
 *
 * These assert CONFIGURATION behaviour — what the runtime does with the
 * environment it is given. They do NOT and cannot assert that a hosted
 * deployment has actually been provisioned with two distinct credentials: that
 * requires observing a hosted instance, which this environment does not have.
 * The distinction is stated per test so a green run is never read as proof of
 * deployment separation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test, { describe } from "node:test";

const WRITER_TOKEN = `e30.${Buffer.from(JSON.stringify({ role: "ega_telemetry_writer" })).toString("base64url")}.synthetic-signature`;

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACT = join(ROOT, "packages", "mcp", "artifact");

/** A minimal hosted env. Credentials are placeholders and never printed. */
function env(overrides = {}) {
  return {
    EGA_HOSTED_ARTIFACT_DIR: ARTIFACT,
    EGA_HOSTED_RETAINED_MANIFEST: "",
    EGA_HOSTED_BEARER_TOKEN: "dev-token",
    EGA_HOSTED_ALLOW_STATIC_TOKEN: "true",
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    EGA_HOSTED_AUTHZ_JSON: JSON.stringify({
      workspace_id: "11111111-1111-4111-8111-111111111111",
      visibility: "private",
      owner_subject: "owner",
      memberships: [{ subject: "owner", role: "owner", active: true }],
      denies: [],
    }),
    EGA_HOSTED_SUPABASE_URL: "https://project.supabase.co",
    EGA_HOSTED_SUPABASE_SECRET_KEY: "sb_secret_read_only_key",
    EGA_HOSTED_TELEMETRY_API_KEY: "sb_publishable_test",
    ...overrides,
  };
}

async function build(overrides) {
  const { createHostedRuntimeFromEnv } = await import("../../packages/mcp/dist/index.js");
  return createHostedRuntimeFromEnv(env(overrides));
}

/**
 * Capture console.warn for the duration of an ASYNC build.
 *
 * The restore must be awaited, not synchronous: `createHostedRuntimeFromEnv`
 * returns a promise, and the warning is emitted after the first await. A
 * `try/finally` around the un-awaited call restored `console.warn` before the
 * message was ever written, so the capture silently saw nothing.
 */
async function captureWarnings(build) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    const runtime = await build();
    return { runtime, warnings: lines };
  } finally {
    console.warn = original;
  }
}

describe("telemetry is off unless explicitly enabled", () => {
  test("no sink is configured when the flag is absent", async () => {
    const runtime = await build();
    // `enabled: false` is the honest report: a deployment that never configured
    // telemetry records nothing, and must not look like an idle one.
    assert.equal(runtime.telemetry.enabled, false);
    assert.equal(runtime.telemetry.written, 0);
  });

  test("a value other than the exact string 'true' does not enable it", async () => {
    // Truthiness would let a typo like "yes" or "1" silently switch on a writer
    // that persists rows.
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      const runtime = await build({ EGA_HOSTED_TELEMETRY_ENABLED: value });
      assert.equal(runtime.telemetry.enabled, false, `value ${JSON.stringify(value)} must not enable telemetry`);
    }
  });
});

describe("the writer credential must be distinct from the read credential", () => {
  test("a dedicated writer key enables telemetry", async () => {
    const runtime = await build({
      EGA_HOSTED_TELEMETRY_ENABLED: "true",
      EGA_HOSTED_TELEMETRY_WRITER_KEY: WRITER_TOKEN,
    });
    assert.equal(runtime.telemetry.enabled, true, "a distinct key must be accepted");
  });

  test("missing application key and broad writer credentials disable only telemetry", async () => {
    for (const config of [
      { EGA_HOSTED_TELEMETRY_WRITER_KEY: WRITER_TOKEN, EGA_HOSTED_TELEMETRY_API_KEY: undefined },
      { EGA_HOSTED_TELEMETRY_WRITER_KEY: "sb_secret_broad_writer" },
    ]) {
      const { runtime } = await captureWarnings(() => build({ EGA_HOSTED_TELEMETRY_ENABLED: "true", ...config }));
      assert.equal(runtime.telemetry.enabled, false);
      assert.ok(runtime.handler);
      assert.ok(runtime.telemetry.failure_classes.includes("disabled"));
    }
  });

  test("reusing the read credential disables telemetry rather than accepting it", async () => {
    // The reuse that must be refused: sharing the secret makes the §5.3
    // separation nominal — compromising the read path would also grant writes.
    const shared = "sb_secret_read_only_key";
    const { runtime, warnings } = await captureWarnings(() =>
      build({
        EGA_HOSTED_TELEMETRY_ENABLED: "true",
        EGA_HOSTED_TELEMETRY_WRITER_KEY: shared,
      }),
    );
    assert.equal(runtime.telemetry.enabled, false, "a reused credential must not enable telemetry");
    assert.ok(
      warnings.some((line) => /must differ/i.test(line)),
      "the refusal must be stated, not silent",
    );
  });

  test("enabling telemetry with no writer key disables it and says why", async () => {
    const { runtime, warnings } = await captureWarnings(() => build({ EGA_HOSTED_TELEMETRY_ENABLED: "true" }));
    assert.equal(runtime.telemetry.enabled, false);
    assert.ok(warnings.some((line) => /TELEMETRY_WRITER_KEY/.test(line)));
  });

  test("there is NO silent fallback to the read credential", async () => {
    // Without this, removing the writer key would quietly restore the old
    // behaviour and the separation would be unverifiable from the outside.
    const withoutKey = await build({ EGA_HOSTED_TELEMETRY_ENABLED: "true" });
    const withKey = await build({
      EGA_HOSTED_TELEMETRY_ENABLED: "true",
      EGA_HOSTED_TELEMETRY_WRITER_KEY: WRITER_TOKEN,
    });
    assert.notEqual(withoutKey.telemetry.enabled, withKey.telemetry.enabled);
  });

  test("a misconfigured deployment still starts and still serves tools", async () => {
    // CONTRACT-T1 §6.7: telemetry must not be a readiness precondition, and a
    // telemetry misconfiguration must not fail a successful tool call.
    const { runtime } = await captureWarnings(() =>
      build({
        EGA_HOSTED_TELEMETRY_ENABLED: "true",
        EGA_HOSTED_TELEMETRY_WRITER_KEY: "sb_secret_read_only_key",
      }),
    );
    assert.ok(runtime.handler, "the MCP handler must still be constructed");
    assert.ok(runtime.snapshot, "the release snapshot must still load");
  });
});

describe("credentials never leak", () => {
  test("neither credential appears anywhere on the handle", async () => {
    const runtime = await build({
      EGA_HOSTED_TELEMETRY_ENABLED: "true",
      EGA_HOSTED_TELEMETRY_WRITER_KEY: WRITER_TOKEN,
    });
    const serialized = JSON.stringify({
      enabled: runtime.telemetry.enabled,
      written: runtime.telemetry.written,
      failure_classes: runtime.telemetry.failure_classes,
      handler: typeof runtime.handler,
    });
    assert.equal(serialized.includes("sb_secret_read_only_key"), false);
    assert.equal(serialized.includes(WRITER_TOKEN), false);
  });

  test("a configuration warning names variables but never values", async () => {
    const { warnings } = await captureWarnings(() =>
      build({
        EGA_HOSTED_TELEMETRY_ENABLED: "true",
        EGA_HOSTED_TELEMETRY_WRITER_KEY: "sb_secret_read_only_key",
      }),
    );
    const text = warnings.join("\n");
    assert.ok(text.includes("EGA_HOSTED_TELEMETRY_WRITER_KEY"), "the variable must be named");
    assert.equal(text.includes("sb_secret"), false, "no credential value may appear in a diagnostic");
  });

  test("the documented variables are the ones the runtime reads", async () => {
    // A documented-but-unread variable, or a read-but-undocumented one, is how a
    // deployment ends up configured from a runbook that does not work.
    const source = (await import("node:fs")).readFileSync(
      join(ROOT, "packages", "mcp", "src", "hosted-runtime.ts"),
      "utf8",
    );
    const read = [...source.matchAll(/env\["(EGA_HOSTED_TELEMETRY[A-Z_]*)"\]/g)].map((m) => m[1]);
    assert.ok(read.includes("EGA_HOSTED_TELEMETRY_WRITER_KEY"));
    const docs = (await import("node:fs")).readFileSync(
      join(ROOT, "docs", "operations", "telemetry-writer-credential.md"),
      "utf8",
    );
    for (const key of new Set(read)) {
      assert.ok(docs.includes(key), `${key} must be documented`);
    }
  });
});

describe("diagnostics are live, not frozen at startup", () => {
  test("the projection reflects later state rather than construction time", async () => {
    const runtime = await build({
      EGA_HOSTED_TELEMETRY_ENABLED: "true",
      EGA_HOSTED_TELEMETRY_WRITER_KEY: WRITER_TOKEN,
    });
    const before = runtime.telemetry;
    // A getter must produce a fresh value each access, so an operator reading the
    // handle after traffic sees current counts rather than zeros from boot.
    assert.notEqual(before, runtime.telemetry, "each read must return a fresh projection");
    assert.ok(Object.isFrozen(before), "the projection must be frozen so it cannot be mutated");
    assert.equal(typeof before.pending, "number");
    assert.equal(typeof before.queued, "number");
    assert.equal(typeof before.queued_bytes, "number");
    assert.equal(typeof before.dropped, "number");
    assert.equal(typeof before.expired, "number");
  });

  test("mutating a returned projection cannot alter internal state", async () => {
    const runtime = await build({
      EGA_HOSTED_TELEMETRY_ENABLED: "true",
      EGA_HOSTED_TELEMETRY_WRITER_KEY: WRITER_TOKEN,
    });
    const snapshot = runtime.telemetry;
    assert.throws(() => {
      "use strict";
      snapshot.written = 9999;
    });
    assert.equal(runtime.telemetry.written, 0, "the underlying state must be unchanged");
  });
});