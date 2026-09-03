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
3. Mode is ordinary text: special-token-looking input (for example `<|endoftext|>`)
   is encoded as ordinary text. It MUST NOT throw because it resembles a special
   token, and it MUST NOT receive privileged single-special-token handling.
   Semantically this is `encode(text, [], [])` (no allowed and no disallowed
   special tokens) on the `js-tiktoken@1.0.21` lite `Tiktoken` over the bundled
   `o200k_base` ranks, which works offline after installation.
4. Input is canonical text after SPEC-002 normalization. Counting never runs on
   pre-normalization source bytes.
5. Runtime network dependency is none: the bundled ranks ship with the package and
   counting works offline after installation.
6. The router/golden harness (TEST-001) REFUSES to run when the estimator ID is not
   `ega-o200k-v1`. A passing suite under a different estimator is NOT V1-compatible.
7. Linux and Windows results MUST match exactly.
8. Any change to encoding, token ranks, pre-tokenization behavior,
   ordinary/special-token handling, canonical input rules, or normative T001–T009
   results REQUIRES a new estimator identifier, `ega-o200k-v2`. The `ega-o200k-v1`
   identifier pins all of the above and MUST NOT be silently mutated.

## §6.2 Counting rules (frozen)

1. Count the EXACT canonical texts: L1 = full canonical `SKILL.core.md`; L2 = full
   canonical `SKILL.md` including frontmatter (SPEC-002 §5.1.16).
2. CRLF and LF inputs count IDENTICALLY (canonicalization precedes counting):
   `Hello\r\nworld` and `Hello\nworld` canonicalize to identical text before token
   counting.
3. BOM and no-BOM inputs count IDENTICALLY: BOM + `Hello` (a leading `U+FEFF`
   followed by `Hello`) and `Hello` count identically after canonicalization.
4. Unicode source is NOT normalized before counting: NFC/NFD source strings remain
   code-point-distinct. `café` (single code point `U+00E9`) and `cafe` + `U+0301`
   (that is, `cafe\u0301`) remain code-point-distinct inputs. Do not add NFC/NFD
   normalization. Their token counts are NOT required to differ.
5. `<|endoftext|>` is handled as ORDINARY text (no special-token split, no throw,
   no privileged single-token handling).
6. Binary input is NOT tokenized: direct binary input to the text estimator maps to
   `E_TOKEN_BINARY_INPUT`. Binary blobs have no `token_counts` row and project as
   null/unavailable — never zero (SPEC-001 §5.1.19, SPEC-003 §5.1.16). A binary
   token count is unavailable; it does not produce `0` and does not create a row.

## §6.3 Failure contract (frozen)

- Estimator initialization failure → `E_TOKEN_ESTIMATOR_UNAVAILABLE`.
- Reference-vector mismatch at verification → `E_TOKEN_ESTIMATOR_INCOMPATIBLE`
  (tests fail; harness refuses downstream golden budget assertions).
- CI/release verification runs the full vector suite; production startup is NOT
  required to rerun all vectors on every invocation.

## §6.4 Normative vector inventory T001–T009 (exact)

The nine reference vectors below pin the estimator. This table is the frozen
contract. EGA-557 builds against this contract; it does not define it.

| ID | Exact input | Expected token count |
|---|---|---:|
| T001 | empty string | 0 |
| T002 | `Hello` | 1 |
| T003 | `hello world` | 2 |
| T004 | `Hello world` | 2 |
| T005 | `Hello, world!` | 4 |
| T006 | `こんにちは` | 1 |
| T007 | `こんにちは世界` | 2 |
| T008 | `你好世界` | 2 |
| T009 | `The quick brown fox jumps over the lazy dog` | 9 |

Notes:

1. T001 input is exactly `""` (zero characters). The words "empty string" in the
   table are a description of that input, not the input itself.
2. Every other row's backticked cell is the exact JS string input (no added
   newline, no trimming, no case change).
3. Counts are ordinary-text `o200k_base` counts of the canonical inputs above.
4. Once committed as fixture data under `tests/tokens/`, any drift fails under
   `E_TOKEN_ESTIMATOR_INCOMPATIBLE` unless a reviewed spec amendment explains it.

**Provenance note:** T001–T009 were independently verified against
js-tiktoken@1.0.21 using o200k_base before implementation.

## §6.5 Harness location and gates

1. Vectors live under `tests/tokens/` and run on Linux + Windows CI.
2. TEST-002 is a HARD GATE: budget-aware router behavior (TEST-001 G034–G039
   content/token assertions, SPEC-004 §5.1.6 composition) MUST NOT be accepted
   until TEST-002 passes on both platforms.
3. Production startup is not required to rerun all vectors every invocation (§6.3).
