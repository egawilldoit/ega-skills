# Release gate and evidence model

Detailed model behind `certify-release`. The core rule: a gate passes only when
its exit criteria are met with evidence at the required level, attached to the
exact release SHA or artifact.

## Gate CODE

What the source says and what automated checks proved about it.

Entry criteria:

- A release SHA is identified and reachable.
- Implementation for the release is present at that SHA.

Exit criteria:

- Tests covering the changed behavior passed at the release SHA (`E2` local or
  `E3` CI).
- Review evidence names the release SHA, not an ancestor.
- CI checks are associated with the exact release SHA and are green (`E3`).
- Static validation (type checks, linters, schema checks) is clean at that SHA.

Evidence that does not count:

- A green build from a different SHA.
- A review on an earlier commit that was later amended.
- "Tests pass locally" with no record of the command or result.
- A merge commit whose parents include the release SHA but whose own checks
  belong to another branch.

## Gate RUNTIME

What a real environment did with the built artifact.

Entry criteria:

- CODE gate passed.
- A built artifact exists for the release.

Exit criteria:

- The artifact is pinned by digest or checksum (`E4`).
- The deployment maps to that exact artifact, not to a rebuild or a moving tag.
- Any required migration is applied in the target environment.
- Health checks pass in the running environment (`E5`).
- A smoke test exercises the deployed surface in the real environment (`E5`).

Evidence that does not count:

- A successful build with no deployment.
- A deployment from a branch head that has since moved.
- Health from a staging environment presented as production.
- An artifact identified only by a mutable tag with no digest.

## Gate PRODUCT

What the intended user actually did through the intended surface.

Entry criteria:

- RUNTIME gate passed.
- The intended client and authentication path are known.

Exit criteria:

- The operation is performed through the intended client, not an internal API
  shortcut (`E6`).
- A real device is used when the product requires one (`E6`).
- The real authentication path is used, including token or session acquisition
  (`E6`).
- A real end-user workflow completes, not a synthetic probe (`E6`).

Evidence that does not count:

- `curl` against a backend presented as client verification.
- A server-local test presented as an end-user workflow.
- A privileged internal call that bypasses the real auth path.
- An emulator when the requirement names physical hardware.

## Cumulative ordering

```text
CODE fails or is not checked   -> BLOCKED (report CODE as the blocker)
CODE passes, RUNTIME fails     -> CODE_READY
CODE and RUNTIME pass          -> RUNTIME_READY
all three pass                 -> PRODUCT_READY
```

Passed gates are reported as passed even when a later gate fails. A gate that
was not attempted is `NOT CHECKED`, which is neither pass nor fail.

## Evidence level per gate

```text
CODE     E1 static, E2 local execution, E3 CI
RUNTIME  E4 immutable artifact, E5 runtime
PRODUCT  E6 real client or device
```

Reporting a gate at a lower level than its exit criteria is allowed, but the
gate does not pass. State the level reached so a reviewer can see the gap.

## Identity requirements

Every gate needs a stable identity to attach evidence to:

- Release SHA.
- Artifact digest or version.
- Environment name.
- Deployment identifier when a platform provides one.

If identity is missing, the gate cannot pass regardless of how good the
evidence looks. Return `BLOCKED` and name the missing identity.

## Common false certifications

- "CI is green" while the checks belong to a different SHA.
- "Deployed" while only the build succeeded.
- "Works" while only an internal endpoint was probed.
- "Production-ready" while PRODUCT was never attempted.
- "Migration done" while only the migration file exists. See
  `certify-database-rollout`.
- "Correct target" while the environment was never confirmed. See
  `certify-production-target`.
