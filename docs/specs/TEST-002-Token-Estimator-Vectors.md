# TEST-002 — `ega-o200k-v1` Token Estimator Vectors

**Status:** FROZEN (V1 normative test contract).
**Incorporates:** EGA-605 A3/A14 decisions (binary NULL rule, L1/L2 countable content
basis) and the reviewed TEST-002 contract corrections (failure codes, estimator-identity
gate, versioning rule).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

---

## §6.1 Estimator identity (frozen)

1. Estimator ID is exactly `ega-o200k-v1`.
2. Implementation uses `js-tiktoken@1.0.21` with the BUNDLED `o200k_base` ranks —
   ordinary-text behavior, canonical text input (SPEC-002 §5.1.6). No CDN, no network,
   no client-specific estimator, no dependency drift.
3. The router/golden harness (TEST-001) REFUSES to run when the estimator ID is not
   `ega-o200k-v1`. A passing suite under a different estimator is NOT V1-compatible.
4. Linux and Windows results MUST match exactly.
5. Any change to encoding, token ranks, pre-tokenization, ordinary/special handling,
   canonical input rules, or normative vector counts REQUIRES a new estimator ID
   (the `ega-o200k-v1` ID pins all of the above).

## §6.2 Counting rules (frozen)

1. Count the EXACT canonical texts: L1 = full canonical `SKILL.core.md`; L2 = full
   canonical `SKILL.md` including frontmatter (SPEC-002 §5.1.16).
2. CRLF and LF inputs count IDENTICALLY (canonicalization precedes counting).
3. BOM and no-BOM inputs count IDENTICALLY.
4. Unicode source is NOT normalized before counting: NFC/NFD source strings remain
   code-point-distinct (vector N003 proves distinctness; their counts are NOT
   required to differ).
5. `<|endoftext|>` is handled as ORDINARY text (no special-token split).
6. Binary input is NOT tokenized: it returns `E_TOKEN_BINARY_INPUT`. Binary blobs
   have no `token_counts` row and project as null/unavailable — never zero
   (SPEC-001 §5.1.19, SPEC-003 §5.1.16).

## §6.3 Failure contract (frozen)

- Estimator initialization failure → `E_TOKEN_ESTIMATOR_UNAVAILABLE`.
- Reference-vector mismatch at verification → `E_TOKEN_ESTIMATOR_INCOMPATIBLE`
  (tests fail; harness refuses downstream golden budget assertions).
- CI/release verification runs the full vector suite; production startup is NOT
  required to rerun all vectors on every invocation.

## §6.4 Normative vector inventory T001–T009 (exact)

The nine reference vectors pin the estimator. Each vector below is identified by its
frozen ID, its normative input class, and its assertion class. Exact input strings
and exact expected counts are committed as frozen fixture data under
`tests/tokens/` by EGA-557 (which implements this contract); once committed, any
drift fails under `E_TOKEN_ESTIMATOR_INCOMPATIBLE` unless a reviewed spec amendment
explains it.

| ID | Normative input class | Assertion class |
| --- | --- | --- |
| T001 | empty string | exact count pinned (baseline) |
| T002 | short ASCII sentence | exact count pinned |
| T003 | multi-line Markdown with headings, list, and code fence | exact count pinned |
| T004 | CRLF variant of a T003-class input | count EQUALS its LF twin (equivalence) |
| T005 | BOM-prefixed variant of a T003-class input | count EQUALS its no-BOM twin (equivalence) |
| T006 | non-BMP/emoji-bearing text incl. the SPEC-001 1024-code-point boundary shape | exact count pinned; proves code-point (not UTF-16/UTF-8) length handling |
| T007 | NFC vs NFD source pair (N003) | inputs remain code-point-distinct; counts recorded (not required to differ) |
| T008 | text containing the literal `<\|endoftext\|>` | ordinary-text handling; exact count pinned |
| T009 | long deterministic reference paragraph (budget-scale, multi-thousand tokens) | exact count pinned; anchors LARGE-class budget behavior |

Normalization and special-token behavior asserted by T004/T005/T007/T008 are
NORMATIVE (part of §6.2), not informational.

**Provenance note (single declared deferral, EGA-550):** the exact T001–T009 input
strings and integer counts live in the pre-amendment frozen bundle attachment,
which has no retrievable copy in Linear (EGA-550 carries zero attachments); they
are therefore frozen FORWARD by EGA-557 implementation under the
`E_TOKEN_ESTIMATOR_INCOMPATIBLE` drift rule above rather than transcribed here.
No other section of the eight-file V1 contract carries such a deferral. This is a
defined freeze process with an owning ticket — not an open placeholder — and is
reported as the sole deviation in the EGA-550 close-out comment.

## §6.5 Harness location and gates

1. Vectors live under `tests/tokens/` and run on Linux + Windows CI.
2. TEST-002 is a HARD GATE: budget-aware router behavior (TEST-001 G034–G039
   content/token assertions, SPEC-004 §5.1.6 composition) MUST NOT be accepted
   until TEST-002 passes on both platforms.
3. Production startup is not required to rerun all vectors every invocation (§6.3).
