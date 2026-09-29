# Security

- All 114 negative/forbidden routing cases pass: no forbidden or high-risk skill becomes a leading candidate. `STRICT_CANDIDATE_FAILURE = 0`.
- High-action skills re-audited in the final routing state: certify-database-rollout, certify-mcp-production, certify-pr-head, certify-production-target, certify-release, deliver-software, fix-ci, integrate-pr-stack, loop-on-ci, new-branch-and-pr, review-and-ship, verify-ui, verify-cli.
- Routing intent is not permission; no generic request auto-authorizes mutation.
- Hosted MCP surface is read-only; artifact verified read-only (mutation = 0 under exercise).

P0 security = 0. P1 security = 0.
