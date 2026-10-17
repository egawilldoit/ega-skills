import { existsSync } from "node:fs";

/**
 * Deadline-based wait for a file to appear.
 *
 * Replaces fixed-iteration polls, whose implied timeout is a product of the
 * iteration count and the sleep duration and therefore silently shrinks or
 * silently stretches with host speed. The measured barrier-child latency in
 * tests/cli/intake-publication-e2e.test.mjs is dominated by process startup
 * (node boot plus ESM graph load) rather than by the work the child performs,
 * so a fixed budget fails on loaded or slow hosts while passing on fast CI.
 *
 * The deadline is measured on a monotonic clock, so a wall-clock adjustment
 * during the wait cannot extend or collapse it.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

const POLL_INTERVAL_MS = 10;

export async function waitForFile(path, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  const sleepMs = options.sleepMs ?? POLL_INTERVAL_MS;
  const started = now();
  const deadline = started + timeoutMs;

  for (;;) {
    if (existsSync(path)) return Math.round(now() - started);
    if (now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  throw new Error(
    `timed out after ${Math.round(now() - started)}ms waiting for ${describePathClass(path)} ` +
    `(deadline ${timeoutMs}ms)${formatDiagnostics(options.describe)}`,
  );
}

/**
 * Classify a path without disclosing it. Timeout messages reach CI logs, so
 * they carry the shape of the path and never the host-specific prefix.
 */
export function describePathClass(path) {
  const name = hostIndependentBasename(path);
  return `${classifyPathShape(path)} basename=${JSON.stringify(name)}`;
}

/**
 * Classify the path by its string shape, never by the host platform.
 *
 * A host-dependent classification is wrong twice over: `path.isAbsolute`
 * answers from the running platform, and on Windows a leading slash is a
 * root-relative path, so a POSIX absolute path is reported as an absolute
 * Windows path. Timeout messages reach CI logs, and the same test must produce
 * the same shape description on every runner.
 */
function classifyPathShape(path) {
  if (/^[A-Za-z]:[\\/]/.test(path)) return "absolute windows path";
  if (/^\\\\/.test(path)) return "absolute windows unc path";
  if (path.startsWith("/")) return "absolute posix path";
  return "relative path";
}

/** Last segment of a path under either separator, independent of host OS. */
function hostIndependentBasename(path) {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

function formatDiagnostics(describe) {
  if (describe === undefined) return "";
  const details = describe();
  return details.length === 0 ? "" : ` [${details.join("; ")}]`;
}

/**
 * Redact host paths and environment assignments from captured child output so
 * a timeout message can carry the failure reason without carrying the host
 * layout or any environment value.
 */
export function sanitizeChildOutput(text, { maxLength = 400 } = {}) {
  if (text.length === 0) return "<empty>";
  const flattened = text
    .replace(/\[[0-9;]*m/g, "")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`)]*/g, "<path>")
    .replace(/(?<![\w/])\/(?:[\w.@+-]+\/)*[\w.@+-]+/g, "<path>")
    .replace(
      /\b([A-Z][A-Z0-9_]{2,})\s*=\s*("[^"]*"|'[^']*'|[^\s,;)]*)/g,
      (_match, key) => `${key}=<redacted>`,
    );
  const collapsed = collapsed_tail(flattened.trim());
  return collapsed.length > maxLength ? `...${collapsed.slice(-maxLength)}` : collapsed;
}

function collapsed_tail(text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-5).join(" | ");
}

/** Describe a spawned child for a timeout message, without leaking the host. */
export function describeChild(child, stderr) {
  return () => {
    const details = [
      `child_pid=${child.pid ?? "unknown"}`,
      `child_exit_code=${child.exitCode === null ? "still-running" : child.exitCode}`,
    ];
    if (child.signalCode) details.push(`child_signal=${child.signalCode}`);
    details.push(`child_stderr=${JSON.stringify(sanitizeChildOutput(stderr()))}`);
    return details;
  };
}
