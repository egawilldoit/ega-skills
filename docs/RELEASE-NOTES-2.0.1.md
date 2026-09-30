# EGA Skills 2.0.1

Patch release. No new features, no contract, schema, protocol, artifact-format
or database-migration version changes.

This release hardens the runtime and the release process on top of
`v2.0.0` and the `catalog-2026-09-29.1` catalog.

---

## MCP release/context input contract (#124)

`inspect` and `get_content` published `release_digest` as **optional**, but the
hosted runtime requires `release_digest` **or** an authorized `context_id`. A
fully schema-valid call therefore failed with `E_RELEASE_MISMATCH` — a
misleading error, because the client had obeyed the published contract.
Reproduced independently by Codex 0.158.0, OpenCode 1.18.33 and a direct MCP
probe.

`toolSchema` gains an optional `selector`: alternative groups, each a
conjunction, of which at least one must be satisfied. The rule is now

- **published** as JSON Schema `anyOf`, and
- **enforced** during input validation,

so a missing selector is an argument-validation failure and never degrades into
a downstream release-mismatch error. `release_digest` is deliberately not
promoted into `required`, because `context_id` is a valid alternative.

**Release pinning is not weakened.** Both selectors supplied and disagreeing
still fails closed with the existing `E_RELEASE_MISMATCH`; an unknown digest
still fails closed; an unauthorized context still fails closed; and no content
is served from either release on disagreement. The local stdio server
deliberately does not gain the rule — it has no release digest to pin, which
also keeps the frozen stdio metadata budget unchanged.

A schema-guided client now produces a valid call on its first attempt.

## Provenance path sanitization (#123)

The exported registry stored `skill_sources.local_path` as an **absolute
build-host path for all 114 skills**, and the hosted `inspect` tool served it
on every authenticated call, in both the structured output and the text-only
fallback. That disclosed the build machine, the operator account, the build
worktree name and the private hub directory structure.

Fixed at the provenance layer rather than by masking responses:

- importers accept a stable logical location, and the Hub builder supplies a
  deterministic one derived from real data — never a fabricated Git path;
- a host-absolute source path is now **refused** outright.

Real provenance is preserved and unchanged: source repository,
`repository_path`, source commit, resolved commit, tree/snapshot digest and
skill version hash. Only the host-local filesystem path — which is not source
identity — is replaced. The MCP response shape is preserved, so this is not a
breaking change.

Takes effect in a successor catalog; `catalog-2026-09-29.1` is not modified.

## Deterministic E2E wait (#122)

The E2E-01 barrier wait was a fixed-iteration poll: 200 attempts of a 10 ms
sleep, i.e. an unmeasured ~2000 ms ceiling. The barrier child was never broken —
it simply takes longer than that on a loaded host, and startup dominates. Seven
of eight measured runs exceeded 2000 ms while CI stayed green.

Replaced with a monotonic deadline of 30 000 ms, matching the existing
deadline-based waits elsewhere in the suite, with timeout diagnostics that
report a path **shape** rather than a host path, plus child pid, exit code and
a redacted stderr tail. Path classification is derived from the string shape, not
from the host platform, so the same test produces the same description on every
runner.

## Test-infrastructure fix

The bounded runner marked a surviving descendant as test-related only for
`*.test.mjs`; the harness's own `*.fixture.mjs` files were not matched, so the
lifecycle-termination diagnostic lost its marker whenever the fixture runner was
the only process left at the bound. A test diagnostic only — no runtime
behaviour changes.

## Committed-artifact validation in CI

`node scripts/hosted/validate-artifact.mjs packages/mcp/artifact` now runs in
the **existing** foundation matrix after build, so it validates the committed
deployment artifact on Ubuntu and Windows on every CI run. No new required
check name, and no existing required check was weakened.

---

## Not in this release

- **No** Supabase credential rotation. The exposed credential is a legacy
  `service_role` JWT; revoking it requires rotating the project's HS256 JWT
  signing secret, which also signs the `anon` key. Supabase privileged keys are
  configured in 5 Vercel projects and whether they share a Supabase project
  could not be established, so global rotation would carry an unquantified
  blast radius. #121 stays open with the exact state recorded, and the owner
  runbook is in `docs/operations/SUPABASE-KEY-MIGRATION.md`.
- **No** change to `catalog-2026-09-29.1`, its tag, its digest, or the source
  pin `f48e0ed`.
