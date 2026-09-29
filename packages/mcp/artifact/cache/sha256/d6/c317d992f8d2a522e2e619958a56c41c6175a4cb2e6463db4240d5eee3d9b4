# Provenance manifest schema

The manifest is the artifact of `trace-artifact-provenance`. It is JSON so a reviewer can diff it, store it, and re-check it. This file documents each field and how it is verified.

## Schema

```json
{
  "manifest_version": 2,
  "generated_at": "2026-01-01T00:00:00Z",
  "source": {
    "repository": "host/owner/name",
    "repository_status": "RESOLVED",
    "ref": "refs/heads/main",
    "ref_status": "RESOLVED",
    "sha": "full-40-char-commit-sha",
    "sha_status": "RESOLVED"
  },
  "build": {
    "id": "run id or build number",
    "pipeline": "pipeline or workflow name",
    "builder": "builder identity or image",
    "inputs": ["lockfile digest", "toolchain version"],
    "id_status": "SUPPLIED"
  },
  "artifact": {
    "kind": "apk | container-image | release-archive | package | vercel-deployment | server-deployment | generated-bundle | other",
    "name": "human readable name",
    "path": "local path or registry reference",
    "size_bytes": 12345,
    "digest": "hex",
    "digest_algorithm": "sha256 | tree-sha256-v2 | sha512 | tree-sha512-v2",
    "kind_path": "file | directory",
    "file_count": 1,
    "entry_count": 2,
    "status": "VERIFIED"
  },
  "release": {
    "id": "release id",
    "name": "release name",
    "url": "release URL",
    "id_status": "SUPPLIED"
  },
  "deployment": {
    "kind": "vercel | server | registry | other",
    "target": "project or host",
    "environment": "production | staging | preview",
    "version": "deployed version or commit",
    "digest": "deployed artifact digest",
    "status": "SUPPLIED"
  },
  "verification": {
    "evidence_level": "E4",
    "artifact_evidence": "digest, size, and entry count computed locally",
    "chain_evidence": "see per-section statuses; partial provenance is expected",
    "recheck_commands": [
      "sha256sum <path>",
      "python3 provenance_manifest.py --artifact <path> --verify <manifest.json>"
    ]
  }
}
```

## Field status values

Each link carries a provenance state that separates what was supplied from what was independently established:

```text
UNKNOWN    no identity is available
SUPPLIED   an identifier was provided by the caller but not independently resolved
RESOLVED   the identifier was independently resolved to a real local or platform object, but lineage is not proven
VERIFIED   independent evidence establishes the claimed relationship
```

Status transitions a caller cannot cause by supplying a value:

```text
supplied source SHA that resolves to a local commit     -> RESOLVED
supplied source SHA that cannot be resolved              -> SUPPLIED
inferred source SHA from the current checkout (HEAD)     -> RESOLVED
supplied build id / release id / deployment identity     -> SUPPLIED
build metadata proving source SHA and artifact digest    -> VERIFIED (source-to-build)
locally computed digest, size, entry count               -> VERIFIED (artifact evidence only)
```

A locally computed artifact digest is `VERIFIED` as a property of the artifact. That never implies the source->build->deployment chain is verified; the chain statuses carry that evidence separately, and partial provenance is the expected outcome.

## How each field is verified

```text
source.sha          resolved with git rev-parse when supplied; full 40 chars
source.ref          resolved from the current checkout or supplied by the caller
build.id            the pipeline run id; SUPPLIED until read from the build system
artifact.digest     computed from the exact distributed bytes
artifact.path       points at the bytes that were hashed
release.id          SUPPLIED until read from the release record
deployment.version  SUPPLIED until read from the platform
deployment.digest   SUPPLIED until read from the platform's artifact identity
```

## Directory and bundle digests

For a directory, the digest algorithm is `tree-sha256-v2` or `tree-sha512-v2`. The versioned digest uses this deterministic representation:

1. Start the hash with `EGA-TREE-V2`.
2. Walk the tree without following symlinks. Empty directories are excluded.
3. Collect every file and symlink, sorted by UTF-8 relative path bytes.
4. For each entry, hash a one-byte type tag, an unsigned 64-bit big-endian path length, and the path bytes. A file adds its unsigned 64-bit size and raw SHA-256/SHA-512 content digest. A symlink adds an unsigned 64-bit target length and target bytes.
5. Record and verify the digest algorithm, digest, total file size, file count, and entry count.

Explicit lengths make entry boundaries unambiguous. Symlinks are included by target and never followed, so two trees that differ only by a symlink target produce different digests, and a symlink pointing into the tree cannot cause a cycle or recursion. Legacy unversioned directory digests are rejected rather than reinterpreted.

## Independent re-check

A reviewer who does not trust the author:

1. Obtains the artifact bytes by the recorded path or registry reference.
2. Runs the recorded recheck command. For a file, `sha256sum`/`sha512sum` also works. For a directory, the custom tree digest requires `provenance_manifest.py --artifact <path> --verify <manifest>`; `sha256sum` on a directory is invalid and the manifest never suggests it.
3. Reads `source.sha` from the repository and confirms the commit exists.
4. Reads the release record and confirms it references the artifact.
5. Reads the deployment platform and confirms `deployment.version` and `deployment.digest`.

If any step disagrees, the link is contradicted and the manifest is not trustworthy until resolved.

## Anti-patterns

- Recording a tag where a digest is required. Tags move; digests do not.
- Hashing a re-packed archive. The distributed bytes are the artifact.
- Inferring the deployment commit from deploy time. Read the platform field.
- Omitting the digest algorithm. The same hex string means nothing without it.
- Marking a link `VERIFIED` when the value came from a caller claim rather than an independent resolution or platform field.
- Treating `artifact.status: VERIFIED` as proof of the full chain. Artifact evidence and chain evidence are separate.
- Running `sha256sum <directory>`. Directory digests use the script's tree representation; re-verify with the script.
- Silently ignoring symlinks. They are hashed by target or the script fails explicitly.
