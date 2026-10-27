# Issue 168 routing review (canonical governed evaluation)

This is pre-adoption evidence, not release certification. The final run used the
verified 126-skill canonical registry, the reviewable invocation policy
`sha256:0e5304ee…` and the independently reproduced I1 release
`sha256:08b12c28…`. It is not a synthetic scratch fixture.

All 82 automatic-selection lists were unchanged. The same 22 incorrect automatic
selections present at the 117 baseline are still present; none is new and none
changed identity. Top-1 stayed at 44/82; top-3 improved from 71/82 to 72/82.
Catastrophic automatic selections remained zero.

Targeted governed results: 27/27 reviewed positive phrase alternatives, 9/9
explicit references at the exact version, and 11/11 negative/ambiguous prompts
with no TStack automatic selection. The prior `full send buffer` and `city
council data model` false positives are eliminated.

The ten previously observed suggestion-list changes were examined individually:

| Corpus case | Disposition |
| --- | --- |
| compare-designs | Expected skill remains first; alternatives exchange order. |
| ci-until-green | Expected skill remains first; fix-ci rises. |
| verify-ui | Expected skill moves from third to second. |
| pr-comments | Expected skill remains first; third alternative changes. |
| resume-previous-agent-work | Expected recover-work-context enters third; previously absent. |
| ui-product-design | Expected skill absent in both; lower alternatives exchange order. |
| technical-writing | Expected skill absent in both; third alternative changes. |
| handoff-context | Expected skill remains first; alternatives exchange order. |
| sequence-verifiable-units | Expected skill remains first; third alternative changes. |
| test-behavior-not-impl | Expected skill remains second; third alternative changes. |

Nine additional cases gained separated, `INVOCATION_UNCONFIRMED` candidates
when the original candidate list was empty. They do not become automatic
selections. This is a suggestion-quality degradation in the cases identified as
irrelevant; I1 requires discovered separated rows to be appended into free
candidate slots. It must not be described as unchanged suggestion behavior.

| Corpus case | Added candidates and assessment |
| --- | --- |
| architecture-design | file-pr, babysit-pr, takeover: irrelevant. |
| tdd-explicit | council, full-send, full-stop: irrelevant. |
| new-branch-and-pr | file-pr relevant; takeover and babysit-pr weak. |
| weekly-review | file-pr, babysit-pr, takeover: irrelevant. |
| prove-really-deployed | council, full-send, full-stop: irrelevant. |
| large-investigation | council, full-send, full-stop: irrelevant. |
| preflight-repository | leaving-pr-comments: irrelevant. |
| prose-tells | council, full-send, full-stop: irrelevant. |
| release-certification-console | babysit-pr: weak. |

The network full-send-buffer and city-council data-model prompts selected
neither TStack skill; reviewed Council and Full Send workflow phrases selected
the intended skill. All 27 reviewed phrase alternatives, all nine explicit
references and 11 negative/ambiguous cases passed in the canonical run.
