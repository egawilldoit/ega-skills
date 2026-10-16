# Experimental combined routing candidate artifact (NOT adopted)

This directory is an isolated, unpublished, non-verifiable candidate artifact
assembled for EGA-723/EGA-753/EGA-754 plus the release-certification safety
repair. It retains the published release digest in `hub-release.json` while
mutating four skills' routing metadata, so it is explicitly experimental and
must never be served or adopted as a release.

Skills mutated vs the published artifact:
- egawilldoit/get-pr-comments: removed over-broad `domains: [github]`
- egawilldoit/design-architecture: removed over-broad `domains: [architecture]`
- egawilldoit/certify-production-target: added user-voice trigger "prove this is really live"
- mattpocock/pr: added anti-trigger "release" to prevent excluded auto-selection

Candidate artifact digest (local only): sha256:05f9068335417ba7bc61197e6e4722b38059dfda122e0f3534f9c44e6801044a
Published release digest retained: sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3
