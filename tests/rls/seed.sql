-- Deterministic Contract F fixture applied as the database owner after all
-- migrations. Every digest pattern is repeated hex so assertions stay readable.
insert into public.personal_workspaces (id, owner_subject) values
  ('00000000-0000-4000-8000-0000000000a1', 'user-a'),
  ('00000000-0000-4000-8000-0000000000b1', 'user-b');

insert into public.workspace_memberships (workspace_id, subject, role, active) values
  ('00000000-0000-4000-8000-0000000000a1', 'user-a', 'owner', true),
  ('00000000-0000-4000-8000-0000000000a1', 'admin-a', 'admin', true),
  ('00000000-0000-4000-8000-0000000000a1', 'maintainer-a', 'maintainer', true),
  ('00000000-0000-4000-8000-0000000000a1', 'member-a', 'member', true),
  ('00000000-0000-4000-8000-0000000000a1', 'viewer-a', 'viewer', true),
  ('00000000-0000-4000-8000-0000000000a1', 'inactive-a', 'member', false),
  ('00000000-0000-4000-8000-0000000000b1', 'user-b', 'owner', true);

insert into public.hubs (id, workspace_id, visibility) values
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-0000000000a1', 'private'),
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-0000000000a1', 'workspace'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-0000000000a1', 'workspace'),
  ('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-0000000000a1', 'public'),
  ('00000000-0000-4000-8000-00000000a005', '00000000-0000-4000-8000-0000000000a1', 'public'),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-0000000000b1', 'private'),
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-0000000000b1', 'public');

insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest) values
  ('00000000-0000-4000-8000-00000000a001', 'sha256:' || repeat('1', 64), 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000a002', 'sha256:' || repeat('2', 64), 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000a003', 'sha256:' || repeat('3', 64), 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000a004', 'sha256:' || repeat('4', 64), 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000a005', 'sha256:' || repeat('5', 64), 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000b001', 'sha256:' || repeat('6', 64), 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000b002', 'sha256:' || repeat('7', 64), 'sha256:' || repeat('9', 64));

insert into public.hub_stable_pointers (hub_id, release_digest) values
  ('00000000-0000-4000-8000-00000000a001', 'sha256:' || repeat('1', 64)),
  ('00000000-0000-4000-8000-00000000a002', 'sha256:' || repeat('2', 64)),
  ('00000000-0000-4000-8000-00000000a003', 'sha256:' || repeat('3', 64)),
  ('00000000-0000-4000-8000-00000000a004', 'sha256:' || repeat('4', 64)),
  ('00000000-0000-4000-8000-00000000a005', 'sha256:' || repeat('5', 64)),
  ('00000000-0000-4000-8000-00000000b001', 'sha256:' || repeat('6', 64)),
  ('00000000-0000-4000-8000-00000000b002', 'sha256:' || repeat('7', 64));

insert into public.immutable_objects (object_digest, object_kind, byte_length) values
  ('sha256:' || repeat('a', 64), 'hub_release', 10),
  ('sha256:' || repeat('b', 64), 'sqlite', 10),
  ('sha256:' || repeat('c', 64), 'hub_release', 10),
  ('sha256:' || repeat('d', 64), 'sqlite', 10),
  ('sha256:' || repeat('e', 64), 'hub_release', 10),
  ('sha256:' || repeat('f', 64), 'sqlite', 10),
  ('sha256:' || repeat('8', 64), 'hub_release', 10),
  ('sha256:' || repeat('9', 64), 'sqlite', 10),
  ('sha256:' || repeat('0', 64), 'hub_release', 10),
  ('sha256:' || repeat('3', 64), 'sqlite', 10),
  ('sha256:' || repeat('4', 64), 'hub_release', 10),
  ('sha256:' || repeat('5', 64), 'sqlite', 10),
  ('sha256:' || repeat('6', 64), 'hub_release', 10),
  ('sha256:' || repeat('7', 64), 'sqlite', 10);

insert into public.hub_release_artifacts (hub_id, release_digest, artifact_kind, object_digest) values
  ('00000000-0000-4000-8000-00000000a001', 'sha256:' || repeat('1', 64), 'release', 'sha256:' || repeat('a', 64)),
  ('00000000-0000-4000-8000-00000000a001', 'sha256:' || repeat('1', 64), 'sqlite', 'sha256:' || repeat('b', 64)),
  ('00000000-0000-4000-8000-00000000a002', 'sha256:' || repeat('2', 64), 'release', 'sha256:' || repeat('c', 64)),
  ('00000000-0000-4000-8000-00000000a002', 'sha256:' || repeat('2', 64), 'sqlite', 'sha256:' || repeat('d', 64)),
  ('00000000-0000-4000-8000-00000000a003', 'sha256:' || repeat('3', 64), 'release', 'sha256:' || repeat('e', 64)),
  ('00000000-0000-4000-8000-00000000a003', 'sha256:' || repeat('3', 64), 'sqlite', 'sha256:' || repeat('f', 64)),
  ('00000000-0000-4000-8000-00000000a004', 'sha256:' || repeat('4', 64), 'release', 'sha256:' || repeat('8', 64)),
  ('00000000-0000-4000-8000-00000000a004', 'sha256:' || repeat('4', 64), 'sqlite', 'sha256:' || repeat('9', 64)),
  ('00000000-0000-4000-8000-00000000a005', 'sha256:' || repeat('5', 64), 'release', 'sha256:' || repeat('0', 64)),
  ('00000000-0000-4000-8000-00000000a005', 'sha256:' || repeat('5', 64), 'sqlite', 'sha256:' || repeat('3', 64)),
  ('00000000-0000-4000-8000-00000000b001', 'sha256:' || repeat('6', 64), 'release', 'sha256:' || repeat('4', 64)),
  ('00000000-0000-4000-8000-00000000b001', 'sha256:' || repeat('6', 64), 'sqlite', 'sha256:' || repeat('5', 64)),
  ('00000000-0000-4000-8000-00000000b002', 'sha256:' || repeat('7', 64), 'release', 'sha256:' || repeat('6', 64)),
  ('00000000-0000-4000-8000-00000000b002', 'sha256:' || repeat('7', 64), 'sqlite', 'sha256:' || repeat('7', 64));

insert into public.public_hub_publications (hub_id, publisher_subject, policy_version) values
  ('00000000-0000-4000-8000-00000000a004', 'user-a', 'E1'),
  ('00000000-0000-4000-8000-00000000b002', 'user-b', 'E1');

insert into public.security_denies (workspace_id, kind, identity, reason) values
  ('00000000-0000-4000-8000-0000000000a1', 'hub', '00000000-0000-4000-8000-00000000a003', 'emergency'),
  ('00000000-0000-4000-8000-0000000000a1', 'release', 'sha256:' || repeat('5', 64), 'emergency'),
  ('00000000-0000-4000-8000-0000000000a1', 'blob', 'sha256:' || repeat('8', 64), 'emergency');

insert into public.projects (id, workspace_id, name) values
  ('00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000000a1', 'project-a'),
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000000b1', 'project-b');

insert into public.project_contexts (id, project_id, context_digest, release_digest, revoked_at) values
  ('00000000-0000-4000-8000-000000000a11', '00000000-0000-4000-8000-000000000a01', 'sha256:' || repeat('a', 64), 'sha256:' || repeat('4', 64), null),
  ('00000000-0000-4000-8000-000000000a12', '00000000-0000-4000-8000-000000000a01', 'sha256:' || repeat('b', 64), 'sha256:' || repeat('4', 64), now()),
  ('00000000-0000-4000-8000-000000000a13', '00000000-0000-4000-8000-000000000a01', 'sha256:' || repeat('c', 64), 'sha256:' || repeat('4', 64), null),
  ('00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 'sha256:' || repeat('d', 64), 'sha256:' || repeat('7', 64), null);

insert into public.context_revocations (context_id, reason, revoked_by) values
  ('00000000-0000-4000-8000-000000000a13', 'superseded', 'user-a');

insert into public.quota_policies (workspace_id, requests_per_minute, concurrent_requests, bandwidth_bytes) values
  ('00000000-0000-4000-8000-0000000000a1', 60, 4, 1000000),
  ('00000000-0000-4000-8000-0000000000b1', 60, 4, 1000000);

insert into public.quota_usage (workspace_id, window_started, request_count, bandwidth_bytes) values
  ('00000000-0000-4000-8000-0000000000a1', now(), 1, 10),
  ('00000000-0000-4000-8000-0000000000b1', now(), 1, 10);

insert into public.source_credentials (workspace_id, source_id, secret_reference) values
  ('00000000-0000-4000-8000-0000000000a1', 'plan', 'vault://ega/plan'),
  ('00000000-0000-4000-8000-0000000000b1', 'plan', 'vault://ega/plan-b');

insert into public.audit_events (workspace_id, actor_subject, operation, result) values
  ('00000000-0000-4000-8000-0000000000a1', 'user-a', 'publish_context', 'allowed'),
  ('00000000-0000-4000-8000-0000000000b1', 'user-b', 'publish_context', 'allowed');
