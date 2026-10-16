---
name: trace-artifact-provenance
description: "Establish immutable lineage from source commit to build to artifact to digest to release to deployment, and emit a provenance manifest another reviewer can independently check. Use for APK, container image, release archive, package, Vercel deployment, server deployment, or generated bundle when asked where an artifact came from, whether a deployment matches a commit, or which build produced a release. Produces checksum-pinned evidence at E4 or higher. For PR evidence freshness use certify-pr-head; for the complete release gate use certify-release."
---

# Trace artifact provenance

An artifact without a digest and a source commit is unverifiable. This skill pins the chain `source SHA -> build -> artifact -> digest -> release -> deployment` and emits a manifest a second reviewer can re-check independently.

Vocabulary comes from `references/operating-contract.md`. The chain reaches `E4 IMMUTABLE ARTIFACT` once a digest is computed; deployment observation raises it to `E5`.

## When to use

- Asked where a released artifact, image, APK, bundle, or deployment came from.
- Asked whether a deployment matches a specific commit.
- Asked which build produced a release, or whether two environments run the same bytes.
- Building a release and needing a checkable record of what was produced.
- Auditing an artifact whose provenance is claimed but unproven.

Do not use it to certify PR head evidence (`certify-pr-head`) or to run the full release gate (`certify-release`).

## Artifact kinds

```text
apk                Android package
container-image    OCI/Docker image
release-archive    tarball or zip of a release
package            published package artifact
vercel-deployment  a Vercel deployment
server-deployment  a deployment to a server or host
generated-bundle   a built JS/CSS/asset bundle
other              anything else with a stable digest
```

## The chain

```text
source SHA      the exact commit the build ran from
build           the build identity: pipeline, run id, builder, inputs
artifact        the produced file, image, or deployment
digest          a cryptographic hash of the artifact bytes
release         the release identity that contains the artifact
deployment      the environment where the artifact runs, and its identity
```

Every link is optional only if the task does not need it. A link that is unknown is recorded as unknown, never guessed.

## Workflow

1. Fix the source SHA. It is a full commit id, not a branch name.
2. Identify the build: pipeline name, run id, and builder. Record what inputs it consumed.
3. Locate the artifact. For a file or directory, compute the digest locally. For a container image or platform deployment, use the digest the platform reports.
4. Run `scripts/provenance_manifest.py` to compute digests and emit the manifest.
5. Attach the release and deployment identity when they exist.
6. Mark each link with the provenance-state vocabulary and record the evidence level.
7. State how a reviewer independently re-checks each digest.

## Provenance states

An identifier someone supplies is not proof. The manifest distinguishes what was supplied from what was independently established:

```text
UNKNOWN    no identity is available
SUPPLIED   an identifier was provided by the caller but not independently resolved
RESOLVED   the identifier was independently resolved to a real local or platform object, but lineage is not proven
VERIFIED   independent evidence establishes the claimed relationship
```

Caller-supplied build IDs, release IDs, deployment targets, and deployment versions stay `SUPPLIED` unless independently resolved by querying the platform that owns them. A supplied source SHA that resolves to a local commit is `RESOLVED` — resolution proves the commit exists, not that the artifact was built from it. Only external evidence tying the source SHA to the build output (for example, build metadata reporting both the source SHA and the artifact digest) makes the source-to-build relationship `VERIFIED`. A locally computed digest is `VERIFIED` as a property of the artifact; that never implies the full chain is verified.

## Digest rules

- Prefer SHA-256. Record the algorithm with the digest.
- For a directory or bundle, use the versioned `tree-sha256-v2` or `tree-sha512-v2` digest. It hashes sorted file and symlink paths with explicit length framing, file size and content digest, or symlink target bytes. Empty directories are excluded; symlinks are never followed. Verify the algorithm, digest, size, file count, and entry count.
- Never hash a re-encoded or re-zipped artifact and call it the original. Hash the exact bytes distributed.
- For a container image, the image digest is the identity, not the mutable tag.
- Two artifacts with the same digest are the same bytes. Same tag is not the same bytes.
- A directory digest is a custom versioned representation: re-verify it with `provenance_manifest.py --artifact <path> --verify <manifest>`, not `sha256sum <path>`. Unversioned directory digests are rejected.

## Manifest

The manifest is the deliverable. It is JSON so a reviewer can diff and verify it. The full schema is in `references/manifest-schema.md`. It contains at minimum:

```text
manifest_version
generated_at
source:      {sha + sha_status, ref + ref_status, repository + repository_status}
build:       {id, pipeline, builder, inputs, id_status}
artifact:    {kind, name, path, size_bytes, digest, digest_algorithm, file_count, entry_count, status}
release:     {id + id_status, name, url}
deployment:  {kind, target, environment, version, digest, status}
verification: {recheck_commands, evidence_level, artifact_evidence, chain_evidence}
```

`verification.artifact_evidence` and `verification.chain_evidence` are kept separate on purpose: a locally computed digest verifies the artifact bytes, while the source->build->deployment chain stays `PARTIAL` unless each link was independently established.

## Independent re-check

The manifest must let a reviewer reproduce each digest without trusting the author. Record the exact command or procedure per artifact. Example re-checks:

```text
file:      sha256sum <path>
directory: run provenance_manifest.py --artifact <path> --verify <manifest.json>
image:     the platform's digest field, compared to the recorded digest
platform:  the deployment's reported commit and build id
```

## Hard rules

- Pin the source commit SHA. A branch or tag is not provenance.
- Record the digest algorithm. A bare hex string is ambiguous.
- Never infer a deployment's commit from timing. Read the platform's reported value.
- Never claim a deployment matches a commit without comparing the platform's commit field to the source SHA.
- A caller-supplied identifier is at most `SUPPLIED`. Never upgrade it to `VERIFIED` without independent evidence.
- A locally computed digest verifies the artifact bytes only. Do not claim the source->build chain is proven because the digest was computed.
- Mark unknown links unknown. `E4` requires a real digest; do not report it otherwise.
- Do not invent build ids, pipeline names, or platform fields.

## Output contract

```text
PROVENANCE: COMPLETE | PARTIAL | UNVERIFIABLE
EVIDENCE: E0..E6
SOURCE SHA: <full sha + status, or unknown>
ARTIFACT: <kind>, digest <algo:hex> or unknown
RELEASE: <id + status, or unknown>
DEPLOYMENT: <target and version + status, or unknown>
CHAIN: <per link: UNKNOWN, SUPPLIED, RESOLVED, or VERIFIED>
RECHECK: <commands or procedures>
BLOCKERS: <type and detail, or none>
NEXT: <the single next action>
```

`UNVERIFIABLE` is correct when the artifact bytes or the source SHA cannot be obtained. Report it instead of asserting provenance.
