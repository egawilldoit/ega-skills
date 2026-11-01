# Agent guidance

## Repository and authority

- `packages/` contains domain and MCP runtime packages. `apps/web` is a Node
  BFF and SPA. SQL-backed isolation and RLS tests use real PostgreSQL.
- The source skill catalog is a separate repository, `egawilldoit/skills`.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) and the frozen behavior contracts in
  [docs/specs/](docs/specs/). The actual CI is [.github/workflows/ci.yml](.github/workflows/ci.yml).
- [CI ownership and maintenance](docs/operations/ci-optimization.md) explains
  selection, coverage, measurements, and rollback. Release procedures remain
  authoritative in the
  [automatic release runbook](docs/operations/AUTOMATIC-RELEASE.md),
  [release runbook](docs/operations/RELEASE-2.0-RUNBOOK.md),
  [web promotion runbook](docs/operations/web-console-production-promotion.md),
  and [MCP Vercel guide](packages/mcp/VERCEL.md).

## CI profiles and ownership

- Modified `README.md` alone selects docs. Only README and the four allowlisted
  display components (StatCard, Icon, Disclosure, format) select web. Other or
  uncertain changes select full; do not widen the allowlist without proof.
- Full mode runs Linux foundation, web, PostgreSQL isolation, RLS and `ci-gate`.
  Release PRs to `release/2.0`, release pushes and manual full runs also run
  Linux and Windows foundation and web. Preserve these release-required names:
  `foundation (ubuntu-latest)`, `foundation (windows-2022)`, and
  `contract-f rls (ubuntu-latest)`. Changes require an authorized ruleset migration.
- `scripts/ci/test-ownership.json` is the committed Node discovery inventory;
  `scripts/ci/ownership.mjs` fails closed on drift. Update the owner when adding,
  removing or moving a discovered test. The source-manager tests also run with
  a pinned fixture; planner output and Python candidate validation remain separate.
  Explicit `.rls.mjs`, React/Vitest, fixture-dependent and Python checks have
  separate execution contracts; scoped Node tests do not replace them.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test:ci
node --test tests/ci/classify-changes.test.mjs tests/ci/test-ownership.test.mjs
node scripts/release/run-tests-bounded.mjs --ci-scope=core
node scripts/release/run-tests-bounded.mjs --ci-scope=web
pnpm specs:check
git diff --check
```

`pnpm test:ci` retains full default Node test discovery. Scoped commands do not
replace real PostgreSQL, source fixture validation or React tests.

## CI, delivery and changes

GitHub Actions tests code and builds artifacts. A Vercel preview is not production
acceptance; ignored MCP/auth preview deployments need no action. Do not change
secrets, manually promote, or auto-merge without separate authorization.

### Production release

The only supported production release path is the
[automatic release runbook](docs/operations/AUTOMATIC-RELEASE.md). In short:

- Reviewed code and the skill catalog ship together from the same `main` commit.
- Merging `main` triggers a native Vercel Git production build.
- The required `ci-gate` check must succeed before Vercel assigns the production
  domain automatically.
- `.github/workflows/verify-release.yml` verifies the expected release and
  authenticated skill retrieval after promotion.
- Recovery restores the previous working deployment when appropriate and must
  not overwrite a newer release.
- Never treat a `READY` build as live until the canonical endpoint is verified.
- Do not restore the retired custom publisher, approval envelopes, baseline
  cutover, or manual promotion process. Catalog counts and digests change with
  releases; never hard-code a current count or digest as a permanent requirement.

Useful checks:

```sh
gh pr checks <pr> --repo egawilldoit/ega-skills
gh run list --repo egawilldoit/ega-skills --branch main --limit 5
vercel ls ega-skills-mcp --scope <team>
vercel inspect <deployment-url> --scope <team>
curl -fsS https://ega-skills-mcp.vercel.app/readyz
gh run list --repo egawilldoit/ega-skills --workflow verify-release.yml --limit 5
```

Destructive recovery on the real canonical service still requires a
disposable-project demonstration; focused tests do not substitute for live
platform evidence.

For CI changes, map affected tests and required contexts, make the smallest
change, verify default and fixture behavior, measure wall time and summed runner
minutes, run real CI on the final candidate, document rollback and request
independent review. YAML parsing or skipped jobs do not establish a pass.

On the shared VM, follow its agent instructions and heavy wrapper. Never bypass a
recovery marker; GitHub Actions can supply hosted evidence while an operator
recovers the VM separately. Keep credentials out of logs, avoid production writes
in PR workflows, use least-privilege checkout, and do not introduce paid CI by
default.
