#!/usr/bin/env python3
"""Compute artifact digests and emit a provenance manifest.

Read-only with respect to the artifact. Writes only the manifest when asked.
Plain Python 3 standard library only.

Provenance status vocabulary (do not confuse "supplied by caller" with
"verified by independent evidence"):

    UNKNOWN    no identity is available
    SUPPLIED   an identifier was provided by the caller but not independently
               resolved to a real object
    RESOLVED   the identifier was independently resolved to a real
               local/platform object, but lineage has not been proven
    VERIFIED   independent evidence establishes the claimed relationship

Caller-supplied build IDs, release IDs, and deployment identifiers stay
SUPPLIED at most. A supplied source SHA becomes RESOLVED only when it
independently resolves to a local commit; that still does not prove the
artifact was built from it. VERIFIED requires external evidence proving the
claimed relationship (for example, build metadata reporting both the source
SHA and the artifact digest). Locally computed digests, sizes, and file
counts are VERIFIED because this script computed them; that says nothing
about the source-to-build chain.

Directory artifacts hash a deterministic tree representation that includes
symlinks by relative path, entry type, and target (never followed), so two
trees differing only by symlink target hash differently.

Usage:
    python3 provenance_manifest.py --artifact ./dist/app.apk --kind apk \
        --source-sha <sha> --output manifest.json
    python3 provenance_manifest.py --artifact ./dist --kind generated-bundle
    python3 provenance_manifest.py --artifact ./dist --verify manifest.json

Exit codes:
    0  success
    1  verification mismatch
    2  usage or artifact error
"""

import argparse
import datetime
import hashlib
import json
import os
import struct
import subprocess
import sys

MANIFEST_VERSION = 2
SUPPORTED_ALGORITHMS = ("sha256", "sha512")


def run(cmd, cwd=None):
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False, ""
    if proc.returncode != 0:
        return False, ""
    return True, proc.stdout.strip()


def file_digest(path, algorithm):
    hasher = hashlib.new(algorithm)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def tree_digest(root, algorithm):
    """Hash sorted file and symlink entries with explicit TREE-V2 framing.

    Empty directories are intentionally excluded. Symlinks are hashed by
    their target bytes and never followed.
    """
    hasher = hashlib.new(algorithm)
    hasher.update(b"EGA-TREE-V2")
    entries = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted(dirnames) + sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.islink(full):
                entries.append((rel, "symlink", full))
            elif os.path.isdir(full):
                continue
            else:
                entries.append((rel, "file", full))
    entries.sort(key=lambda item: item[0].encode("utf-8"))
    file_count = 0
    for rel, kind, full in entries:
        path_bytes = rel.encode("utf-8")
        hasher.update(b"L" if kind == "symlink" else b"F")
        hasher.update(struct.pack(">Q", len(path_bytes)))
        hasher.update(path_bytes)
        if kind == "symlink":
            target = os.fsencode(os.readlink(full))
            hasher.update(struct.pack(">Q", len(target)))
            hasher.update(target)
        else:
            file_count += 1
            size = os.path.getsize(full)
            hasher.update(struct.pack(">Q", size))
            content_hasher = hashlib.new(algorithm)
            with open(full, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    content_hasher.update(chunk)
            hasher.update(content_hasher.digest())
    return hasher.hexdigest(), file_count, len(entries)


def describe_artifact(path, algorithm):
    if os.path.isdir(path) and not os.path.islink(path):
        digest, file_count, entry_count = tree_digest(path, algorithm)
        size = 0
        for dirpath, _dirnames, filenames in os.walk(path, followlinks=False):
            for name in filenames:
                full = os.path.join(dirpath, name)
                if not os.path.islink(full):
                    size += os.path.getsize(full)
        return {"kind_path": "directory", "digest": digest,
                "digest_algorithm": "tree-%s-v2" % algorithm, "size_bytes": size,
                "file_count": file_count, "entry_count": entry_count}
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    digest = file_digest(path, algorithm)
    return {"kind_path": "file", "digest": digest, "digest_algorithm": algorithm,
            "size_bytes": os.path.getsize(path), "file_count": 1,
            "entry_count": 1}


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0).isoformat().replace("+00:00", "Z")


def resolve_sha_locally(sha, cwd):
    """True iff the SHA independently resolves to a local commit."""
    if not sha:
        return False
    ok, _ = run(["git", "rev-parse", "--verify", "-q", sha + "^{commit}"], cwd=cwd)
    return ok


def build_manifest(args):
    info = describe_artifact(args.artifact, args.digest_algorithm)

    source_sha = args.source_sha
    source_sha_status = "UNKNOWN"
    if source_sha:
        # Caller-supplied: only independently resolving it locally upgrades
        # SUPPLIED to RESOLVED. Resolution never proves the artifact was
        # built from this commit; only external build evidence can verify
        # the source-to-build relationship.
        source_sha_status = "SUPPLIED"
        if resolve_sha_locally(source_sha, args.cwd):
            source_sha_status = "RESOLVED"
    else:
        # Inferred from the current checkout: the commit exists locally
        # (RESOLVED), but this is not proof that the artifact was built
        # from it.
        ok, sha = run(["git", "rev-parse", "HEAD"], cwd=args.cwd)
        if ok and sha:
            source_sha = sha
            source_sha_status = "RESOLVED"

    source_ref = args.source_ref
    source_ref_status = "UNKNOWN"
    if source_ref:
        source_ref_status = "SUPPLIED"
    else:
        ok, ref = run(["git", "symbolic-ref", "-q", "HEAD"], cwd=args.cwd)
        if ok and ref:
            source_ref = ref
            source_ref_status = "RESOLVED"

    repository = args.repository
    repository_status = "UNKNOWN"
    if repository:
        repository_status = "SUPPLIED"
    else:
        ok, url = run(["git", "remote", "get-url", "origin"], cwd=args.cwd)
        if ok and url:
            repository = url
            repository_status = "RESOLVED"

    # Supplied identifiers are at most SUPPLIED. Independent resolution by
    # an external platform (CI provider, deployment API) would be RESOLVED,
    # and only external evidence tying them to this artifact is VERIFIED.
    # This script cannot query those platforms, so it never claims that.
    build_status = "SUPPLIED" if args.build_id else "UNKNOWN"
    release_status = "SUPPLIED" if args.release_id else "UNKNOWN"
    deployment_status = "UNKNOWN"
    if args.deployment_target and (args.deployment_version or args.deployment_digest):
        deployment_status = "SUPPLIED"

    # File or directory recheck command: directory trees are hashed with a
    # custom deterministic representation, so sha256sum/sha512sum on a
    # directory is invalid. Emit only what actually re-verifies.
    recheck_commands = [
        "python3 provenance_manifest.py --artifact %s --verify <manifest.json>"
        % os.path.abspath(args.artifact),
    ]
    if info["kind_path"] == "file":
        recheck_commands.insert(
            0,
            "%s %s" % ("sha256sum" if args.digest_algorithm == "sha256" else "sha512sum",
                       os.path.abspath(args.artifact)),
        )

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "generated_at": now_iso(),
        "source": {
            "repository": repository,
            "repository_status": repository_status,
            "ref": source_ref,
            "ref_status": source_ref_status,
            "sha": source_sha,
            "sha_status": source_sha_status,
        },
        "build": {
            "id": args.build_id,
            "pipeline": args.build_pipeline,
            "builder": args.build_builder,
            "inputs": args.build_input or [],
            "id_status": build_status,
        },
        "artifact": {
            "kind": args.kind,
            "name": args.name or os.path.basename(os.path.abspath(args.artifact)),
            "path": os.path.abspath(args.artifact),
            "size_bytes": info["size_bytes"],
            "digest": info["digest"],
            "digest_algorithm": info["digest_algorithm"],
            "kind_path": info["kind_path"],
            "file_count": info["file_count"],
            "entry_count": info["entry_count"],
            # Computed locally by this script: the digest is VERIFIED as a
            # property of this artifact. This does NOT imply the full
            # source->build->deployment chain is verified; chain statuses
            # above carry that evidence separately.
            "status": "VERIFIED",
        },
        "release": {
            "id": args.release_id,
            "name": args.release_name,
            "url": args.release_url,
            "id_status": release_status,
        },
        "deployment": {
            "kind": args.deployment_kind,
            "target": args.deployment_target,
            "environment": args.deployment_environment,
            "version": args.deployment_version,
            "digest": args.deployment_digest,
            "status": deployment_status,
        },
        "verification": {
            "evidence_level": "E4",
            "artifact_evidence": "digest, size, and entry count computed locally",
            "chain_evidence": "see per-section statuses; partial provenance is expected",
            "recheck_commands": recheck_commands,
        },
    }
    return manifest


def verify(args):
    with open(args.verify, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    recorded = manifest.get("artifact", {})
    algorithm = recorded.get("digest_algorithm", "sha256")
    artifact_is_directory = os.path.isdir(args.artifact) and not os.path.islink(args.artifact)
    if artifact_is_directory:
        prefix = "tree-"
        suffix = "-v2"
        if not algorithm.startswith(prefix) or not algorithm.endswith(suffix):
            print("unsupported or legacy directory digest algorithm: %s" % algorithm,
                  file=sys.stderr)
            return 2
        hash_algorithm = algorithm[len(prefix):-len(suffix)]
    else:
        hash_algorithm = algorithm
    if hash_algorithm not in SUPPORTED_ALGORITHMS:
        print("unsupported algorithm in manifest: %s" % algorithm, file=sys.stderr)
        return 2
    try:
        info = describe_artifact(args.artifact, hash_algorithm)
    except FileNotFoundError:
        print("artifact not found: %s" % args.artifact, file=sys.stderr)
        return 2
    integrity_fields = ("digest_algorithm", "digest", "size_bytes", "file_count", "entry_count")
    if "kind_path" in recorded:
        integrity_fields += ("kind_path",)
    ok = all(key in recorded and info.get(key) == recorded.get(key)
             for key in integrity_fields)
    print("VERIFY: %s" % ("MATCH" if ok else "MISMATCH"))
    print("  algorithm: %s" % algorithm)
    print("  manifest:  %s" % recorded.get("digest"))
    print("  artifact:  %s" % info["digest"])
    if not ok:
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(description="Compute artifact digests and emit a provenance manifest.")
    parser.add_argument("--artifact", required=True, help="file or directory to hash")
    parser.add_argument("--kind", default="other")
    parser.add_argument("--name", default=None)
    parser.add_argument("--digest-algorithm", default="sha256", choices=list(SUPPORTED_ALGORITHMS))
    parser.add_argument("--source-sha", default=None)
    parser.add_argument("--source-ref", default=None)
    parser.add_argument("--repository", default=None)
    parser.add_argument("--build-id", default=None)
    parser.add_argument("--build-pipeline", default=None)
    parser.add_argument("--build-builder", default=None)
    parser.add_argument("--build-input", action="append", default=None)
    parser.add_argument("--release-id", default=None)
    parser.add_argument("--release-name", default=None)
    parser.add_argument("--release-url", default=None)
    parser.add_argument("--deployment-kind", default=None)
    parser.add_argument("--deployment-target", default=None)
    parser.add_argument("--deployment-environment", default=None)
    parser.add_argument("--deployment-version", default=None)
    parser.add_argument("--deployment-digest", default=None)
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--output", default=None)
    parser.add_argument("--verify", default=None, help="verify an artifact against an existing manifest")
    parser.add_argument("--json", action="store_true", help="print the manifest to stdout")
    args = parser.parse_args()

    if args.verify:
        return verify(args)

    try:
        manifest = build_manifest(args)
    except FileNotFoundError as exc:
        print("artifact not found: %s" % exc, file=sys.stderr)
        return 2

    text = json.dumps(manifest, indent=2, sort_keys=True)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print("manifest written: %s" % args.output)
    if args.json or not args.output:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
