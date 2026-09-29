#!/usr/bin/env python3
"""Validate that an execution contract contains every required section.

Deterministic structural check only. It does not judge quality or correctness.
The model still reviews meaning.

Usage:
    python3 validate_contract.py CONTRACT.md
    cat CONTRACT.md | python3 validate_contract.py -

Exit codes:
    0  all required sections present
    1  one or more sections missing
"""

import re
import sys

REQUIRED = [
    "MISSION",
    "REPOSITORY IDENTITY",
    "BASE SHA",
    "HEAD SHA",
    "MODE",
    "AUTHORIZED MUTATION",
    "CURRENT VERIFIED STATE",
    "AUTHORIZED DELTA",
    "MUST PRESERVE",
    "FORBIDDEN SCOPE",
    "ARCHITECTURE INVARIANTS",
    "IMPLEMENTATION REQUIREMENTS",
    "VALIDATION LADDER",
    "REQUIRED EVIDENCE",
    "STOP CONDITIONS",
    "MERGE AUTHORITY",
    "PRODUCTION AUTHORITY",
    "FINAL REPORT FORMAT",
]


def read_text(path):
    if path == "-":
        return sys.stdin.read()
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def main(argv):
    if len(argv) != 2:
        print("usage: validate_contract.py CONTRACT.md | -", file=sys.stderr)
        return 2
    text = read_text(argv[1])
    upper = text.upper()

    missing = []
    for section in REQUIRED:
        # Accept "## SECTION" or "SECTION" followed by a colon or newline.
        pattern = r"(?im)^\s{0,3}(#{1,6}\s*)?" + re.escape(section) + r"\b"
        if not re.search(pattern, upper):
            missing.append(section)

    if missing:
        print("MISSING SECTIONS (%d):" % len(missing))
        for section in missing:
            print("  - %s" % section)
        return 1

    print("OK: all %d required sections present" % len(REQUIRED))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
