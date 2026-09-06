# Contract A — Hub & Sources (FROZEN v1)

**Status:** FROZEN
**Contract version:** 1
**Milestone gate:** must freeze before any 1.1 implementation (§7 of the Final Post-V1 Release Specification).
**Linear:** EGA-620
**Normative inputs:** Final Post-V1 spec §2 (canonical envelope), §3.2–§3.12, §3.20; V1 SPEC-002 (traversal, JCS/SHA-256).

This contract freezes the Hub source plane only. It does NOT authorize the
builder (Contract C), UpdatePlan apply (Contract B), hosted runtime
(Contract D), remote projects (Contract E), or multi-user (Contract F).

## §1 Authority

1. `hub.yaml` answers: which content belongs to this Hub.
2. `sources.yaml` answers: which upstreams are tracked and which roots are selected.
3. `sources.lock.yaml` is the SOLE authority for adopted external state.
   No per-source `SOURCE.yaml` may become a second configuration source (§3.8
   of the post-V1 spec). A human-readable projection is allowed only if
   generated from the lock and never parsed as input.

## §2 Canonical layout

```text
skillshub/
├── hub.yaml
├── sources.yaml
├── sources.lock.yaml
├── owned/
│   └── ega/
│       └── <skill-name>/
│           ├── SKILL.md
│           └── ega.yaml
└── external/
    ├── mattpocock/
    │   └── repo/
    │       ├── LICENSE
    │       └── skills/
    │           └── ...
    └── cursor-pstack/
        └── repo/
            └── pstack/
                ├── LICENSE
                └── skills/
                    └── ...
```

External content preserves paths relative to the upstream repository.
`skillshub/external/**` is generated/adopted state: it MUST match
`sources.lock.yaml`; unexplained manual changes fail validation.

## §3 hub.yaml (schema_version 1)

```yaml
schema_version: 1
hub:
  id: personal
owned:
  - path: owned/ega
    namespace: ega
external:
  - source: mattpocock
  - source: cursor-pstack
```

Rules:

- `schema_version` MUST be `1`. Unknown top-level or entry fields are REJECTED.
- `hub.id` is a non-empty string naming this Hub.
- `owned` is a list of `{path, namespace}`. `path` MUST be a repository-relative
  posix path (no backslashes, no leading `/`, no `..` segments). `namespace`
  MUST match `^[a-z0-9][a-z0-9-]*$`.
- `external` is a list of `{source}` referencing keys of `sources.yaml`.
  Every configured source MUST be listed here (no orphan sources); every listed
  source MUST exist in `sources.yaml`.
- `hub.yaml` carries no repository URLs or revisions. Those live in
  `sources.yaml` (intent) and `sources.lock.yaml` (adopted state).

## §4 sources.yaml (schema_version 1)

```yaml
schema_version: 1
sources:
  mattpocock:
    type: git
    repository: https://github.com/mattpocock/skills
    ref: main
    namespace: mattpocock
    selection:
      roots:
        - skills/engineering/code-review
        - skills/engineering/tdd
    provenance_files:
      - LICENSE
```

Rules:

- `type` MUST be `"git"`. Unknown source fields are REJECTED.
- `repository` MUST be one of:
  - an `https://` URL (standard tracked upstream), or
  - a `file://` URL or absolute local path (posix `/...`, Windows drive
    `C:/...` / `C:\...`, or UNC `//...`) for mirrors and offline fixtures.
  Relative paths and all other schemes are REJECTED.
  (AMEND-01: `https://`-only made offline checks and local mirrors
  impossible; scheme treatment downstream — quarantine, digests, plans — is
  identical regardless of scheme.)
  `ref` is the tracked mutable ref
  (for example `main`); it is intent, never identity.
- `namespace` MUST match `^[a-z0-9][a-z0-9-]*$`.
- `selection.roots` is a NON-EMPTY list of repository-relative posix paths
  (same safety rule as §3). The list MUST be sorted and unique in the file;
  validators MUST normalize before hashing but MUST reject unsorted files so
  Git diffs stay canonical.
- `provenance_files` is a list (possibly empty only if the upstream genuinely
  ships no license/notice file, which MUST then be recorded as a reviewed
  exception) of repository-relative posix paths covered by the vendored
  snapshot digest (§6).
- EXPLICIT SELECTION ONLY: only `SKILL.md` packages at or under a selected
  root enter the Hub. A newly added upstream skill outside the selected roots
  is REPORTED by check tooling but MUST NOT enter the Hub until its root is
  explicitly added to `selection.roots` and adopted through Contract B.

### §4.1 Normalized source config preimage

`source_config_digest` binds the exact tracked intent:

```json
{
  "namespace": "<ns>",
  "provenance_files": ["<sorted unique>"],
  "repository": "<https url>",
  "requested_ref": "<ref>",
  "selection_roots": ["<sorted unique>"],
  "type": "git"
}
```

Digest = `SHA-256(RFC8785-JCS(preimage))`, rendered `sha256:<64 lowercase hex>`
using the proven V1 primitive (`canonicalize@4.0.0` via
`packages/hashing/dist/identities.js`). Missing and `null` are different;
`null` is never valid in source configuration.

Frozen vectors (validator-recomputed):

```text
mattpocock    sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547
cursor-pstack sha256:4854f1cae5082f0319da306e2678a6f525a3dba369a3e44245455d03f0490067
```

(preimage inputs are `scripts/contracts/examples/contract-a/sources.yaml`.)

## §5 sources.lock.yaml (schema_version 1)

Each source record is SELF-CONTAINED: it repeats every input needed to
reproduce the adoption, so a future `sources.yaml` edit cannot reinterpret old
adopted state.

```yaml
schema_version: 1
sources:
  mattpocock:
    source_config_digest: sha256:...
    repository: https://github.com/mattpocock/skills
    requested_ref: main
    namespace: mattpocock
    selection:
      roots:
        - skills/engineering/code-review
    provenance_files:
      - LICENSE
    resolved_commit: 98abc420...
    selected_skill_tree_digest: sha256:...
    vendored_snapshot_digest: sha256:...
    extraction_contract: 1
```

Rules:

- Lock sources MUST equal configured sources exactly (no orphans, no gaps).
- `repository` / `requested_ref` / `namespace` / `selection.roots` /
  `provenance_files` MUST equal the `sources.yaml` entry; `source_config_digest`
  MUST recompute per §4.1.
- `resolved_commit` MUST be 40 lowercase hex (full Git commit SHA).
- `selected_skill_tree_digest`, `vendored_snapshot_digest` MUST match
  `sha256:<64hex>`.
- `extraction_contract` MUST be `1`.
- Unknown record fields are REJECTED. Explicit `null` anywhere is REJECTED.
- The lock carries no timestamps, no machine paths, no credentials.

## §6 Tree digests

Both digests are computed over a sorted manifest of vendored RELATIVE posix
paths (never absolute paths):

```json
[
  {"path": "<relative posix>", "kind": "file", "blob_sha256": "sha256:<hex of raw file bytes>"}
]
```

sorted by `path` byte-wise, JCS-hashed with SHA-256 as in §4.1.

- `selected_skill_tree_digest` covers exactly the files under the selected
  roots that the extraction allow-list admits (skill files + their in-skill
  companions; see §8).
- `vendored_snapshot_digest` covers the selected tree PLUS the declared
  `provenance_files` (licenses/notices). This proves redistribution provenance,
  not just skill integrity.
- Digests are over RAW vendored bytes. EGA canonical `SkillVersion` identity
  (SPEC-002 canonicalization) is SEPARATE: a raw change that canonicalizes away
  (for example line-ending-only) yields `RAW_CHANGED` + `CANONICAL_UNCHANGED`,
  and reports MUST distinguish the two (Contract B consumes this distinction).

## §7 Owned skills

- Owned skills live under `skillshub/owned/` (normally `owned/ega/`), authored
  and reviewed through the normal Git workflow. No updater touches them.
- Each owned skill MUST satisfy the V1 `validate` surface (frontmatter,
  name == directory, UTF-8, `ega.yaml` routing normalization,
  `SKILL.core.md` budget rules, path safety, canonical package structure).
- If an external skill needs EGA-specific modification, create an OWNED
  DERIVATIVE under explicit ownership/provenance. Overlays are DEFERRED; no
  overlay semantics exist in 1.1.

## §8 Extraction allow-list and security (extraction_contract 1)

Quarantine fetch MUST extract ONLY declared `selection.roots` + declared
`provenance_files`. The following are FORBIDDEN unless a future contract
explicitly versions them:

```text
Git hooks                       forbidden (never execute, never vendor)
install-script execution        forbidden (never run on fetch, build, or import)
skill-script execution          forbidden (catalogued only, per V1)
submodule recursion             forbidden
path traversal                  forbidden (../, absolute, drive-rooted, UNC)
symlink escape                  forbidden (symlinks MUST NOT resolve outside the admitted tree)
junction escape                 forbidden (Windows)
device/special files            forbidden (fifo, socket, device, door, portal)
unbounded extraction            forbidden (byte + file-count caps; oversized fetch fails closed)
implicit Git LFS fetch          forbidden
archive bombs / resource exhaustion  forbidden (caps + satiation checks)
```

Validators MUST test Linux AND Windows path semantics (separators, drive
roots, casing, UNC where relevant, open-file rename behavior at apply time
under Contract B). Upstream scripts are data, never executed.

## §9 Errors (fail-closed)

| Code | Meaning |
| ---- | ------- |
| `E_HUB_SCHEMA` | `hub.yaml` unknown field / bad type / orphan or missing source link |
| `E_SOURCE_SCHEMA` | `sources.yaml` unknown field / bad URL / bad namespace / empty roots |
| `E_SOURCE_SELECTION` | unsorted/duplicate roots, unsafe path, empty selection |
| `E_LOCK_MISMATCH` | lock sources ≠ configured sources, or repeated intent ≠ `sources.yaml` |
| `E_LOCK_DIGEST` | `source_config_digest` recomputation mismatch |
| `E_LOCK_COMMIT` | `resolved_commit` not 40 lowercase hex |
| `E_TREE_DIGEST` | tree/snapshot digest malformed or manifest mismatch |
| `E_PROVENANCE` | declared provenance file missing or extra vendored file |
| `E_EXTRACTION_POLICY` | traversal/symlink/submodule/LFS/device/limit violation |
| `E_AUTO_ADOPT` | attempt to silently adopt an unselected upstream skill |

## §10 State transitions

Adopted source state changes ONLY through the Contract B apply path
(`UpdatePlan` → review → exact apply → Git diff). This contract defines the
static shape being transitioned; it defines no mutating operation itself.
`hub build` (Contract C) consumes the adopted state read-only after verifying
lock self-containment and vendored digests.

## §11 Compatibility and version policy

- This file is Contract A v1. Additive risk (new source types, LFS,
  submodules, overlays) REQUIRES a new contract version, never silent
  reinterpretation of v1 files.
- `schema_version: 1` files MUST validate under v1 forever. A v2 reader MUST
  either accept v1 files with identical semantics or reject them explicitly;
  it MUST NOT assign them new meaning.
- V1 SPEC-001–006 semantics are preserved. Nothing here changes local import,
  routing, locking, or the four-tool MCP surface.

## §12 Acceptance (executable)

1. `node scripts/contracts/validate-contract-a.mjs` exits 0 on
   `scripts/contracts/examples/contract-a/` and recomputes both frozen
   `source_config_digest` vectors in §4.1.
2. `node --test tests/contracts/contract-a.test.mjs` passes: good fixtures
   validate; each negative fixture (unknown field, unsorted roots, orphan
   source, digest mismatch, null, unsafe path) fails closed with the
   catalogued error class named in the output.
3. `pnpm specs:check` still passes (V1 frozen set untouched).
4. `pnpm build` + `pnpm typecheck` pass; `git diff --check` clean.
5. Linux + Windows CI green (path-semantics rules are cross-platform by
   construction; validator uses posix-relative checks only).
