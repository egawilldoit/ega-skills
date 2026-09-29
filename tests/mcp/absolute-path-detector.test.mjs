import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_ROOT_SEGMENTS,
  findAbsolutePaths,
  findHostAbsolutePaths,
  summarize,
} from "../helpers/absolute-path-detector.mjs";

const posix = (value) => findAbsolutePaths(value).filter((f) => f.class === "posix_absolute");
const windows = (value) => findAbsolutePaths(value).filter((f) => f.class === "windows_drive");
const unc = (value) => findAbsolutePaths(value).filter((f) => f.class === "unc");

test("detects POSIX absolute paths regardless of host OS", () => {
  const hits = posix("/home/ubuntu/worktrees/ega/hub/owned/acme/widget");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, "/home/ubuntu/worktrees/ega/hub/owned/acme/widget");
});

test("detects Windows drive absolute paths on a POSIX host", () => {
  // The point of the invariant: a Linux runner must flag a Windows fixture.
  assert.notEqual(process.platform, "win32", "guard: this test asserts the POSIX-host case");
  for (const fixture of [
    "C:\\Users\\alice\\ega\\hub",
    "C:/Users/alice/ega/hub",
    "d:\\work\\ega",
    "open Z:\\share\\hub.yaml",
  ]) {
    const hits = windows(fixture);
    assert.equal(hits.length, 1, `expected one windows_drive hit in ${JSON.stringify(fixture)}`);
    assert.equal(hits[0].class, "windows_drive");
  }
});

test("detects UNC paths on a POSIX host", () => {
  assert.notEqual(process.platform, "win32", "guard: this test asserts the POSIX-host case");
  for (const fixture of [
    "\\\\fileserver\\share\\ega\\hub.yaml",
    "path=\\\\build-host\\artifacts\\registry.sqlite",
  ]) {
    const hits = unc(fixture);
    assert.equal(hits.length, 1, `expected one unc hit in ${JSON.stringify(fixture)}`);
    assert.equal(hits[0].class, "unc");
  }
});

test("classifies each style separately in mixed content", () => {
  const text = [
    'posix="/home/ubuntu/hub/owned/a"',
    'win="C:\\Users\\alice\\hub"',
    'unc="\\\\srv\\share\\hub"',
  ].join(" ");
  const summary = summarize(findAbsolutePaths(text));
  assert.equal(summary.posix_absolute, 1);
  assert.equal(summary.windows_drive, 1);
  assert.equal(summary.unc, 1);
  assert.equal(summary.total, 3);
});

test("never flags URL schemes as absolute paths", () => {
  const urls = [
    "repository: https://github.com/egawilldoit/ega-skills",
    "clone git+ssh://git@github.com/owner/repo.git",
    "see http://example.com/a/b and https://example.com:8443/c",
    "resolved https://github.com/cursor/plugins@2b8ae2ee306f823d54879d3da7f8496b73c31d5d",
    "docs at https://opencode.ai/docs",
  ];
  for (const url of urls) {
    assert.deepEqual(findAbsolutePaths(url), [], `false positive on ${url}`);
  }
});

test("never flags repository-relative or logical paths", () => {
  const safe = [
    "owned/anthropic-owned/academy-guide",
    "pstack/skills/architect",
    "skills/engineering/code-review",
    "anthropic/academy-guide",
    "cache/sha256/ab/cdef",
    "registry.sqlite",
    "hub-release.json",
  ];
  for (const value of safe) {
    assert.deepEqual(findAbsolutePaths(value), [], `false positive on ${value}`);
  }
});

test("does not flag a bare slash, protocol-relative URLs, or words with slashes", () => {
  assert.deepEqual(findAbsolutePaths("/"), []);
  assert.deepEqual(findAbsolutePaths("and/or"), []);
  assert.deepEqual(findAbsolutePaths("input/output"), []);
  assert.deepEqual(findAbsolutePaths("//cdn.example.com/lib.js"), []);
  assert.deepEqual(findAbsolutePaths("read/write/exec"), []);
});

test("host-rooted detection separates host paths from other absolute paths", () => {
  const host = findHostAbsolutePaths("/home/alice/x");
  assert.equal(host.length, 1);
  assert.equal(host[0].class, "posix_absolute");
  // A Windows or UNC path is host-local by construction.
  assert.equal(findHostAbsolutePaths("C:\\Users\\alice\\x").length, 1);
  assert.equal(findHostAbsolutePaths("\\\\srv\\share\\x").length, 1);
  for (const segment of ["/home", "/tmp", "/Users", "/private", "/var"]) {
    assert.equal(findHostAbsolutePaths(`${segment}/x`).length, 1, `${segment} must be host-rooted`);
  }
});

test("host root segment table covers the observed build-host prefixes", () => {
  for (const segment of ["home", "tmp", "Users", "root", "var"]) {
    assert.ok(HOST_ROOT_SEGMENTS.includes(segment), `missing ${segment}`);
  }
});

test("handles empty and non-string input without throwing", () => {
  assert.deepEqual(findAbsolutePaths(""), []);
  assert.deepEqual(findAbsolutePaths(undefined), []);
  assert.deepEqual(findAbsolutePaths(null), []);
  assert.deepEqual(findAbsolutePaths(42), []);
});

test("detects an absolute path embedded in JSON payload text", () => {
  const json = JSON.stringify({ local_path: "/home/ubuntu/worktrees/ega/hub/owned/acme/widget" });
  const hits = findAbsolutePaths(json);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].class, "posix_absolute");
});
