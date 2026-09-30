-- Contract F authorization repair: one coherent read model across the control
-- plane and the immutable inventory. Every read policy routes through a
-- narrowly scoped SECURITY DEFINER helper with a fixed empty search_path and
-- schema-qualified objects, so workspace/public visibility, inactive
-- membership, and explicit deny precedence are evaluated once and cannot
-- recurse through the policies they support.

-- Helpers -------------------------------------------------------------------

create or replace function private.is_active_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships m
    where m.workspace_id = target_workspace_id
      and m.subject = auth.jwt() ->> 'sub'
      and m.active
  );
$$;

create or replace function private.is_denied(
  target_workspace_id uuid,
  target_kind text,
  target_identity text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.security_denies d
    where d.workspace_id = target_workspace_id
      and d.kind = target_kind
      and d.identity = target_identity
  );
$$;

create or replace function private.has_inactive_membership(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships m
    where m.workspace_id = target_workspace_id
      and m.subject = auth.jwt() ->> 'sub'
      and not m.active
  );
$$;

-- private: explicit owner authorization (the schema cannot yet express
-- authorizedSubjects); workspace: any active membership; public: any
-- authenticated subject without a revoked membership. An explicit deny or a
-- revoked membership overrides every grant.
create or replace function private.can_read_hub(target_hub_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.hubs h
    join public.personal_workspaces w on w.id = h.workspace_id
    where h.id = target_hub_id
      and auth.jwt() ->> 'sub' is not null
      and not private.is_denied(h.workspace_id, 'hub', h.id::text)
      and not private.has_inactive_membership(h.workspace_id)
      and (
        h.visibility = 'public'
        or (h.visibility = 'workspace' and private.is_active_member(h.workspace_id))
        or (h.visibility = 'private' and w.owner_subject = auth.jwt() ->> 'sub')
      )
  );
$$;

create or replace function private.can_read_release(target_hub_id uuid, target_release_digest text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_read_hub(target_hub_id)
    and not private.is_denied(
      (select h.workspace_id from public.hubs h where h.id = target_hub_id),
      'release',
      target_release_digest
    );
$$;

create or replace function private.can_read_artifact(
  target_hub_id uuid,
  target_release_digest text,
  target_object_digest text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_read_release(target_hub_id, target_release_digest)
    and not private.is_denied(
      (select h.workspace_id from public.hubs h where h.id = target_hub_id),
      'blob',
      target_object_digest
    );
$$;

create or replace function private.can_read_object(target_object_digest text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.hub_release_artifacts a
    where a.object_digest = target_object_digest
      and private.can_read_artifact(a.hub_id, a.release_digest, a.object_digest)
  );
$$;

create or replace function private.can_read_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target_project_id
      and private.is_active_member(p.workspace_id)
  );
$$;

create or replace function private.can_read_context(target_context_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_contexts c
    join public.projects p on p.id = c.project_id
    where c.id = target_context_id
      and c.revoked_at is null
      and not exists (
        select 1 from public.context_revocations r where r.context_id = c.id
      )
      and private.is_active_member(p.workspace_id)
  );
$$;

create or replace function private.can_manage_context_revocations(target_context_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_contexts c
    join public.projects p on p.id = c.project_id
    where c.id = target_context_id
      and private.has_workspace_role(p.workspace_id, array['owner', 'admin']::text[])
  );
$$;

do $$
declare
  helper text;
begin
  foreach helper in array array[
    'private.has_workspace_role(uuid, text[])',
    'private.is_active_member(uuid)',
    'private.has_inactive_membership(uuid)',
    'private.is_denied(uuid, text, text)',
    'private.can_read_hub(uuid)',
    'private.can_read_release(uuid, text)',
    'private.can_read_artifact(uuid, text, text)',
    'private.can_read_object(text)',
    'private.can_read_project(uuid)',
    'private.can_read_context(uuid)',
    'private.can_manage_context_revocations(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', helper);
    execute format('grant execute on function %s to authenticated', helper);
  end loop;
end
$$;

revoke all on schema private from anon, public;
grant usage on schema private to authenticated;

-- Policies ------------------------------------------------------------------

drop policy if exists personal_workspace_owner on public.personal_workspaces;
create policy personal_workspace_owner_read on public.personal_workspaces
  for select using (owner_subject = auth.jwt() ->> 'sub');

drop policy if exists hub_owner on public.hubs;
create policy hub_read on public.hubs
  for select using (private.can_read_hub(id));

drop policy if exists hub_release_owner on public.hub_releases;
create policy hub_release_read on public.hub_releases
  for select using (private.can_read_release(hub_id, release_digest));

drop policy if exists stable_pointer_owner on public.hub_stable_pointers;
create policy stable_pointer_read on public.hub_stable_pointers
  for select using (private.can_read_release(hub_id, release_digest));

drop policy if exists security_deny_owner on public.security_denies;
create policy security_deny_admin_read on public.security_denies
  for select using (private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

drop policy if exists audit_owner on public.audit_events;
create policy audit_admin_read on public.audit_events
  for select using (workspace_id is not null and private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

drop policy if exists membership_self_or_owner on public.workspace_memberships;
create policy membership_self_or_admin_read on public.workspace_memberships
  for select using (
    subject = auth.jwt() ->> 'sub'
    or private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])
  );

drop policy if exists project_member_read on public.projects;
create policy project_member_read on public.projects
  for select using (private.is_active_member(workspace_id));

drop policy if exists context_member_read on public.project_contexts;
create policy context_member_read on public.project_contexts
  for select using (private.can_read_context(id));

drop policy if exists context_revocation_member_read on public.context_revocations;
create policy context_revocation_admin_read on public.context_revocations
  for select using (private.can_manage_context_revocations(context_id));

drop policy if exists quota_owner_read on public.quota_policies;
create policy quota_policy_admin_read on public.quota_policies
  for select using (private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

drop policy if exists immutable_object_member_read on public.immutable_objects;
create policy immutable_object_read on public.immutable_objects
  for select using (private.can_read_object(object_digest));

drop policy if exists release_artifact_member_read on public.hub_release_artifacts;
create policy release_artifact_read on public.hub_release_artifacts
  for select using (private.can_read_artifact(hub_id, release_digest, object_digest));

drop policy if exists source_credential_admin_read on public.source_credentials;
create policy source_credential_admin_read on public.source_credentials
  for select using (private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

drop policy if exists quota_admin_read on public.quota_usage;
create policy quota_usage_admin_read on public.quota_usage
  for select using (private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

drop policy if exists public_publication_read on public.public_hub_publications;
create policy public_publication_read on public.public_hub_publications
  for select using (private.can_read_hub(hub_id));

-- Grants: the runtime reads through `authenticated`; mutation stays with the
-- trusted service role. `anon` receives no table privileges at all.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on table
  public.personal_workspaces,
  public.hubs,
  public.hub_releases,
  public.hub_stable_pointers,
  public.security_denies,
  public.audit_events,
  public.workspace_memberships,
  public.projects,
  public.project_contexts,
  public.context_revocations,
  public.quota_policies,
  public.immutable_objects,
  public.hub_release_artifacts,
  public.source_credentials,
  public.quota_usage,
  public.public_hub_publications
to authenticated;
