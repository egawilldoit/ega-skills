#!/usr/bin/env python3
"""Compare PR acceptance evidence SHAs against the exact current PR head.

Read-only. Establishes deterministic SHA facts. The model decides which
sources are required and how to act on the verdict.

Two distinct SHA concepts per CI source:

    associated_head_sha
        the PR head/check-suite SHA the hosting platform associates the
        check with

    executed_sha
        the exact commit checked out and executed inside the validation job

These can differ. A check attached to the head but executing a synthetic
merge commit is MERGE_RESULT evidence: it proves the proposed head validates
when merged with the current base, NOT that the head itself was validated.
Exact-head certification requires associated == executed == reference head
with a successful conclusion.

Usage:
    python3 certify_pr_head.py --pr 123
    python3 certify_pr_head.py --pr 123 --reviewed <sha> --tested <sha> \
        --ci-associated-head <sha> --ci-executed-sha <sha> --ci-conclusion success
    python3 certify_pr_head.py --head <sha> --reviewed <sha>
    python3 certify_pr_head.py --pr 123 --evidence evidence.json

evidence.json shape:
    {"reviewed": "<sha>", "tested": "<sha>", "head": "<sha>",
     "ci": {"associated_head_sha": "<sha>", "executed_sha": "<sha>",
            "run_id": "<id>", "conclusion": "success"}}

Legacy shape ({"ci": "<sha>"}) is accepted but can never satisfy exact-head
certification because the executed SHA is unknown.

--evidence-head is the head SHA that was current when the evidence was
produced. Supplying it lets the script distinguish HEAD_MOVED from
STALE_EVIDENCE.

Verdicts:
    EXACT_HEAD_CERTIFIED  all provided evidence matches the exact head and
                          CI executed on that exact head successfully
    STALE_EVIDENCE        evidence covers an older commit, head unchanged
    HEAD_MOVED            evidence matched the head at evidence time, but the
                          head has moved since
    INCOMPLETE            some required evidence is missing, unresolved, or
                          does not prove exact-head execution

Exit codes:
    0  verdict emitted
    2  reference head could not be resolved
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
            text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False, ""
    if proc.returncode != 0:
        return False, ""
    return True, proc.stdout.strip()


def expand_sha(sha, cwd):
    """Expand an abbreviated SHA to full 40 chars when possible."""
    if not sha:
        return None
    if len(sha) == 40:
        return sha.lower()
    ok, full = run(["git", "rev-parse", "--verify", "-q", sha + "^{commit}"], cwd=cwd)
    if ok and full:
        return full.lower()
    return None


def classify(evidence_sha, reference, cwd):
    """Return (status, full_sha, detail)."""
    if not evidence_sha:
        return "missing", None, "not provided"
    full = expand_sha(evidence_sha, cwd)
    if full is None:
        return "missing", evidence_sha, "abbreviated or unresolvable; cannot certify"
    if full == reference:
        return "match", full, "exact head"
    ok, _ = run(["git", "merge-base", "--is-ancestor", full, reference], cwd=cwd)
    if ok:
        return "stale", full, "ancestor of head"
    return "stale", full, "does not match head"


def evidence_sha_of(value):
    """Accept either a bare SHA string or an object with a "sha" field."""
    if isinstance(value, dict):
        return value.get("sha")
    return value


def classify_ci(ci_evidence, reference, cwd):
    """Classify CI evidence, keeping associated and executed SHA separate.

    Returns a dict with:
        status            missing | failed | match | stale
        mode              UNKNOWN | HEAD | MERGE_RESULT
        associated        full sha or None
        associated_status  missing | supplied-unresolvable | match | stale
        executed          full sha or None
        executed_status    missing | supplied-unresolvable | match | stale
        conclusion        raw conclusion or None
        run_id            raw run id or None
        detail            human-readable explanation
    """
    result = {
        "status": "missing", "mode": "UNKNOWN",
        "associated": None, "associated_status": "missing",
        "executed": None, "executed_status": "missing",
        "conclusion": None, "run_id": None, "detail": "no CI evidence provided",
    }
    if not ci_evidence:
        return result

    if isinstance(ci_evidence, dict):
        associated = ci_evidence.get("associated_head_sha") or ci_evidence.get("sha")
        executed = ci_evidence.get("executed_sha")
        conclusion = ci_evidence.get("conclusion")
        run_id = ci_evidence.get("run_id")
    else:
        associated = ci_evidence
        executed = None
        conclusion = None
        run_id = None

    result["conclusion"] = conclusion
    result["run_id"] = run_id

    if associated:
        associated_full = expand_sha(associated, cwd)
        if associated_full is None:
            result["associated_status"] = "supplied-unresolvable"
            result["detail"] = "associated head SHA cannot be resolved"
        else:
            result["associated"] = associated_full
            result["associated_status"] = (
                "match" if associated_full == reference else "stale")
    else:
        result["associated_status"] = "missing"

    if not executed:
        # Only an associated SHA is known. Platform check association alone
        # proves nothing about what code actually executed.
        result["status"] = "missing"
        result["associated_status"] = result["associated_status"] if associated else "missing"
        result["detail"] = ("CI associated SHA present but executed SHA unknown; "
                            "cannot prove what code was validated")
        return result

    executed_full = expand_sha(executed, cwd)
    if executed_full is None:
        result["executed_status"] = "supplied-unresolvable"
        result["status"] = "missing"
        result["detail"] = "executed SHA cannot be resolved"
        return result
    result["executed"] = executed_full

    if conclusion is None or (isinstance(conclusion, str) and not conclusion.strip()):
        result["status"] = "missing"
        result["executed_status"] = classify(executed_full, reference, cwd)[0]
        result["detail"] = "CI conclusion is missing"
        return result

    if not isinstance(conclusion, str) or conclusion.strip().lower() != "success":
        result["status"] = "failed"
        result["executed_status"] = (
            "match" if executed_full == reference
            else classify(executed_full, reference, cwd)[0])
        result["detail"] = "CI conclusion is %r, not success" % conclusion
        return result

    if result["associated_status"] != "match":
        result["status"] = ("stale" if result["associated_status"] == "stale"
                            else "missing")
        result["executed_status"] = classify(executed_full, reference, cwd)[0]
        result["detail"] = "CI associated head does not match the reference head"
        return result

    if executed_full == reference:
        result["executed_status"] = "match"
        result["mode"] = "HEAD"
        result["status"] = "match"
        result["detail"] = "CI executed on the exact head"
        return result

    result["executed_status"] = classify(executed_full, reference, cwd)[0]
    result["mode"] = "MERGE_RESULT"
    result["status"] = "merge_result_only"
    result["detail"] = ("CI executed on %s, not the exact head; this is "
                        "merge-result evidence only" % executed_full)
    return result


def main():
    parser = argparse.ArgumentParser(description="Certify PR head evidence (read-only).")
    parser.add_argument("--pr", type=int, default=None, help="pull request number")
    parser.add_argument("--repo", default=None, help="owner/name for gh")
    parser.add_argument("--head", default=None, help="reference head SHA (skips gh lookup)")
    parser.add_argument("--evidence-head", default=None, help="head SHA current when evidence was produced")
    parser.add_argument("--reviewed", default=None)
    parser.add_argument("--tested", default=None)
    parser.add_argument("--ci", default=None,
                        help="legacy: CI SHA only (executed SHA unknown)")
    parser.add_argument("--ci-associated-head", default=None)
    parser.add_argument("--ci-executed-sha", default=None)
    parser.add_argument("--ci-conclusion", default=None)
    parser.add_argument("--ci-run-id", default=None)
    parser.add_argument("--evidence", default=None, help="JSON file with evidence SHAs")
    parser.add_argument("--cwd", default=".", help="repo path for sha expansion")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    reviewed, tested = args.reviewed, args.tested
    ci_evidence = None
    evidence_head = args.evidence_head
    if args.evidence:
        with open(args.evidence, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        reviewed = reviewed or evidence_sha_of(data.get("reviewed"))
        tested = tested or evidence_sha_of(data.get("tested"))
        evidence_head = evidence_head or evidence_sha_of(data.get("head"))
        ci_evidence = data.get("ci")

    # CLI flags win over the evidence file for the CI block.
    cli_ci = {}
    if args.ci:
        cli_ci["sha"] = args.ci
    if args.ci_associated_head:
        cli_ci["associated_head_sha"] = args.ci_associated_head
    if args.ci_executed_sha:
        cli_ci["executed_sha"] = args.ci_executed_sha
    if args.ci_conclusion:
        cli_ci["conclusion"] = args.ci_conclusion
    if args.ci_run_id:
        cli_ci["run_id"] = args.ci_run_id
    if cli_ci:
        ci_evidence = dict(ci_evidence) if isinstance(ci_evidence, dict) else ci_evidence
        if isinstance(ci_evidence, dict):
            ci_evidence = {**ci_evidence, **cli_ci}
        else:
            ci_evidence = cli_ci

    reference = args.head
    pr_number = args.pr
    source = "argument"

    if not reference and pr_number is not None:
        if shutil.which("gh") is None:
            print("gh not found and no --head given", file=sys.stderr)
            return 2
        cmd = ["gh", "pr", "view", str(pr_number), "--json",
               "headRefOid,number,url,baseRefName,headRefName"]
        if args.repo:
            cmd += ["--repo", args.repo]
        ok, out = run(cmd, cwd=args.cwd)
        if not ok or not out:
            print("could not resolve PR head via gh", file=sys.stderr)
            return 2
        info = json.loads(out)
        reference = info.get("headRefOid")
        source = "gh"
    if not reference:
        print("no reference head resolved; pass --pr or --head", file=sys.stderr)
        return 2
    reference = reference.lower()

    results = {}
    statuses = {}
    for name, value in (("reviewed", reviewed), ("tested", tested)):
        status, full, detail = classify(value, reference, args.cwd)
        results[name] = {"sha": full, "status": status, "detail": detail}
        statuses[name] = status

    ci = classify_ci(ci_evidence, reference, args.cwd)
    results["ci"] = {
        "associated_head_sha": ci["associated"],
        "associated_status": ci["associated_status"],
        "executed_sha": ci["executed"],
        "executed_status": ci["executed_status"],
        "execution_mode": ci["mode"],
        "conclusion": ci["conclusion"],
        "run_id": ci["run_id"],
        "status": ci["status"],
        "detail": ci["detail"],
    }
    statuses["ci"] = ci["status"]

    provided = {k: v for k, v in statuses.items()
                if v not in ("missing", "merge_result_only")}
    evidence_head_full = expand_sha(evidence_head, args.cwd) if evidence_head else None

    merge_result_only = (
        ci["status"] == "merge_result_only"
        and all(v == "missing" for name, v in statuses.items() if name != "ci")
    )

    if not provided and ci["status"] == "missing":
        verdict = "INCOMPLETE"
        reason = "no evidence SHA could be resolved"
    elif merge_result_only:
        verdict = "INCOMPLETE"
        reason = ("CI succeeded on merge-result SHA but no CI execution on "
                  "exact PR head was proven")
    elif evidence_head_full and evidence_head_full != reference:
        matches_old_head = any(v == "match" for v in provided.values())
        # All evidence must have matched the old head for this to be a clean move.
        all_match_old = all(
            ((results[name]["associated_head_sha"] == evidence_head_full and
              results[name]["executed_sha"] == evidence_head_full)
             if name == "ci" else results[name]["sha"] == evidence_head_full)
            for name in provided
        )
        if all_match_old or matches_old_head:
            verdict = "HEAD_MOVED"
            reason = "head changed from %s to %s after evidence was produced" % (
                evidence_head_full, reference)
        else:
            verdict = "STALE_EVIDENCE"
            reason = "evidence does not match the current head"
    elif any(v == "stale" for v in provided.values()):
        verdict = "STALE_EVIDENCE"
        reason = "evidence covers an older commit; head is unchanged"
    elif ci["status"] == "failed":
        verdict = "INCOMPLETE"
        reason = "CI conclusion is %r; a failed CI run cannot certify the head" % (
            ci["conclusion"],)
    elif ci_evidence and ci["status"] == "merge_result_only":
        verdict = "INCOMPLETE"
        reason = ("CI executed SHA %s differs from the reference head; "
                  "exact-head certification requires CI to execute the "
                  "exact head" % ci["executed"])
    elif any(v == "missing" for v in statuses.values()):
        verdict = "INCOMPLETE"
        reason = "one or more evidence sources are missing or unresolvable"
    else:
        verdict = "EXACT_HEAD_CERTIFIED"
        reason = "all provided evidence matches the exact head and CI executed on that exact head successfully"

    output = {
        "verdict": verdict,
        "reason": reason,
        "reference_head": reference,
        "reference_source": source,
        "evidence_head": evidence_head_full,
        "pr": pr_number,
        "ci_execution_mode": ci["mode"],
        "ci_associated_head_sha": ci["associated"],
        "ci_executed_sha": ci["executed"],
        "ci_conclusion": ci["conclusion"],
        "ci_run_id": ci["run_id"],
        "evidence": results,
    }

    if args.json:
        print(json.dumps(output, indent=2, sort_keys=True))
    else:
        print("VERDICT: %s" % verdict)
        print("REASON: %s" % reason)
        print("REFERENCE HEAD: %s (%s)" % (reference, source))
        if evidence_head_full:
            print("EVIDENCE HEAD: %s" % evidence_head_full)
        if pr_number is not None:
            print("PR: #%s" % pr_number)
        for name in ("reviewed", "tested"):
            item = results[name]
            print("%-9s %s -> %s (%s)" % (
                name.upper() + ":", item["sha"], item["status"], item["detail"]))
        item = results["ci"]
        print("CI ASSOCIATED HEAD: %s (%s)" % (
            item["associated_head_sha"] or "unknown", item["associated_status"]))
        print("CI EXECUTED SHA:  %s (%s)" % (
            item["executed_sha"] or "unknown", item["executed_status"]))
        print("CI EXECUTION MODE: %s" % item["execution_mode"])
        print("CI CONCLUSION: %s" % (item["conclusion"] or "unknown"))
        print("BLOCKING SOURCES: %s" % (", ".join(
            k for k, v in statuses.items()
            if v in ("stale", "missing", "failed", "merge_result_only")) or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
