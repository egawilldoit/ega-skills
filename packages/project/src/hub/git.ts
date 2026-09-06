// 1.1[C] upstream git operations (EGA-625). Contract B section 2 (check).
//
// Exact-commit discipline: `resolveRefToCommit` maps a tracked ref to one
// commit; `fetchRefTip` materializes that commit and FAILS if the upstream
// moved in between (never silently follow a moving ref). No shell: argv only.

import { execFileSync } from "node:child_process";
import { HubError } from "./errors.js";
import { COMMIT_RE } from "./guards.js";

function gitError(code: "E_PLAN_RESOLVE" | "E_PLAN_FETCH", message: string): HubError {
  return new HubError(code, message);
}

/** Resolve a tracked ref to its exact commit via `git ls-remote`. Read-only. */
export function resolveRefToCommit(repository: string, ref: string): string {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-remote", "--", repository, ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw gitError("E_PLAN_RESOLVE", `cannot resolve ref ${ref}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (name === ref || name === `refs/heads/${ref}` || name === `refs/tags/${ref}`) {
      if (!COMMIT_RE.test(sha)) {
        throw gitError("E_PLAN_RESOLVE", `upstream returned a malformed commit for ${ref}`);
      }
      return sha;
    }
  }
  throw gitError("E_PLAN_RESOLVE", `ref ${ref} not found upstream`);
}

/**
 * Clone the ref tip into `dir` and verify it equals `expectedCommit`.
 * Mismatch means upstream moved during check: fail, never follow it.
 */
export function fetchRefTip(repository: string, ref: string, expectedCommit: string, dir: string): void {
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", ref, "--", repository, dir], {
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
