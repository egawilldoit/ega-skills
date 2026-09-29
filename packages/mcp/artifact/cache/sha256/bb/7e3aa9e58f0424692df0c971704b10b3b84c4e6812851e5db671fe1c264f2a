#!/usr/bin/env python3
"""Gather deterministic repository facts for preflight-repository.

Read-only. Never mutates the repository. Uses git, and gh only when present.
The model interprets ambiguity; this script establishes facts.

Facts are separated by evidence class:

* worktree.current_kind classifies THIS checkout (main / linked / submodule /
  other) using git's own path data, not worktree counts and not `.git`-file
  sniffing.
* sync.tracking_parity compares HEAD with the local @{upstream} tracking ref.
* sync.remote_parity compares HEAD with the live remote branch SHA obtained
  read-only via `git ls-remote origin`. Tracking parity is never substituted
  for remote parity; when the remote cannot be reached the value is unknown.
* branch.default comes from remote truth where possible. The source is
  recorded, and a local main/master fallback carries lower evidence status.

Usage:
    python3 preflight.py [--repo PATH] [--default-branch NAME] [--json]

Exit codes:
    0  facts gathered (verdict is still the model's call)
    2  not inside a git work tree
"""

import argparse
import json
import os
import shutil
import subprocess
import sys


def run(cmd, cwd=None):
    """Run a command, return (ok, stdout_stripped)."""
    code, output, _error = run_detailed(cmd, cwd=cwd)
    return code == 0, output if code == 0 else ""


def run_detailed(cmd, cwd=None):
    """Run a command while preserving exit status, stdout, and stderr."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return None, "", str(exc)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def git(args, cwd=None):
    return run(["git"] + args, cwd=cwd)


def parse_remote(url):
    """Parse a git remote URL into host/owner/name, best effort."""
    if not url:
        return {"host": None, "owner": None, "name": None}
    raw = url.strip()
    if raw.endswith(".git"):
        raw = raw[:-4]
    host = owner = name = None
    if raw.startswith("git@") and ":" in raw:
        host, path = raw[4:].split(":", 1)
    elif "://" in raw:
        rest = raw.split("://", 1)[1]
        if "@" in rest.split("/", 1)[0]:
            rest = rest.split("@", 1)[1]
        host, _, path = rest.partition("/")
    elif "/" in raw:
        host, path = None, raw
    else:
        path = raw
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2:
        owner = parts[-2]
        name = parts[-1]
    elif parts:
        name = parts[-1]
    return {"host": host, "owner": owner, "name": name}


def ls_remote_branch(root, branch):
    """Read-only live query of the remote branch SHA. (ok, sha_or_url_or_none)."""
    ok, out = git(["ls-remote", "origin", "refs/heads/" + branch], cwd=root)
    if not ok:
        return False, None
    if not out:
        return True, None
    return True, out.split()[0]


def classify_worktree(root, superproject):
    """Classify this checkout using git's own paths.

    Returns (current_kind, git_dir_abs, git_common_dir_abs) where current_kind
    is one of: submodule, linked, main, unknown.
    """
    ok_gd, git_dir = git(["rev-parse", "--path-format=absolute", "--git-dir"], cwd=root)
    ok_gc, git_common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=root)
    if not (ok_gd and ok_gc and git_dir and git_common):
        return "unknown", git_dir or None, git_common or None

    git_dir_abs = os.path.normpath(git_dir)
    git_common_abs = os.path.normpath(git_common)

    if superproject:
        # git reports a non-empty superproject working tree: a submodule checkout.
        return "submodule", git_dir_abs, git_common_abs

    # A linked worktree gets its own per-worktree dir under .git/worktrees/,
    # so git_dir differs from git_common_dir. The main checkout's git_dir
    # equals (or resolves to) the common dir.
    if os.path.realpath(git_dir_abs) != os.path.realpath(git_common_abs):
        return "linked", git_dir_abs, git_common_abs

    return "main", git_dir_abs, git_common_abs


def resolve_default_branch(root, explicit_override):
    """Resolve the remote default branch with recorded evidence source.

    Returns (default_branch, default_branch_source). Sources, best first:
      explicit_override    -- caller supplied --default-branch
      remote_head_symref   -- `git ls-remote --symref origin HEAD`
      local_origin_head    -- local refs/remotes/origin/HEAD (may be stale)
      local_fallback       -- a local main/master exists (lowest evidence)
      unknown              -- nothing resolved
    """
    if explicit_override:
        return explicit_override, "explicit_override"

    has_remote = run_git_remote_ok(root)
    if has_remote:
        ok, out = git(["ls-remote", "--symref", "origin", "HEAD"], cwd=root)
        if ok and out:
            for line in out.splitlines():
                symref, _, sha = line.partition("\t")
                if symref.startswith("ref: refs/heads/"):
                    return symref[len("ref: refs/heads/"):], "remote_head_symref"

    ok, sym = git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], cwd=root)
    if ok and sym:
        return sym.split("/", 1)[-1], "local_origin_head"

    for candidate in ("main", "master"):
        ok, _ = git(["rev-parse", "--verify", "-q", candidate], cwd=root)
        if ok:
            return candidate, "local_fallback"

    return None, "unknown"


def run_git_remote_ok(root):
    ok, _ = git(["remote", "get-url", "origin"], cwd=root)
    return ok


def main():
    parser = argparse.ArgumentParser(description="Gather repository facts (read-only).")
    parser.add_argument("--repo", default=".", help="path inside the work tree")
    parser.add_argument("--default-branch", default=None, help="override default branch")
    parser.add_argument("--json", action="store_true", help="emit JSON only")
    args = parser.parse_args()

    start = os.path.abspath(args.repo)

    ok, inside = git(["rev-parse", "--is-inside-work-tree"], cwd=start)
    if not ok or inside != "true":
        print("not inside a git work tree", file=sys.stderr)
        return 2

    ok, root = git(["rev-parse", "--show-toplevel"], cwd=start)

    ok_super, superproject = git(
        ["rev-parse", "--show-superproject-working-tree"], cwd=root)
    superproject = superproject if (ok_super and superproject) else None

    head_sha = None
    ok, head_sha_raw = git(["rev-parse", "HEAD"], cwd=root)
    if ok and head_sha_raw:
        head_sha = head_sha_raw

    ok, branch = git(["symbolic-ref", "--short", "-q", "HEAD"], cwd=root)
    detached = not ok
    branch = branch if ok else None

    worktree_kind, git_dir_abs, git_common_abs = classify_worktree(root, superproject)

    # default branch, with evidence source
    default_branch, default_branch_source = resolve_default_branch(root, args.default_branch)

    # merge base against default branch
    merge_base = None
    if default_branch:
        for ref in ("refs/remotes/origin/" + default_branch, default_branch):
            ok, mb = git(["merge-base", "HEAD", ref], cwd=root)
            if ok and mb:
                merge_base = mb
                break

    # dirty state
    status_code, porcelain, status_error = run_detailed(
        ["git", "status", "--porcelain", "--untracked-files=all"], cwd=root)
    status_ok = status_code == 0
    changed = [l for l in porcelain.splitlines() if l.strip()] if status_ok else []
    tree_clean = (len(changed) == 0) if status_ok else None
    tree_state = ("CLEAN" if tree_clean else "DIRTY") if status_ok else "UNKNOWN"
    staged = sum(1 for l in changed if l[:2].strip() and l[0] not in " ?")
    unstaged = sum(1 for l in changed if len(l) > 1 and l[1] not in " ?" and l[0] != "?")
    untracked = sum(1 for l in changed if l.startswith("??"))

    # upstream tracking ref (local truth)
    upstream = None
    ahead = behind = None
    tracking_parity = "unknown"
    if not detached:
        ok, up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd=root)
        if ok and up:
            upstream = up
            ok, up_sha = git(["rev-parse", "--verify", "-q", upstream], cwd=root)
            if ok and up_sha and head_sha:
                tracking_parity = "yes" if up_sha == head_sha else "no"
            ok, counts = git(["rev-list", "--left-right", "--count",
                              "HEAD...%s" % upstream], cwd=root)
            if ok and counts:
                left, _, right = counts.partition("\t")
                try:
                    ahead, behind = int(left), int(right)
                except ValueError:
                    ahead = behind = None
    elif upstream is None:
        tracking_parity = "not_applicable" if detached else "unknown"

    # live remote parity (remote truth, read-only ls-remote)
    remote_parity = "unknown"
    remote_branch_sha = None
    remote_reachable = None
    if branch and run_git_remote_ok(root):
        ok, sha = ls_remote_branch(root, branch)
        if ok:
            remote_reachable = True
            if sha:
                remote_branch_sha = sha
                if head_sha:
                    remote_parity = "yes" if sha == head_sha else "no"
            else:
                # Branch does not exist on the remote yet.
                remote_parity = "not_applicable"
        else:
            remote_reachable = False
            remote_parity = "unknown"

    # remotes
    ok, remotes_raw = git(["remote", "-v"], cwd=root)
    fetch_url = push_url = None
    if ok:
        for line in remotes_raw.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0] == "origin":
                if parts[2] == "(fetch)":
                    fetch_url = parts[1]
                elif parts[2] == "(push)":
                    push_url = parts[1]
    identity = parse_remote(fetch_url or push_url)
    push_matches_fetch = (fetch_url == push_url) if (fetch_url or push_url) else None

    # associated PR and checks via gh, only if present
    pr = None
    checks = None
    gh_present = shutil.which("gh") is not None
    if gh_present and head_sha:
        ok, pr_json = run(
            ["gh", "pr", "list", "--head", branch or "", "--state", "open",
             "--json", "number,baseRefName,headRefName,headRefOid,url,mergeStateStatus"],
            cwd=root,
        )
        if ok and pr_json:
            try:
                prs = json.loads(pr_json)
            except ValueError:
                prs = []
            if prs:
                item = prs[0]
                pr = {
                    "number": item.get("number"),
                    "base": item.get("baseRefName"),
                    "head": item.get("headRefName"),
                    "head_sha": item.get("headRefOid"),
                    "url": item.get("url"),
                    "merge_state": item.get("mergeStateStatus"),
                }
        if pr and pr.get("number"):
            ok, checks_json = run(
                ["gh", "pr", "checks", str(pr["number"]), "--json", "name,state,link"],
                cwd=root,
            )
            if ok and checks_json:
                try:
                    checks = json.loads(checks_json)
                except ValueError:
                    checks = None

    facts = {
        "repository": {
            "identity": identity,
            "root": root,
            "git_dir": git_dir_abs,
            "git_common_dir": git_common_abs,
            "superproject_working_tree": superproject,
            "fetch_url": fetch_url,
            "push_url": push_url,
            "push_matches_fetch": push_matches_fetch,
        },
        "branch": {
            "current": branch,
            "detached": detached,
            "default": default_branch,
            "default_source": default_branch_source,
            "upstream": upstream,
        },
        "commit": {
            "head_sha": head_sha,
            "merge_base": merge_base,
        },
        "worktree": {
            "current_kind": worktree_kind,
            "is_submodule": worktree_kind == "submodule",
            "superproject_working_tree": superproject,
        },
        "tree": {
            "clean": tree_clean,
            "state": tree_state,
            "error": None if status_ok else (status_error or "git status failed"),
            "changed_count": len(changed),
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
        },
        "sync": {
            "ahead": ahead,
            "behind": behind,
            "tracking_parity": tracking_parity,
            "remote_parity": remote_parity,
            "remote_branch_sha": remote_branch_sha,
            "remote_reachable": remote_reachable,
        },
        "pull_request": pr,
        "checks": checks,
        "deployment": {
            "identity": "unknown",
            "note": "fill from the deployment platform when relevant",
        },
        "tooling": {
            "gh_present": gh_present,
        },
        "verdict_inputs": {
            "identity_proven": bool(identity.get("owner") and identity.get("name")),
            "root_proven": bool(root),
            "head_proven": bool(head_sha),
            "tree_clean": tree_clean,
            "tree_status": tree_state,
            "default_branch_proven": default_branch_source in ("explicit_override", "remote_head_symref"),
            "default_branch_source": default_branch_source,
            "detached_head": detached,
            "tracking_parity": tracking_parity,
            "remote_parity": remote_parity,
        },
    }

    if args.json:
        print(json.dumps(facts, indent=2, sort_keys=True))
    else:
        print("REPOSITORY: {host}/{owner}/{name}".format(**{
            "host": identity.get("host") or "?",
            "owner": identity.get("owner") or "?",
            "name": identity.get("name") or "?",
        }))
        print("ROOT:       %s" % root)
        print("BRANCH:     %s%s" % (branch or "(detached)", "" if not detached else " [detached]"))
        print("HEAD:       %s" % (head_sha or "unknown"))
        print("DEFAULT:    %s (source: %s)" % (default_branch or "unknown", default_branch_source))
        print("MERGE BASE: %s" % (merge_base or "unknown"))
        tree_summary = ("clean" if tree_state == "CLEAN" else
                        "dirty(%d)" % len(changed) if tree_state == "DIRTY" else
                        "unknown/error (%s)" % (status_error or "git status failed"))
        print("TREE:       %s" % tree_summary)
        print("SYNC:       ahead=%s behind=%s tracking=%s remote=%s (live=%s)" % (
            ahead, behind, tracking_parity, remote_parity, remote_reachable))
        print("PR:         %s" % (("PR #%s base=%s head=%s" % (
            pr.get("number"), pr.get("base"), pr.get("head_sha"))) if pr else "none"))
        print("CHECKS:     %s" % ("present" if checks else "unknown"))
        print("WORKTREE:   current=%s" % worktree_kind)
        if superproject:
            print("SUPERPROJECT: %s" % superproject)
        print("GH:         %s" % ("present" if gh_present else "absent"))
        print("--- verdict inputs ---")
        for key, value in facts["verdict_inputs"].items():
            print("%-24s %s" % (key, value))
    return 0


if __name__ == "__main__":
    sys.exit(main())
