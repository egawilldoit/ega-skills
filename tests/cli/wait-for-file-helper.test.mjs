import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  describeChild,
  describePathClass,
  sanitizeChildOutput,
  waitForFile,
} from "../helpers/wait-for-file.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "ega-wait-helper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("waitForFile returns as soon as the file exists", async (t) => {
  const dir = scratch(t);
  const target = join(dir, "marker");
  const pending = waitForFile(target, { timeoutMs: 5_000 });
  const { writeFileSync } = await import("node:fs");
  setTimeout(() => writeFileSync(target, "ok\n"), 50);
  const elapsed = await pending;
  assert.ok(elapsed >= 0 && elapsed < 5_000, `elapsed ${elapsed}`);
});

test("waitForFile times out on a monotonic deadline and reports elapsed time", async (t) => {
  const dir = scratch(t);
  const target = join(dir, "never-appears");
  const started = performance.now();
  await assert.rejects(
    () => waitForFile(target, { timeoutMs: 120 }),
    (error) => {
      assert.match(error.message, /timed out after \d+ms/);
      assert.match(error.message, new RegExp(`deadline ${120}ms`));
      return true;
    },
  );
  const wall = performance.now() - started;
  assert.ok(wall >= 120, `deadline fired early at ${wall}ms`);
  assert.ok(wall < 3_000, `deadline overshot badly at ${wall}ms`);
});

test("waitForFile deadline is not extended by an injected wall-clock jump", async (t) => {
  const dir = scratch(t);
  const target = join(dir, "never-appears");
  // A fake clock that jumps forward 10x each call would terminate a fixed-count
  // or wall-clock-budget wait immediately; a monotonic deadline driven by the
  // same clock still consumes its full budget.
  let fake = 0;
  await assert.rejects(
    () => waitForFile(target, { timeoutMs: 200, now: () => (fake += 25) }),
    (error) => /timed out after \d+ms/.test(error.message),
  );
  assert.equal(fake >= 200, true, "monotonic budget must be fully consumed");
});

test("waitForFile timeout message never discloses the full host path", async (t) => {
  const dir = scratch(t);
  const target = join(dir, "preview-marker");
  await assert.rejects(
    () => waitForFile(target, { timeoutMs: 60 }),
    (error) => {
      assert.ok(!error.message.includes(dir), `message leaked host dir: ${error.message}`);
      assert.ok(!error.message.includes(target), `message leaked host path: ${error.message}`);
      assert.match(error.message, /basename="preview-marker"/);
      return true;
    },
  );
});

test("waitForFile reports child pid, exit code and sanitized stderr on timeout", async (t) => {
  const dir = scratch(t);
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  const stderr = () => "Error: cannot read /home/operator/ega-skills/secret/hub.yaml\nTOKEN=abcdef123456\nfailed";
  await assert.rejects(
    () => waitForFile(join(dir, "never"), { timeoutMs: 60, describe: describeChild(child, stderr) }),
    (error) => {
      assert.match(error.message, /child_pid=4242/);
      assert.match(error.message, /child_exit_code=still-running/);
      assert.ok(error.message.includes("cannot read"), "keeps the failure reason");
      assert.ok(!error.message.includes("/home/operator"), "leaked host path");
      assert.ok(!error.message.includes("abcdef123456"), "leaked environment value");
      assert.match(error.message, /TOKEN=<redacted>/);
      return true;
    },
  );
});

test("describeChild reports a real exit code", async (t) => {
  const dir = scratch(t);
  const child = new EventEmitter();
  child.pid = 7;
  child.exitCode = 4;
  child.signalCode = "SIGKILL";
  await assert.rejects(
    () => waitForFile(join(dir, "never"), { timeoutMs: 60, describe: describeChild(child, () => "") }),
    (error) => {
      assert.match(error.message, /child_exit_code=4/);
      assert.match(error.message, /child_signal=SIGKILL/);
      assert.match(error.message, /child_stderr="<empty>"/);
      return true;
    },
  );
});

test("sanitizeChildOutput redacts posix, windows and unc paths and env values", () => {
  assert.equal(sanitizeChildOutput("open /home/alice/work/repo/hub.yaml"), "open <path>");
  assert.equal(sanitizeChildOutput("open C:\\Users\\alice\\repo\\hub.yaml"), "open <path>");
  assert.equal(sanitizeChildOutput("open C:/Users/alice/repo/hub.yaml"), "open <path>");
  assert.equal(sanitizeChildOutput("open \\\\fileserver\\share\\hub.yaml"), "open <path>");
  assert.equal(sanitizeChildOutput("EGA_SKILLS_HOME=/home/alice/.ega"), "EGA_SKILLS_HOME=<redacted>");
  assert.equal(sanitizeChildOutput(""), "<empty>");
});

test("sanitizeChildOutput keeps only the tail of a long stream", () => {
  const noisy = Array.from({ length: 200 }, (_, i) => `line ${i} /home/alice/x`).join("\n");
  const out = sanitizeChildOutput(noisy, { maxLength: 120 });
  assert.ok(out.length <= 123, `length ${out.length}`);
  assert.ok(out.includes("line 199"), "keeps the most recent lines");
  assert.ok(!out.includes("line 0 "), "drops the oldest lines");
  assert.ok(!out.includes("/home/alice"), "redacts paths in the tail");
});

test("describePathClass reports shape without the host prefix", () => {
  const posix = describePathClass("/tmp/ega-e2e-8KC94k/preview-marker");
  assert.match(posix, /absolute posix path/);
  assert.match(posix, /basename="preview-marker"/);
  assert.ok(!posix.includes("8KC94k"), "leaked temp dir token");
  assert.match(describePathClass("relative/marker"), /relative path/);
});

test("default timeout is bounded and deadline-based", () => {
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 30_000);
});

test("path classification is host-independent, not host-derived", () => {
  // A POSIX absolute path must be described identically on a Windows runner:
  // `path.isAbsolute` and `process.platform` would otherwise relabel it.
  const posix = describePathClass("/tmp/ega-e2e-8KC94k/preview-marker");
  assert.match(posix, /^absolute posix path /, `posix shape: ${posix}`);
  assert.match(posix, /basename="preview-marker"/);
  assert.ok(!posix.includes("8KC94k"), "leaked temp dir token");

  // Every shape the helper can report, from any host.
  assert.match(describePathClass("C:\\Users\\bob\\marker"), /^absolute windows path basename="marker"/);
  assert.match(describePathClass("\\\\server\\share\\marker"), /^absolute windows unc path basename="marker"/);
  assert.match(describePathClass("relative/marker"), /^relative path basename="marker"/);
});
