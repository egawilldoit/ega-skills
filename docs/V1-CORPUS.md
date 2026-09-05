# EGA Skills V1 real corpus basis (EGA-598)

SPEC-003 (import pipeline) acceptance: 70 real third-party portable skills
evaluated through the REAL CLI importer into clean registries. No third-party
source was modified; incompatible skills are documented, not forced.

## Upstream sources

| Repo | Revision (shallow, 2026-09-05) | License | Skills evaluated |
| --- | --- | --- | --- |
| https://github.com/wshobson/agents | origin/HEAD at clone time (depth 1) | MIT (LICENSE, Copyright (c) 2024 Seth Hobson) | 51 (one per plugin category, alphabetical first) |
| https://github.com/anthropics/skills | origin/HEAD at clone time (depth 1) | No LICENSE file in repo; THIRD_PARTY_NOTICES.md present — upstream terms apply; used here for compatibility evaluation only, not redistributed | 19 (`skills/*`, template excluded) |

Upstream checkouts live OUTSIDE this repo (`/tmp`, disposable). Only this
record is committed. Corpus staging copied each skill directory VERBATIM
(no renames: the importer correctly requires name == directory).

## Import outcome (namespace `corpus`, clean registry)

- evaluated: 70 | imported: 66 | failed: 4 | unchanged: 0
- trust UNKNOWN 66/66 (fresh imports, no trust grants in this procedure)
- L1 MISSING 66/66 (no upstream skill ships SKILL.core.md; L1 is EGA-authored)
- L2 size class: NORMAL 62, LARGE 4
- token rows: 66 (ega-o200k-v1 cached per version)

## Determinism

The same 70-skill staging imported into TWO independent clean homes
produced byte-identical version-hash sets (66/66 equal). Import is a pure
function of source bytes + namespace.

## Per-skill record

| skill | group | L1 | L2 tokens | size | import | notes |
| --- | --- | --- | --- | --- | --- | --- |
| academy-guide | anthropics | MISSING | 1808 | NORMAL | OK `831a85a01a34…` | — |
| ai-debt-detector | wshobson:skill-forge-essentials | MISSING | 734 | NORMAL | OK `2042a159db1d…` | — |
| algorithmic-art | anthropics | MISSING | 4151 | NORMAL | OK `7f9fc1f4ddae…` | — |
| angular-migration | wshobson:framework-migration | MISSING | 1670 | NORMAL | OK `0e88d705ee5b…` | — |
| architecture-patterns | wshobson:backend-development | MISSING | 1630 | NORMAL | OK `dd9fb77cfbcf…` | — |
| avoid-ai-writing | wshobson:avoid-ai-writing | MISSING | 1668 | NORMAL | OK `e5263d3d94eb…` | — |
| backtesting-frameworks | wshobson:quantitative-trading | MISSING | 622 | NORMAL | OK `1cd25ee7cbcc…` | — |
| bats-testing-patterns | wshobson:shell-scripting | MISSING | 1322 | NORMAL | OK `2118ae4a6e66…` | — |
| before-you-build | wshobson:before-you-build | MISSING | 569 | NORMAL | OK `1bd3f7a653cd…` | — |
| billing-automation | wshobson:payment-processing | MISSING | 389 | NORMAL | OK `795e69d7666c…` | — |
| binary-analysis-patterns | wshobson:reverse-engineering | MISSING | 2267 | NORMAL | OK `9e8fcac6cf4e…` | — |
| block-no-verify-hook | wshobson:block-no-verify | MISSING | 1707 | NORMAL | OK `e1b5366c4908…` | — |
| brand-guidelines | anthropics | MISSING | 518 | NORMAL | OK `32f227689b0d…` | — |
| brand-landingpage | wshobson:brand-landingpage | MISSING | 3434 | NORMAL | OK `0b447172d927…` | — |
| canvas-design | anthropics | MISSING | 2353 | NORMAL | OK `50e3ad1e8d35…` | — |
| changelog-automation | wshobson:documentation-generation | MISSING | 743 | NORMAL | OK `2017cb25fe92…` | — |
| claude-api | anthropics | — | — | — | FAIL | description exceeds 1024 code points (SPEC-001) |
| data-storytelling | wshobson:business-analytics | MISSING | 451 | NORMAL | OK `9bae7a0ab14e…` | — |
| dbt-transformation-patterns | wshobson:data-engineering | MISSING | 806 | NORMAL | OK `efcec27c87bd…` | — |
| defi-protocol-templates | wshobson:blockchain-web3 | MISSING | 1743 | NORMAL | OK `18227579d3a2…` | — |
| discernment-nudge | anthropics | MISSING | 2422 | NORMAL | OK `3eedff3479e5…` | — |
| doc-coauthoring | anthropics | MISSING | 3254 | NORMAL | OK `e286e5ce6e8e…` | — |
| docx | anthropics | MISSING | 1762 | NORMAL | OK `52bbee08b66c…` | — |
| dotnet-backend-patterns | wshobson:dotnet-contribution | MISSING | 5669 | LARGE | OK `c03fea06271c…` | — |
| evaluation-methodology | wshobson:plugin-eval | MISSING | 5444 | LARGE | OK `734731b0914c…` | — |
| fastapi-templates | wshobson:api-scaffolding | MISSING | 839 | NORMAL | OK `f4321cb79f64…` | — |
| file-conversion | wshobson:file-conversion | MISSING | 747 | NORMAL | OK `e97a37eef066…` | — |
| frontend-design | anthropics | MISSING | 1892 | NORMAL | OK `d08f2d21c94d…` | — |
| gdpr-data-handling | wshobson:hr-legal-compliance | MISSING | 586 | NORMAL | OK `12b5a61e9dcf…` | — |
| gitops-workflow | wshobson:kubernetes-operations | MISSING | 1579 | NORMAL | OK `3612b189ec50…` | — |
| grafana-dashboards | wshobson:observability-monitoring | MISSING | 2123 | NORMAL | OK `4ee234054229…` | — |
| grounded-vault | wshobson:documentation-standards | MISSING | 1278 | NORMAL | OK `cba3fbad9ee1…` | — |
| hermes-tweet | wshobson:hermes-tweet | MISSING | 1228 | NORMAL | OK `a20add6d159d…` | — |
| internal-comms | anthropics | MISSING | 321 | NORMAL | OK `42fcc47302de…` | — |
| mcp-builder | anthropics | MISSING | 1938 | NORMAL | OK `835cbd46c9ca…` | — |
| modern-javascript-patterns | wshobson:javascript-typescript | MISSING | 461 | NORMAL | OK `67d9284e8bef…` | — |
| multi-cloud-architecture | wshobson:cloud-infrastructure | MISSING | 1263 | NORMAL | OK `a2e4d62ad6dc…` | — |
| nx-workspace-patterns | wshobson:developer-essentials | MISSING | 495 | NORMAL | OK `818acf58e5ae…` | — |
| parallel-debugging | wshobson:agent-teams | — | — | — | FAIL | unsupported frontmatter field version: 1.0.2 (SPEC-001) |
| pdf | anthropics | MISSING | 2082 | NORMAL | OK `62ec85f10a70…` | — |
| postgresql-table-design | wshobson:database-design | MISSING | 1983 | NORMAL | OK `206bbb210218…` | — |
| postmortem-writing | wshobson:incident-response | MISSING | 1518 | NORMAL | OK `ab63a2954a47…` | — |
| pptx | anthropics | MISSING | 5320 | LARGE | OK `b99b7cae20ac…` | — |
| pptx-quality-gates | wshobson:pptx-deck-creation | MISSING | 337 | NORMAL | OK `77e8a0b1d40b…` | — |
| prompt-engineering-patterns | wshobson:llm-application-dev | MISSING | 1085 | NORMAL | OK `5af4840a6c90…` | — |
| protect-mcp-setup | wshobson:protect-mcp | MISSING | 1663 | NORMAL | OK `1bbc4438139c…` | — |
| python-resilience | wshobson:python-development | MISSING | 1361 | NORMAL | OK `7123072a76f3…` | — |
| quantized-export | wshobson:llm-finetuning | MISSING | 1971 | NORMAL | OK `3281dee38a22…` | — |
| react-native-architecture | wshobson:frontend-mobile-development | MISSING | 770 | NORMAL | OK `c40bb744dfdd…` | — |
| react-native-design | wshobson:ui-design | MISSING | 971 | NORMAL | OK `31f83ba72397…` | — |
| recsys-pipeline-architect | wshobson:machine-learning-ops | MISSING | 1849 | NORMAL | OK `34d00d614c07…` | — |
| review-agent-setup | wshobson:review-agent-governance | MISSING | 1391 | NORMAL | OK `3d9323ff7ac9…` | — |
| rust-async-patterns | wshobson:systems-programming | MISSING | 623 | NORMAL | OK `ce8f919333f9…` | — |
| sast-configuration | wshobson:security-scanning | MISSING | 1221 | NORMAL | OK `05db2065dce5…` | — |
| scan | wshobson:ship-mate | MISSING | 2040 | NORMAL | OK `0f3bbfca8453…` | — |
| secrets-management | wshobson:cicd-automation | MISSING | 1838 | NORMAL | OK `d4ce3d33024d…` | — |
| signed-audit-trails-recipe | wshobson:signed-audit-trails | MISSING | 3034 | NORMAL | OK `dea89e5bfb56…` | — |
| skill-creator | anthropics | MISSING | 7241 | LARGE | OK `c5f2f9cdf3a0…` | — |
| slack-gif-creator | anthropics | MISSING | 1983 | NORMAL | OK `332bc0648a43…` | — |
| social-publishing | wshobson:social-publishing | MISSING | 832 | NORMAL | OK `a231ee63b9aa…` | — |
| spark-environment-setup | wshobson:dgx-spark-ops | MISSING | 2086 | NORMAL | OK `84f9e37aad8e…` | — |
| startup-metrics-framework | wshobson:startup-business-analyst | — | — | — | FAIL | unsupported frontmatter field version: 1.0.0 (SPEC-001) |
| superself | wshobson:superself | MISSING | 1299 | NORMAL | OK `50a5703176bd…` | — |
| theme-factory | anthropics | MISSING | 659 | NORMAL | OK `607c93411b4a…` | — |
| unity-ecs-patterns | wshobson:game-development | MISSING | 452 | NORMAL | OK `7234c7aa0e92…` | — |
| wcag-audit-patterns | wshobson:accessibility-compliance | MISSING | 535 | NORMAL | OK `f9984acf9450…` | — |
| web-artifacts-builder | anthropics | MISSING | 699 | NORMAL | OK `47ab46f446c0…` | — |
| webapp-testing | anthropics | MISSING | 884 | NORMAL | OK `ab2d7d3d3458…` | — |
| workflow-patterns | wshobson:conductor | — | — | — | FAIL | unsupported frontmatter field version: 1.0.0 (SPEC-001) |
| xlsx | anthropics | MISSING | 2137 | NORMAL | OK `f0e4298d9618…` | — |

## Incompatible skills (source NOT modified)

1. `claude-api` (wshobson) — description exceeds the SPEC-001 1024-code-point
   cap. Correct rejection; corpus keeps the upstream text as-is.
2. `parallel-debugging` (wshobson) — frontmatter carries `version: 1.0.2`,
   outside the portable schema. Correct rejection.
3. `startup-metrics-framework` (wshobson) — frontmatter carries
   `version: 1.0.0`. Correct rejection.
4. `workflow-patterns` (wshobson) — frontmatter carries `version: 1.0.0`.
   Correct rejection.

## Reproduce

```sh
node packages/cli/bin/ega-skills.mjs import <70-skill-staging> --namespace corpus
# expect: { imported: 66, unchanged: 0, failed: 4 }
```

The staging list (group, name, upstream path) used for this record is kept
with the EGA-598 Linear evidence; any 70-skill subset with the same bytes
reproduces the same version hashes per the determinism statement above.
