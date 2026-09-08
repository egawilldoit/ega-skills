// 1.1[C] upstream git operations (EGA-625). Contract B section 2 (check).
//
// Exact-commit discipline: `resolveRefToCommit` maps a tracked ref to one
// commit; fetch helpers acquire Git objects and verify the exact commit.
// Source bytes are read later through Git plumbing, never through checkout.

import { execFileSync } from "node:child_process";
import { HubError } from "./errors.js";
import { COMMIT_RE } from "./guards.js";

function gitError(code: "E_PLAN_RESOLVE" | "E_PLAN_FETCH", message: string): HubError {
  return new HubError(code, message);
}

/** Resolve a tracked ref to its exact commit via `git ls-remote`. Read-only.
 *  Precedence matches `git clone --branch` (which fetch uses): branch first,
 *  then the peeled annotated-tag commit, then exact/lightweight forms. A
 *  branch/tag name collision therefore resolves exactly what fetch checks
 *  out, and annotated tags resolve to the peeled commit clone materializes. */
export function resolveRefToCommit(repository: string, ref: string): string {
  let stdout: string;
  try {
    // Both patterns: the bare ref plus its peeled form, so annotated tags
    // advertise `refs/tags/<tag>^{}` (a bare pattern alone omits it).
    stdout = execFileSync("git", ["ls-remote", "--", repository, ref, `${ref}^{}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw gitError("E_PLAN_RESOLVE", `cannot resolve ref ${ref}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  const seen = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (!COMMIT_RE.test(sha)) {
      throw gitError("E_PLAN_RESOLVE", `upstream returned a malformed commit for ${ref}`);
    }
    if (!seen.has(name)) seen.set(name, sha);
  }
  const head = seen.get(`refs/heads/${ref}`);
  if (head !== undefined) return head;
  const peeled = seen.get(`refs/tags/${ref}^{}`);
  if (peeled !== undefined) return peeled;
  const exact = seen.get(ref);
  if (exact !== undefined) return exact;
  const tag = seen.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  throw gitError("E_PLAN_RESOLVE", `ref ${ref} not found upstream`);
}

/**
 * Clone the ref tip into `dir` and verify it equals `expectedCommit`.
 * Mismatch means upstream moved during check: fail, never follow it.
 */
export function fetchRefTip(repository: string, ref: string, expectedCommit: string, dir: string): void {
  // --no-checkout is security-critical: source identity is obtained from raw
  // Git blobs, so attributes, smudge filters, LFS, and autocrlf cannot run.
  const noEol = "-c";
  const noEolValue = "core.autocrlf=false";
  try {
    execFileSync("git", [noEol, noEolValue, "clone", "--quiet", "--no-checkout", "--depth", "1", "--branch", ref, "--", repository, dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw gitError("E_PLAN_FETCH", `cannot fetch ${ref}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  let tip: string;
  try {
    tip = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    throw gitError("E_PLAN_FETCH", `cannot read fetched tip: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  if (tip !== expectedCommit) {
    throw gitError("E_PLAN_FETCH", `upstream moved during check (resolved ${expectedCommit}, fetched ${tip}); re-run check`);
  }
}

export interface ExactCommitFetchOptions {
  /** Ref used only to transport history when direct SHA wants are rejected. */
  readonly fallbackRef?: string;
  /** Deterministic test seam for servers that reject direct SHA wants. */
  readonly forceRefFallback?: boolean;
}

function verifyExactObject(dir: string, commit: string): void {
  try {
    execFileSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw gitError("E_PLAN_FETCH", `cannot verify fetched commit ${commit}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

/** Acquire one approved commit without adopting a moving ref tip.
 *  Apply uses this primitive after plan approval, so a later branch movement
 *  cannot change the content being adopted. Some Git servers reject direct
 *  SHA wants; the verified ref fallback transports history, then proves the
 *  approved object itself. Source extraction reads Git objects. */
export function fetchExactCommit(
  repository: string,
  commit: string,
  dir: string,
  options: ExactCommitFetchOptions = {},
): void {
  if (!COMMIT_RE.test(commit)) {
    throw gitError("E_PLAN_FETCH", "approved commit must be 40 lowercase hex");
  }
  try {
    execFileSync("git", ["-c", "core.autocrlf=false", "init", "--quiet", dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["-C", dir, "config", "core.autocrlf", "false"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw gitError("E_PLAN_FETCH", `cannot initialize exact-commit fetch for ${commit}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }

  let directFailure: unknown;
  if (!options.forceRefFallback) {
    try {
      execFileSync("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "--no-tags", "--", repository, commit], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      verifyExactObject(dir, commit);
      return;
    } catch (e) {
      directFailure = e;
    }
  }

  if (options.fallbackRef === undefined || options.fallbackRef.length === 0) {
    const detail = directFailure === undefined ? "direct fetch was bypassed" : `direct fetch failed: ${String((directFailure as Error)?.message ?? directFailure).slice(0, 120)}`;
    throw gitError("E_PLAN_FETCH", `${detail}; no verified fallback ref was supplied for approved commit ${commit}`);
  }
  try {
    // Fetch the ref's history only as an object transport. The ref tip is
    // never checked out or used as the adopted tree.
    execFileSync("git", ["-C", dir, "fetch", "--quiet", "--no-tags", "--", repository, options.fallbackRef], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    verifyExactObject(dir, commit);
  } catch (e) {
    const direct = directFailure === undefined ? "direct fetch was bypassed" : `direct fetch failed: ${String((directFailure as Error)?.message ?? directFailure).slice(0, 120)}`;
    throw gitError("E_PLAN_FETCH", `${direct}; verified ref fallback ${options.fallbackRef} could not acquire approved commit ${commit}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
}
