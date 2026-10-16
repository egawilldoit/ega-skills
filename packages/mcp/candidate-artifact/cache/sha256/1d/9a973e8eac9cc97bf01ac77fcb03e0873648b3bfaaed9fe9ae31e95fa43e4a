#!/usr/bin/env python3
"""Discover and verify a stacked-PR chain.

Read-only. Uses gh to list open pull requests and git to verify ancestry when
the objects are available locally. The model interprets ambiguity and decides
how to act.

Usage:
    python3 discover_stack.py [--repo owner/name] [--default-branch NAME]
    python3 discover_stack.py --json

The default branch is not assumed. Without --default-branch the script
resolves the repository's actual default branch from GitHub (via
`gh repo view --json defaultBranchRef`) or the Git remote HEAD symref. If it
cannot be resolved, the script exits with an insufficient-evidence error
instead of inventing one; use --default-branch to pass an explicit override.

Exit codes:
    0  stack discovered (may be a single PR or none)
    2  could not list pull requests
"""

import argparse
import json
import shutil
import subprocess
import sys


def run(cmd, cwd=None):
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return False, ""
    if proc.returncode != 0:
        return False, ""
    return True, proc.stdout.strip()


def is_ancestor(older, newer, cwd):
    if not older or not newer:
        return "unknown"
    ok, _ = run(["git", "merge-base", "--is-ancestor", older, newer], cwd=cwd)
    if ok:
        return "yes"
    # Distinguish a real negative from missing objects.
    ok_rev, _ = run(["git", "rev-parse", "--verify", "-q", older + "^{commit}"], cwd=cwd)
    ok_rev2, _ = run(["git", "rev-parse", "--verify", "-q", newer + "^{commit}"], cwd=cwd)
    if ok_rev and ok_rev2:
        return "no"
    return "unknown"


def resolve_default_branch(args):
    """Resolve the repository default branch with a recorded source.

    Returns (default_branch, default_branch_source). Sources, best first:
        explicit_override   -- caller passed --default-branch
        github_default_ref  -- gh repo view defaultBranchRef
        git_remote_head     -- `git ls-remote --symref origin HEAD`
    """
    if args.default_branch:
        return args.default_branch, "explicit_override"

    cmd = ["gh", "repo", "view", "--json", "defaultBranchRef"]
    if args.repo:
        cmd += ["--repo", args.repo]
    ok, out = run(cmd, cwd=args.cwd)
    if ok and out:
        try:
            info = json.loads(out) or {}
            ref = (info.get("defaultBranchRef") or {}).get("name")
            if ref:
                return ref, "github_default_ref"
        except ValueError:
            pass

    ok, out = run(["git", "ls-remote", "--symref", "origin", "HEAD"], cwd=args.cwd)
    if ok and out:
        for line in out.splitlines():
            symref, _, sha = line.partition("\t")
            if symref.startswith("ref: refs/heads/"):
                return symref[len("ref: refs/heads/"):], "git_remote_head"

    return None, "unknown"


def main():
    parser = argparse.ArgumentParser(description="Discover a stacked-PR chain (read-only).")
    parser.add_argument("--repo", default=None, help="owner/name for gh")
    parser.add_argument("--default-branch", default=None,
                        help="explicit default-branch override; resolved from "
                             "GitHub/remote when omitted")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    default_branch, default_branch_source = resolve_default_branch(args)
    if not default_branch:
        print("ERROR: default branch could not be resolved from GitHub or the "
              "Git remote; pass --default-branch explicitly", file=sys.stderr)
        return 2

    if shutil.which("gh") is None:
        print("gh not found", file=sys.stderr)
        return 2

    cmd = ["gh", "pr", "list", "--state", "open", "--limit", str(args.limit),
           "--json", "number,title,url,isDraft,baseRefName,headRefName,baseRefOid,headRefOid"]
    if args.repo:
        cmd += ["--repo", args.repo]
    ok, out = run(cmd, cwd=args.cwd)
    if not ok:
        print("could not list pull requests", file=sys.stderr)
        return 2
    prs = json.loads(out) if out else []

    by_head = {}
    by_base = {}
    for pr in prs:
        by_head.setdefault(pr.get("headRefName"), []).append(pr)
        by_base.setdefault(pr.get("baseRefName"), []).append(pr)

    # Bottoms are PRs targeting the default branch.
    bottoms = [pr for pr in prs if pr.get("baseRefName") == default_branch]

    chains = []
    for bottom in bottoms:
        chain = []
        current = bottom
        seen = set()
        while current is not None:
            num = current.get("number")
            if num in seen:
                break
            seen.add(num)
            chain.append(current)
            children = by_base.get(current.get("headRefName"), [])
            # A well-formed stack has exactly one child per head.
            current = children[0] if len(children) == 1 else None
            if len(children) > 1:
                chain[-1] = dict(chain[-1])
                chain[-1]["fork"] = [c.get("number") for c in children]
        chains.append(chain)

    # Orphans: open PRs not reachable from any bottom.
    reachable = {pr.get("number") for chain in chains for pr in chain}
    orphans = [pr.get("number") for pr in prs if pr.get("number") not in reachable]

    report = {
        "default_branch": default_branch,
        "default_branch_source": default_branch_source,
        "chains": [],
        "orphans": orphans,
    }
    for chain in chains:
        entries = []
        for index, pr in enumerate(chain):
            entry = {
                "number": pr.get("number"),
                "title": pr.get("title"),
                "base": pr.get("baseRefName"),
                "head": pr.get("headRefName"),
                "base_sha": pr.get("baseRefOid"),
                "head_sha": pr.get("headRefOid"),
                "draft": pr.get("isDraft"),
                "url": pr.get("url"),
            }
            if "fork" in pr:
                entry["fork"] = pr["fork"]
            if index > 0:
                lower = chain[index - 1]
                entry["ancestry_from_below"] = is_ancestor(
                    lower.get("headRefOid"), pr.get("baseRefOid"), args.cwd)
            entries.append(entry)
        report["chains"].append({"length": len(entries), "prs": entries})

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print("DEFAULT BRANCH: %s (source: %s)" % (default_branch, default_branch_source))
        if not report["chains"]:
            print("STACK: none (no open PR targets the default branch)")
        for index, chain in enumerate(report["chains"], 1):
            print("STACK %d: length %d" % (index, chain["length"]))
            for entry in chain["prs"]:
                ancestry = entry.get("ancestry_from_below", "")
                suffix = (" ancestry=%s" % ancestry) if ancestry else ""
                fork = (" FORK=%s" % entry["fork"]) if "fork" in entry else ""
                print("  #%s %s <- %s (%s)%s%s" % (
                    entry["number"], entry["head"], entry["base"],
                    entry["head_sha"][:12] if entry["head_sha"] else "?", suffix, fork))
        if orphans:
            print("ORPHANS (not in any chain): %s" % ", ".join(str(o) for o in orphans))
    return 0


if __name__ == "__main__":
    sys.exit(main())
