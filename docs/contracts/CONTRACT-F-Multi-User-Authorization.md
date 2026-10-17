# Contract F — Multi-User Authorization v1

Status: frozen before 2.0 implementation.

This contract defines authorization for shared workspaces and Hubs. Immutable
HubRelease, SQLite, manifest, and content identities remain data-plane objects;
mutable ownership, visibility, membership, deny, audit, and quota state remain
control-plane state.

## 1. Roles and permissions

Workspace roles are exactly `owner`, `admin`, `maintainer`, `member`, and
`viewer`. The owner is unique and cannot be removed without a replacement
owner transaction. Role evaluation is centralized and deny precedence is
explicit: revoked/denied state overrides every allow.

- `owner`: all workspace, membership, visibility, source, publication,
  project, and revocation operations;
- `admin`: membership, visibility, source, publication, project, and
  revocation operations, except ownership transfer;
- `maintainer`: source updates, release publication, project/context
  publication, and reads permitted by Hub policy;
- `member`: reads and project operations explicitly granted by policy;
- `viewer`: read-only access to authorized resources.

Every operation resolves the actor from the authenticated subject and then
authorizes the complete resource graph. Client-provided workspace, Hub,
project, context, release, SkillVersion, or blob IDs are never capabilities.

## 2. Hub visibility

Hubs have one of `private`, `workspace`, or `public` visibility. Private Hubs
require explicit authorization. Workspace Hubs require authorized membership.
Public Hubs are readable according to public policy, but publication and
mutation still require an authorized publisher. Visibility is mutable,
audited control state and does not change immutable release identity.

## 3. Authorization graph and content access

Reads follow:

`subject → workspace → Hub → HubRelease → Project → ProjectContext → SkillVersion → blob`.

Authorization occurs before content-addressed retrieval and before cached
delivery. A known digest for any object grants no access. Search executes only
against the exact authorized release/context corpus and must not combine
private corpora.

## 4. Revocation and deny

Mutable revocation/deny may target a Hub, HubRelease, SkillVersion, blob,
ProjectContext, source, or membership/session where supported. Revocation does
not delete or replace immutable identity. Requests fail explicitly and never
fall back to another release, context, or version.

## 5. Audit, quotas, and credentials

Membership, role, visibility, source, publication, stable-pointer, context,
revocation, quota, and credential operations emit append-oriented audit events
with actor, workspace, operation, target, old/new identity, request ID, time,
and result. Timestamps are not artifact identity inputs.

Quota decisions are explicit allow/deny outcomes with retry guidance and must
not silently change search ranking or selection. Private source credentials
are server-side, source-scoped, least-privilege, rotatable secret references;
they are never returned to runtime clients or written to ordinary logs.

## 6. Boundary and data-plane separation

Hosted MCP uses read-only data-plane credentials. Publication, Git, stable
pointer mutation, membership, visibility, and authorization changes remain
outside the runtime. Immutable artifacts may be stored in content-addressed
object storage; mutable pointers and policy remain in the control plane.

This contract does not define billing, recommendation ranking, automatic trust
from upstream metadata, or a global multi-release search corpus.
