/**
 * Cross-platform absolute-path detector.
 *
 * Detection is pure string analysis and never consults the host platform, so a
 * Linux runner flags a Windows fixture and a Windows runner flags a POSIX
 * fixture. `path.isAbsolute` cannot be used here: it answers for the running
 * OS only, which is exactly the gap these invariants have to close.
 *
 * Every pattern is anchored on a boundary that excludes URL syntax, so
 * `https://github.com/x` and `git+ssh://host/x` are never reported while
 * `C:\Users\alice` and `\\fileserver\share` always are.
 */

// A drive letter is a single letter that is not part of a longer word. In
// `https://` the trailing `s` is preceded by `p`, so the scheme is rejected.
const STOP_CLASS = "[^\\s\"'`|)\\]}<>,]";
const WINDOWS_DRIVE = new RegExp("(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]" + STOP_CLASS + "*", "g");

// A UNC path begins with two literal backslashes, then a host, then a separator.
const UNC = new RegExp("\\\\\\\\[A-Za-z0-9._-]+\\\\" + STOP_CLASS + "*", "g");

// A POSIX absolute path begins with a single `/` that is not preceded by a
// word character, a colon (URL scheme) or another slash (protocol-relative).
const POSIX_ABSOLUTE = new RegExp(
  "(?<![A-Za-z0-9:/])\\/(?:[A-Za-z0-9._@+-]+\\/)*[A-Za-z0-9._@+-]+",
  "g",
);

export const PATH_CLASSES = Object.freeze({
  windows_drive: WINDOWS_DRIVE,
  unc: UNC,
  posix_absolute: POSIX_ABSOLUTE,
});

/**
 * Directories that indicate a host-local filesystem location rather than a
 * portable, repository-relative location. A build-host path in shipped
 * provenance always roots at one of these.
 */
export const HOST_ROOT_SEGMENTS = Object.freeze([
  "home", "tmp", "var", "usr", "opt", "etc", "root", "mnt", "srv", "boot",
  "media", "lib", "bin", "sbin", "proc", "dev", "sys", "run",
  "Users", "private", "Volumes", "System", "Library", "Applications", "data",
]);

/**
 * Find every absolute path in `text`, classified by style.
 * @returns {Array<{class: "posix_absolute"|"windows_drive"|"unc", value: string, index: number}>}
 */
export function findAbsolutePaths(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const found = [];
  for (const [className, pattern] of Object.entries(PATH_CLASSES)) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      found.push({ class: className, value: match[0], index: match.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Absolute paths that root at a known host-local directory. */
export function findHostAbsolutePaths(text) {
  return findAbsolutePaths(text).filter(
    ({ class: className, value }) => className !== "posix_absolute" || isHostRooted(value),
  );
}

function isHostRooted(posixPath) {
  const segments = posixPath.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 && HOST_ROOT_SEGMENTS.includes(segments[0]);
}

/** Group matches by class for reporting. */
export function summarize(findings) {
  const summary = { posix_absolute: 0, windows_drive: 0, unc: 0, total: findings.length };
  for (const finding of findings) summary[finding.class] += 1;
  return summary;
}
