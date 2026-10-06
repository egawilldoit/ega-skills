/**
 * Static project-boundary scan for `apps/web`.
 *
 * ## Why this test exists
 *
 * `tests/mcp/project-boundary.test.mjs:330-340` statically scans
 * `packages/mcp/src` for banned network/shell/eval tokens. It does not cover
 * `packages/oauth-ui` and it did not cover `apps/web`. Adding a second
 * application with no equivalent guard is a genuine regression in coverage, so
 * this file closes that gap for the console.
 *
 * ## What is being protected
 *
 * The browser bundle is a different trust zone from the BFF. Every
 * `@ega-skills/*` package is Node-only: they resolve to `dist/index.js`, pull in
 * `process.env`, and `registry`/`project` open the native `better-sqlite3`
 * binding. A single import of one from `apps/web/src/**` would drag Node-only
 * code into a browser bundle. That is asserted below, not merely documented.
 *
 * The converse also matters: the server directory must never reach for
 * `@ega-skills/object-store`. Its write credential is constructor-injected and
 * has no production consumer anywhere in the repository
 * (`tests/object-store/object-store.test.mjs` is its only caller). `apps/web`
 * must not become the first.
 *
 * This scan is deliberately static and offline: it reads files and regexes them.
 * It must not itself import what it is checking, or it would need the very
 * dependencies it forbids.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const SRC_DIR = join(WEB_ROOT, "src");
const SERVER_DIR = join(WEB_ROOT, "server");

/** Recursively collect source files under `dir`, skipping declaration files. */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

/** `apps/web/src` sources, labelled relative to the app root for messages. */
const SRC_FILES = sourceFiles(SRC_DIR).map((path) => ({
  path,
  label: relative(WEB_ROOT, path),
  text: readFileSync(path, "utf8"),
}));

/** `apps/web/server` sources, labelled relative to the app root for messages. */
const SERVER_FILES = sourceFiles(SERVER_DIR).map((path) => ({
  path,
  label: relative(WEB_ROOT, path),
  text: readFileSync(path, "utf8"),
}));

describe("apps/web/src imports nothing Node-only", () => {
  // The scan is worthless if it finds no files, so assert the corpus is real.
  test("the scan covers a non-empty source tree", () => {
    assert.ok(SRC_FILES.length >= 20, `expected the console SPA to have sources, found ${SRC_FILES.length}`);
  });

  test("server code may only TYPE-import from apps/web/src", () => {
    // apps/web/src/api/contracts.ts imports "../console-model" without a file
    // extension. That is fine for the bundler, but apps/web/server runs under
    // Node's native type stripping, which requires explicit specifiers. Today the
    // only server -> src import is `import type`, which verbatimModuleSyntax
    // erases, so the extensionless specifier is never resolved at runtime. A
    // VALUE import would be erased no more, would fail only at deploy time, and
    // tsconfig.server.json uses Bundler resolution, so typecheck would NOT catch
    // it. This test is the guard for that hazard.
    for (const { label, text } of SERVER_FILES) {
      for (const statement of text.matchAll(/^\s*import\s[^\n]*from\s*["']([^"']+)["']/gm)) {
        const specifier = statement[1] ?? "";
        if (!specifier.includes("/src/") && !specifier.startsWith("../src")) continue;
        const isTypeOnly = /^\s*import\s+type\b/.test(statement[0]);
        assert.ok(
          isTypeOnly,
          `${label} value-imports ${specifier}; server code runs under Node type stripping, which cannot resolve apps/web/src extensionless specifiers. Use import type.`,
        );
      }
    }
  });

  test("no node: builtin imports", () => {
    const banned = /(?:from|import|require\s*\()\s*["']node:/;
    for (const { label, text } of SRC_FILES) {
      assert.doesNotMatch(text, banned, `${label} must not import a node: builtin into the browser bundle`);
    }
  });

  test("no child_process", () => {
    const banned = /child_process|execSync|execFileSync|spawnSync|fork\s*\(/;
    for (const { label, text } of SRC_FILES) {
      assert.doesNotMatch(text, banned, `${label} must not reference a shell/process primitive`);
    }
  });

  test("no eval", () => {
    const banned = /\beval\s*\(/;
    for (const { label, text } of SRC_FILES) {
      assert.doesNotMatch(text, banned, `${label} must not call eval`);
    }
  });

  test("no new Function", () => {
    const banned = /new\s+Function\s*\(/;
    for (const { label, text } of SRC_FILES) {
      assert.doesNotMatch(text, banned, `${label} must not construct a function from a string`);
    }
  });

  test("no @ega-skills/* package import", () => {
    // These resolve to `dist/index.js` server code and pull in `process.env`.
    const banned = /(?:from|import|require\s*\()\s*["']@ega-skills\//;
    for (const { label, text } of SRC_FILES) {
      assert.doesNotMatch(
        text,
        banned,
        `${label} must not import an @ega-skills package: the browser cannot resolve Node-only dist output`,
      );
    }
  });

  test("only the two documented VITE_ variables are read", () => {
    // Net permitted browser bundle contents. Anything else is a defect.
    const permitted = new Set(["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]);
    const referenced = new Set();
    for (const { text } of SRC_FILES) {
      for (const match of text.matchAll(/\bVITE_[A-Z0-9_]+/g)) referenced.add(match[0]);
    }
    for (const name of referenced) {
      assert.ok(permitted.has(name), `apps/web/src references unpermitted browser env var ${name}`);
    }
  });

  test("no server-only secret env var is referenced by the SPA", () => {
    // `EGA_*` values without the VITE_ prefix are never substituted by Vite, but
    // referencing one in SPA code signals an intent to read a server secret in
    // the browser, which the architecture prohibits.
    const serverOnly = /["'`](EGA_HOSTED_BEARER_TOKEN|EGA_HOSTED_AUTHZ_JSON|EGA_HOSTED_AUTHZ_FILE|EGA_SUPABASE_SECRET_KEY|EGA_WEB_EXPECTED_RELEASE_DIGEST)["'`]/;
    for (const { label, text } of SRC_FILES) {
      assert.doesNotMatch(text, serverOnly, `${label} must not reference a server-only env var`);
    }
  });
});

describe("apps/web/server stays off the write surface", () => {
  test("the scan covers the server modules", () => {
    assert.ok(SERVER_FILES.length >= 3, `expected server modules to exist, found ${SERVER_FILES.length}`);
  });

  test("no @ega-skills/object-store import", () => {
    // The object-store write credential is constructor-injected and has no
    // caller anywhere in the repo today. apps/web must not become the first.
    const banned = /(?:from|import|require\s*\()\s*["']@ega-skills\/object-store["']/;
    for (const { label, text } of SERVER_FILES) {
      assert.doesNotMatch(text, banned, `${label} must not import @ega-skills/object-store`);
      assert.doesNotMatch(text, /HttpObjectStore/, `${label} must not reference HttpObjectStore`);
    }
  });

  test("no VITE_-prefixed read on the server", () => {
    // The server must read `EGA_*`, never the browser-substituted `VITE_*`.
    for (const { label, text } of SERVER_FILES) {
      assert.doesNotMatch(
        text,
        /["'`](VITE_[A-Z0-9_]+)["'`]/,
        `${label} must not read a VITE_ variable; server config comes from EGA_* names`,
      );
    }
  });

  test("SQL interpolates only the verified FTS table name, never a value", () => {
    // Parameterized queries are the contract: every user-supplied value is a
    // bound `?`. The one identifier that must be interpolated is the release FTS
    // corpus table, which cannot be a bound parameter. Rather than blanket-ban
    // interpolation, this asserts the exact and only permitted exception, so a
    // second interpolation has to be argued for explicitly.
    const ALLOWED = "ftsTable";
    const sqlLiteral = /`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[^`]*`/g;
    const interpolation = /\$\{([^}]*)\}/g;
    let sawAllowed = false;
    for (const { label, text } of SERVER_FILES) {
      for (const literal of text.matchAll(sqlLiteral)) {
        for (const spliced of literal[0].matchAll(interpolation)) {
          const name = spliced[1].trim();
          assert.equal(
            name,
            ALLOWED,
            `${label} interpolates ${JSON.stringify(name)} into SQL text; only the verified FTS table name may be interpolated, every value must be a bound parameter`,
          );
          sawAllowed = true;
        }
      }
    }
    // Confirm the scanner actually observes the exception, so this test cannot
    // silently pass because the pattern stopped matching.
    assert.ok(sawAllowed, "expected the verified FTS table interpolation to be present and scanned");
  });

  test("no SQL statement concatenates a value with + or string join", () => {
    // A second way to build SQL dynamically, outside any template literal.
    for (const { label, text } of SERVER_FILES) {
      assert.doesNotMatch(
        text,
        /["'`](?:SELECT|INSERT|UPDATE|DELETE)[^"'`]*["'`]\s*\+/,
        `${label} must not concatenate SQL with +`,
      );
      assert.doesNotMatch(
        text,
        /\.(?:join|concat|replace)\([^)]*\)[^;]*`?[^;]*SELECT/,
        `${label} must not assemble SQL from a join/replace of fragments`,
      );
    }
  });

  test("server modules that import @ega-skills/* do so from an allowed package", () => {
    const allowed = new Set(["@ega-skills/mcp", "@ega-skills/project", "@ega-skills/registry"]);
    const banned = /(?:from|import\s*\()\s*["'](@ega-skills\/[^"']+)["']/g;
    for (const { label, text } of SERVER_FILES) {
      for (const match of text.matchAll(banned)) {
        assert.ok(
          allowed.has(match[1]),
          `${label} imports unapproved server package ${match[1]}`,
        );
      }
    }
  });
});