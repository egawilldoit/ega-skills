# SPEC-006 — Local MCP Runtime Contract

**Status:** FROZEN (V1 normative behavioral contract).
**Incorporates:** AMEND-02 (EGA-607: exact L1/L2 content returned by `get_content`),
AMEND-03 (EGA-608: current/locked version visibility for search),
AMEND-04 (EGA-609: full `ResolutionResult` + child types mapped by `resolve`),
AMEND-05 (EGA-610: project config/policy/lock enforcement basis),
AMEND-06 (EGA-611: shared project context, exact four-tool schemas, snake_case
convention, input validation, runtime output convention, result containers),
AMEND-07 (EGA-612: real source-observation timestamps replace ordinal-derived
`observed_at`; stored instant with `source_id` final ordering tie-break).
**Authority note:** This file is normative. `docs/specs/` is the V1 implementation authority;
Linear amendment tickets (EGA-605..EGA-612) are provenance/history only.
If implementation reveals a contradiction, amend this spec and its tests before changing behavior
(Linear: EGA-550 gate; EGA-605 parent gate).

Section numbering and titles are preserved from the frozen bundle.

---

## §5.1.1 Server skeleton

1. The MCP server uses `@modelcontextprotocol/server` v2 and `serveStdio`.
2. Transport is stdio ONLY. No HTTP transport, no resources/prompts, no write/admin
   tools exist in V1.
3. V1 exposes EXACTLY four tools: `resolve`, `search`, `inspect`, `get_content`
   (§5.1.5–§5.1.8). No extra runtime tool may be added without a reviewed spec
   amendment.

## §5.1.2 Protocol-safe logging

1. stdout is MCP PROTOCOL ONLY. No `console.log` (or equivalent) on startup or in any
   handler may write to stdout. Logging is centralized so future tools cannot
   accidentally contaminate stdout.
2. All logs and diagnostics go to stderr.
3. The process exits cleanly on normal disconnect.
4. Stdout-contamination tests are part of the frozen acceptance gate (release
   checklist, EGA-602).

## §5.1.3 Tool metadata and structured-output contracts

1. All four model-visible tool definitions target `<= 1000` `ega-o200k-v1` tokens
   TOTAL; each tool's main description is `<= 40` tokens. Measurement uses the
   TEST-002 estimator over the serialized definitions EXACTLY as registered at
   runtime (EGA-594 implementation-time measurement; amendment-ticket completion is
   not proof).
2. Every tool defines its input schema AND output schema, and every tool call returns
   `structuredContent` matching its output schema. The text fallback stays compact
   and MUST NOT duplicate large structured payloads in verbose prose.
3. Runtime errors use `isError` plus a structured `McpToolError` carrying the exact
   `E_*` code. Golden-harness `GOLDEN_*` diagnostics are NEVER runtime errors.
4. All external MCP field names use ONE convention: snake_case (§5.1.5–§5.1.8). The
   MCP adapter maps snake_case externals to the internal camelCase SPEC-004 request
   WITHOUT changing semantics.

## §5.1.4 Shared project context (AMEND-06)

1. ALL FOUR tools accept optional `project_path`. When omitted, use
   `fs.realpath(process.cwd())` (SPEC-005 §5.1.1). A symlinked cwd and its real path
   resolve identically.
2. All four calls therefore execute inside ONE effective project config/lock/policy
   context (SPEC-005 discovery + validation). There is NO unscoped/global MCP mode
   in V1; global management/inspection remains CLI-side.
3. A missing project path returns `E_PROJECT_NOT_FOUND`.
4. The same effective-project normalization helper serves all four tools. No tool can
   bypass policy by accepting an exact skill/version identifier: project deny/lock
   applies BEFORE registry/cache reads in every tool.
5. The runtime is read-only and offline: MCP may read registry/cache/project
   config/lock/fingerprint inputs ONLY. No writes, no shell, no skill-script
   execution, no network. Skill scripts CANNOT be invoked through the runtime.
6. If the local registry cannot be opened/read, surface `E_REGISTRY_UNAVAILABLE`
   through structured MCP error handling. NEVER fall back to network or a different
   registry.
7. The runtime maintains NO stateful skill activation and NO hidden session-wide
   selected-skill/token state. Every call is evaluated from explicit inputs plus
   local project/registry state.

## §5.1.5 `resolve` tool

Input (snake_case externals; adapter maps to the internal SPEC-004 `ResolveRequest`):

```json
{
  "task": "string",
  "project_path": "string?",
  "explicit_skills": ["string"]?,
  "max_skills": 3?,
  "max_tokens": 5000?
}
```

1. `resolve` delegates to the frozen SPEC-004 contract (§5.1.1 pipeline, §5.1.2
   validation ranges, §5.2 output types).
2. Output is the SPEC-004 `ResolutionResult` (including ALL frozen child schemas from
   AMEND-04: `ProjectFingerprint`, `ResolvedSkill`, `RejectedSkill`,
   `FingerprintEvidence`, `RoutingEvidence`, tiers, reason codes, warnings) mapped to
   snake_case externals.
3. `resolve` returns metadata/structured output ONLY — never L1/L2 instruction bodies.
4. Malformed external input maps to `E_MCP_INPUT_INVALID` at the MCP adapter (the
   internal/CLI `E_RESOLVE_REQUEST_INVALID` is never exposed raw over MCP).
5. No-match routing remains a normal LOW-confidence result, never an MCP error.

## §5.1.6 `search` tool

Input:

```json
{
  "query": "string",
  "project_path": "string?",
  "limit": 10?
}
```

1. `query`: non-empty after trim; max 16,384 Unicode code points.
2. `limit`: integer `1–20`; default 10; hard max 20.
3. Output contains ONLY project-visible L0 current/locked versions. Denied,
   not-in-lock, and historical/non-visible versions NEVER appear. No instruction
   body, no reference content, no BM25 score.
4. Exact V1 search output container:

```ts
interface McpSearchOutput {
  results: Array<{
    skill_id: string;
    version_hash: string;
    namespace: string;
    name: string;
    description: string;
    domains: string[];
    platforms: string[];
    frameworks: string[];
    triggers: string[];
    anti_triggers: string[];
    aliases: string[];
    l1_status: "AUTHORED" | "MISSING";
    l1_tokens: number | null;
    l2_tokens: number;
  }>;
}
```

5. Results preserve the deterministic registry/search order (SPEC-003 §5.1.5:
   relative BM25, then `skill_id`, then `version_hash`). FTS query escaping behavior
   is preserved end-to-end.
6. Malformed input → `E_MCP_INPUT_INVALID`.

## §5.1.7 `inspect` tool

Input:

```json
{
  "skill_id": "canonical-id",
  "project_path": "string?",
  "version_hash": "sha256:...?"
}
```

1. `skill_id` MUST be a canonical ID. Aliases and bare portable names are NOT
   accepted by `inspect`; use `search` for discovery.
2. Project policy is enforced even when the caller knows the ID/hash: denied or
   not-visible skills do NOT become inspectable.
3. Version selection: under an active lock, ONLY the exact locked version is
   inspectable; unlocked with omitted version resolves ONLY to
   `current_version_hash`; an explicitly requested historical version is allowed
   ONLY for a project-policy-visible skill. NO version fallback or fall-forward
   ever occurs.
4. Output includes exact skill/version identity, L0, canonical manifest/file list,
   token metadata, and source observations — and NEVER full L1/L2 instruction bodies.
5. Exact V1 inspect output container:

```ts
interface McpInspectOutput {
  skill_id: string;
  version_hash: string;
  trust_level: "OWNED" | "EXTERNAL" | "UNKNOWN";
  l0: McpSearchOutput["results"][number];
  token_metadata: {
    estimator_id: "ega-o200k-v1";
    l1_tokens: number | null;
    l2_tokens: number;
    l2_size_class: "NORMAL" | "LARGE" | "OVERSIZED";
  };
  manifest: CanonicalVersionManifestSnakeCase;  // exact AMEND-02 wire shape (SPEC-002 §5.1.15)
  sources: Array<{
    source_type: "local" | "git";
    local_path: string | null;
    repository: string | null;
    commit_sha: string | null;
    repository_path: string | null;
    observed_at: string;
  }>;
}
```

   `l0.skill_id` and `l0.version_hash` MUST equal the top-level values. Source
   observations are ordered deterministically by `source_type`, `local_path`,
   `repository`, `commit_sha`, `repository_path`, then `observed_at`, then
   `source_id` as the final tie-break, using null-before-non-null and UTF-16
   order for strings. `observed_at` is the stored real observation instant
   (SPEC-003 §5.1.15, AMEND-07) — never an ordinal-derived value; a stored
   null instant (rows written outside the importer/migration path) fails with
   `E_REGISTRY_UNAVAILABLE` rather than exposing a fabricated time.
6. Malformed input → `E_MCP_INPUT_INVALID`.

## §5.1.8 `get_content` tool

Input:

```json
{
  "skill_id": "canonical-id",
  "version_hash": "sha256:...",
  "level": "L1|L2",
  "max_tokens": 4000,
  "project_path": "string?"
}
```

0. All input fields except `project_path` are REQUIRED. `level` accepts ONLY `L1`
   or `L2`.

1. `get_content` enforces the effective project policy/lock BEFORE cache access:   - a denied/not-visible skill surfaces as `E_SKILL_NOT_FOUND` to the MCP client
     (no existence oracle for denied skills);
   - a project-visible skill requested at a version outside the active lock returns
     `E_VERSION_NOT_LOCKED`;
   - a missing exact local version returns `E_VERSION_NOT_FOUND` (never falls
     forward to current);
   - a missing requested level returns `E_CONTENT_LEVEL_MISSING`;
   - content over the per-call budget returns `E_CONTENT_TOKEN_BUDGET`.
2. `max_tokens`: integer `1–1,000,000`. Each call has its OWN budget; no aggregate
   or session quota exists — multiple explicit calls share no hidden quota.
3. Content is the EXACT canonical text frozen by AMEND-02 (L1 = full canonical
   `SKILL.core.md`; L2 = full canonical `SKILL.md` including frontmatter), counted
   with `ega-o200k-v1`. Cache bytes are hash-verified before return; a corrupt blob
   fails with `E_CACHE_HASH_MISMATCH` before any content is exposed.
4. NEVER truncates: over-budget or missing-level conditions are errors, not partial
   content.
5. Output:

```json
{
  "skill_id": "...",
  "version_hash": "...",
  "level": "L1|L2",
  "token_count": 123,
  "content": "exact canonical text"
}
```

6. Malformed input → `E_MCP_INPUT_INVALID`.

## §5.1.9 Server lifecycle

§5.1.1 (serveStdio) + §5.1.2 (stdio hygiene, clean disconnect) define the frozen
lifecycle. No activation/session state exists (§5.1.4 rule 7).

## §5.1.10 Client acceptance (Codex + OpenCode/T3)

1. Each client MUST discover and successfully call all four tools; selected content
   MUST come from the exact EGA version; EGA-managed test skills MUST NOT be
   duplicated as native client-installed skills during routing acceptance.
2. Runtime MUST work with network disabled after import (offline smoke).
3. No registry/project mutation may occur through either client path.
4. Client configuration + repeatable smoke procedures are recorded in repo docs at
   implementation time (EGA-595/EGA-596/EGA-597; operator docs EGA-604).

## §5.2 Frozen MCP runtime error inventory

`E_REGISTRY_UNAVAILABLE`, `E_PROJECT_NOT_FOUND`, `E_PROJECT_CONFIG_INVALID`,
`E_PROJECT_LOCK_INVALID`, `E_SKILL_NOT_FOUND`, `E_VERSION_NOT_FOUND`,
`E_VERSION_NOT_LOCKED`, `E_CONTENT_LEVEL_MISSING`, `E_CONTENT_TOKEN_BUDGET`,
`E_CACHE_HASH_MISMATCH`, `E_MCP_INPUT_INVALID`.
(Internal `E_RESOLVE_REQUEST_INVALID` is mapped to `E_MCP_INPUT_INVALID` at the
adapter and never exposed raw. Policy/lock/validity codes owned by SPEC-004/005
surface through the same structured `McpToolError` envelope.)

## §5.3 Read-only and offline boundaries (normative restatement)

MCP reads registry/cache/project config/lock/fingerprint inputs only. No import,
update, lock mutation, approval, shell, skill execution, or network exists through
MCP. No-match routing is a LOW result, not an error. Remote transport, resources/
prompts, and stateful activation are explicitly non-goals.
