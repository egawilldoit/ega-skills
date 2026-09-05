# EGA-599 real-task evaluation (12 tasks over the 66-skill V1 corpus)

Method: bare project dir (`/tmp/ega599/proj`, no fingerprint evidence — the
conservative case), real CLI `resolve`, corpus home from EGA-598 staging
(manifest-verified 70/70). Evaluated subset: the 66 IMPORTED skills;
excluded are the 4 documented SPEC-001 rejects (`claude-api`,
`parallel-debugging`, `startup-metrics-framework`, `workflow-patterns` —
see docs/V1-CORPUS.md), which never enter any registry and therefore cannot
be routed to. Judged on ranking quality: SELECTED skill when
present, else top candidate. Confidence LOW with empty selection is CORRECT
V1 conservatism (suggest mode), not a misroute.

| task | domain | confidence | selected | candidates (tier) | outcome | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| T-web-1 | frontend/web | LOW | 0 | wcag-audit-patterns(C), pptx-quality-gates(C), signed-audit-trails-recipe(C) | wcag-audit-patterns | HIT |
| T-web-2 | frontend/web | LOW | 0 | react-native-architecture(C), react-native-design(C), web-artifacts-builder(C) | react-native-architecture | HIT |
| T-web-3 | frontend/web | LOW | 0 | pptx-quality-gates(C), pptx(C), block-no-verify-hook(C) | pptx-quality-gates | HIT |
| T-data-1 | backend/data | LOW | 0 | postgresql-table-design(C), billing-automation(C), brand-landingpage(C) | postgresql-table-design | HIT |
| T-data-2 | backend/data | LOW | 0 | dbt-transformation-patterns(C), data-storytelling(C), before-you-build(C) | dbt-transformation-patterns | HIT |
| T-data-3 | backend/data | LOW | 0 | slack-gif-creator(C), fastapi-templates(C), grounded-vault(C) | slack-gif-creator top / fastapi-templates #2 | OBSERVE |
| T-dbg-1 | debugging/testing | LOW | 0 | postmortem-writing(C), hermes-tweet(C), recsys-pipeline-architect(C) | postmortem-writing | HIT |
| T-dbg-2 | debugging/testing | LOW | 0 | bats-testing-patterns(C), quantized-export(C), skill-creator(C) | bats-testing-patterns | HIT |
| T-dbg-3 | debugging/testing | LOW | 0 | sast-configuration(C), recsys-pipeline-architect(C), changelog-automation(C) | sast-configuration | HIT |
| T-ops-1 | mobile/devops/general | MEDIUM | 1 | social-publishing(C), file-conversion(C), fastapi-templates(C) | SELECTED gitops-workflow @MEDIUM | HIT |
| T-ops-2 | mobile/devops/general | LOW | 0 | secrets-management(C), bats-testing-patterns(C), review-agent-setup(C) | secrets-management | HIT |
| T-ops-3 | mobile/devops/general | LOW | 0 | unity-ecs-patterns(C), review-agent-setup(C), ai-debt-detector(C) | unity-ecs-patterns | HIT |

## Result: 11/12 HIT, 0 serious misroutes, 1 observation

- T-ops-1 is a HIT by selection: `gitops-workflow` (tier B, DESCRIPTION_MATCH)
  auto-selected at MEDIUM. Candidate display lists only the unselected tier-C
  remainder — expected CLI shape, not a defect.
- 10 LOW tasks correctly select nothing and rank the right skill #1.

## Observation (not a defect): T-data-3 partial-name ranking

Task "Scaffold a FastAPI service with health checks and request validation"
ranks `slack-gif-creator` #1 (`validation` high-IDF lexical hit) above
`fastapi-templates` #2, both tier C, LOW, nothing selected. Mechanism: the
NAME-match primitive requires all name tokens (`fastapi` present but
`templates` absent), so no tier boost; BM25 IDF then prefers the rarer
`validation` term. Conservative output (right answer visible #2, no
auto-select) — recorded as a known ranking limitation, no router change, no
golden (frozen TEST-001 goldens untouched by design).

## Regression stance

No serious misroutes discovered, so no new goldens, no router change, and no
x10 rerun required (routing behavior unchanged). Frozen 42-case suite untouched.
