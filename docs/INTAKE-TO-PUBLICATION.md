# Intake to publication

This runbook covers the manual local or Git intake workflow. It creates a
reviewable plan, stages and applies an exact source snapshot, records an
explicit approval, previews a release, and exports the verified candidate.
Export does not deploy or publish production traffic.

## Commands

Build the workspace first:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Create a plan without changing the source or Hub:

```bash
node packages/cli/bin/ega-skills.mjs hub intake plan ./source \
  --namespace intake \
  --source-id upstream-main \
  --commit <40-hex-commit> \
  --root skills/engineering/example \
  --provenance-file LICENSE \
  --hub ./hub \
  --output ./plan.json
```

For a local folder, omit `--commit`. For Git acquisition, provide the exact
commit and keep the source ref only as provenance.

Stage the exact plan. Staging copies the selected source snapshot into the
Hub-owned staging area; it does not adopt it:

```bash
node packages/cli/bin/ega-skills.mjs hub intake stage \
  --plan ./plan.json ./hub
```

The plan records the candidate Skill IDs and version hashes, selected-tree and
snapshot digests, and provenance files. Keep those identities with the review
record. Applying before approval is rejected and writes no owned skill.

Run deterministic quality diagnostics against the staged or owned skill tree:

```bash
node packages/cli/bin/ega-skills.mjs intake quality ./hub/owned \
  --namespace intake \
  --output ./quality.json
```

Review the exact candidate version before applying it, then preflight:

```bash
node packages/cli/bin/ega-skills.mjs hub intake review \
  --candidate ./plan.json \
  --decision approve \
  --expected-revision 0 \
  ./hub

node packages/cli/bin/ega-skills.mjs hub intake apply \
  --plan ./plan.json ./hub

node packages/cli/bin/ega-skills.mjs hub release preflight ./hub
```

Preview against a previously verified release and export the exact candidate
to a new destination:

```bash
node packages/cli/bin/ega-skills.mjs hub release preview \
  --hub ./hub \
  --against ./previous-release/hub-release.json \
  --output-dir ./candidate

node packages/cli/bin/ega-skills.mjs hub release export \
  --candidate ./candidate/candidate.json \
  --out ./artifact

node scripts/hosted/validate-artifact.mjs ./artifact
```

The preview and export commands reject blocked approvals, stale identities,
corrupt artifacts, and destination overlap. Export is an immutable artifact
build step; it does not publish production traffic. Keep the candidate,
release, approval, provenance, and transport receipts together for the
separate deployment system.

After export, a local MCP smoke test can use the exported artifact as its
read-only registry:

```bash
EGA_SKILLS_HOME=./artifact node packages/mcp/bin/ega-mcp.mjs
```

Use the four existing MCP tools over stdio (search, resolve, inspect, and
get_content) with the exact Skill ID and version hash from
artifact/hub-release.json. The server must be driven through its normal
initialize/notification/tool-call protocol. Control-plane files such as
hub-release.json are not skill content and are not fetchable through
get_content.

## Evidence boundary

The repository tests prove deterministic local CLI behavior and local hosted
serving. They do not prove a remote upstream, OAuth, deployment, or client
workflow. Production publication requires a separately authorized deployment
step. ZIP input, alternate clients, large-scale ingestion, and an operator UI
are outside this workflow.
