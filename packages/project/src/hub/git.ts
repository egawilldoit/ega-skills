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
  // NOTE (Windows): core.autocrlf must be off — CRLF conversion would change
  // quarantined bytes (and therefore tree digests) per platform. EGA needs
  // byte-deterministic checkouts; canonical line-ending rules live in SPEC-002.
  const noEol = "-c";
  const noEolValue = "core.autocrlf=false";
  try {
    execFileSync("git", [noEol, noEolValue, "clone", "--quiet", "--depth", "1", "--branch", ref, "--", repository, dir], {
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

/** Materialize one approved commit without consulting any tracked ref.
 *  Apply uses this primitive after plan approval, so a later branch movement
 *  cannot change the content being adopted. */
export function fetchExactCommit(repository: string, commit: string, dir: string): void {
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
    execFileSync("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "--no-tags", repository, commit], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["-C", dir, "checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw gitError("E_PLAN_FETCH", `cannot fetch approved commit ${commit}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  let landed: string;
  try {
    landed = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    throw gitError("E_PLAN_FETCH", `cannot read fetched commit: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  if (landed !== commit) {
    throw gitError("E_PLAN_FETCH", `exact fetch landed ${landed}, expected approved commit ${commit}`);
  }
}
