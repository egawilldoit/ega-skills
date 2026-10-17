# Routing report (final 114-skill hub)

Corpus: cross-catalog collision corpus, 456 tasks (positive/negative).

- total 456
- passed 445
- AUTO_SELECTION_FAILURE 0
- POSITIVE_ROUTING_FAILURE 0
- STRICT_CANDIDATE_FAILURE 0
- BAD_EXPECTATION remaining 0 (2 corpus corrections: auto-373, auto-383 — dual valid owners)
- existing-48-expected tasks 144; regressions 0
- LOW_CONFIDENCE_CANDIDATE_WARNING 11 (documented, non-blocking)

The 11 warnings are documented in `routing-adjudication.md`. Primary causes: principle skills are explicit/narrow by design; several mattpocock skills are `disable-model-invocation: true`; and a small number of confidence near-misses.

Release blocker count: 0.
