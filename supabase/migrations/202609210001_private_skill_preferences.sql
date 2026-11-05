-- Private, per-subject skill preferences. Favorites and defaults contain IDs
-- only; skill bodies remain in the immutable release artifact.

do $$
declare
  migration_role_can_bypass_rls boolean;
begin
  select rolsuper or rolbypassrls into migration_role_can_bypass_rls
  from pg_roles where rolname = current_user;
  if not coalesce(migration_role_can_bypass_rls, false) then
    raise exception 'the migration owner must bypass RLS for the narrow SECURITY DEFINER writer';
  end if;
end
$$;

-- Roles are cluster-wide. Disposable CI/test databases on the same service
-- container may apply this migration independently. Reusing an existing role is
-- ONLY allowed when it passes rigorous least-privilege validation (fail closed):
-- no login/superuser/bypassrls/create/replication, noinherit, not a member of
-- any role, and no roles are members of it. This prevents granting EXECUTE on a
-- SECURITY DEFINER writer to an untrusted pre-existing role. Per-database grants
-- below are explicit and minimal.
do $$
declare
  r record;
  member_count bigint;
  member_of_count bigint;
begin
  select * into r from pg_roles where rolname = 'ega_skill_preferences_writer';
  if not found then
    create role ega_skill_preferences_writer nologin noinherit;
    select * into r from pg_roles where rolname = 'ega_skill_preferences_writer';
  else
    if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreatedb
       or r.rolcreaterole or r.rolreplication or r.rolinherit then
      raise exception 'ega_skill_preferences_writer exists with unsafe attributes; refusing to reuse';
    end if;
    select count(*) into member_count from pg_auth_members where roleid = r.oid;
    select count(*) into member_of_count from pg_auth_members where member = r.oid;
    if member_count > 0 or member_of_count > 0 then
      raise exception 'ega_skill_preferences_writer exists with role memberships; refusing to reuse';
    end if;
  end if;
end
$$;
-- Enforce known-safe attributes on the validated role only (no privilege escalation).
alter role ega_skill_preferences_writer
  nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

create or replace function private.is_canonical_skill_id_array(ids text[], max_items integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select ids is not null
    and coalesce(array_ndims(ids), 1) = 1
    and cardinality(ids) <= max_items
    and cardinality(ids) = (select count(distinct id) from unnest(ids) as item(id))
    and not exists (
      select 1 from unnest(ids) as item(id)
      where id is null or id !~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'
    );
$$;
revoke all on function private.is_canonical_skill_id_array(text[], integer) from public;

create table public.skill_preferences (
  workspace_id uuid not null references public.personal_workspaces(id) on delete cascade,
  subject text not null,
  favorite_skill_ids text[] not null default '{}'::text[],
  default_skill_ids text[] not null default '{}'::text[],
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, subject),
  constraint skill_preferences_favorites_valid
    check (private.is_canonical_skill_id_array(favorite_skill_ids, 5000)),
  constraint skill_preferences_defaults_valid
    check (private.is_canonical_skill_id_array(default_skill_ids, 3))
);

alter table public.skill_preferences enable row level security;
alter table public.skill_preferences force row level security;
create policy skill_preferences_owner_read on public.skill_preferences
  for select using (
    subject = auth.jwt() ->> 'sub'
    and private.has_workspace_role(workspace_id, array['owner']::text[])
  );
drop policy if exists delegated_oauth_containment on public.skill_preferences;
create policy delegated_oauth_containment on public.skill_preferences
  as restrictive for all to authenticated
  using ((auth.jwt() ->> 'client_id') is null)
  with check ((auth.jwt() ->> 'client_id') is null);

revoke all on public.skill_preferences from public, anon, authenticated, service_role;
grant select on public.skill_preferences to authenticated;
revoke all on schema private from ega_skill_preferences_writer;
grant usage on schema private to ega_skill_preferences_writer;

create or replace function private.write_skill_preferences(
  p_workspace_id uuid,
  p_subject text,
  p_favorite_skill_ids text[],
  p_default_skill_ids text[],
  p_expected_revision bigint
)
returns table (
  revision bigint,
  favorite_skill_ids text[],
  default_skill_ids text[],
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '2s'
as $$
begin
  if p_subject is null or length(p_subject) < 1 or length(p_subject) > 256
     or p_workspace_id is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid preference update';
  end if;
  if not private.is_canonical_skill_id_array(p_favorite_skill_ids, 5000)
     or not private.is_canonical_skill_id_array(p_default_skill_ids, 3) then
    raise exception using errcode = '22023', message = 'invalid preference IDs';
  end if;
  if not exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id
      and m.subject = p_subject
      and m.role = 'owner'
      and m.active
  ) then
    raise exception using errcode = '42501', message = 'active workspace owner required';
  end if;

  if p_expected_revision = 0 then
    insert into public.skill_preferences as current (
      workspace_id, subject, favorite_skill_ids, default_skill_ids, revision
    ) values (
      p_workspace_id, p_subject, p_favorite_skill_ids, p_default_skill_ids, 1
    ) on conflict (workspace_id, subject) do nothing
    returning current.revision, current.favorite_skill_ids,
              current.default_skill_ids, current.updated_at
    into revision, favorite_skill_ids, default_skill_ids, updated_at;
  else
    update public.skill_preferences as current
      set favorite_skill_ids = p_favorite_skill_ids,
          default_skill_ids = p_default_skill_ids,
          revision = current.revision + 1,
          updated_at = clock_timestamp()
      where current.workspace_id = p_workspace_id
        and current.subject = p_subject
        and current.revision = p_expected_revision
    returning current.revision, current.favorite_skill_ids,
              current.default_skill_ids, current.updated_at
    into revision, favorite_skill_ids, default_skill_ids, updated_at;
  end if;

  if not found then
    return;
  end if;
  return next;
end;
$$;
revoke all on function private.write_skill_preferences(uuid, text, text[], text[], bigint)
  from public, anon, authenticated, service_role;
grant execute on function private.write_skill_preferences(uuid, text, text[], text[], bigint)
  to ega_skill_preferences_writer;

comment on table public.skill_preferences is
  'Private skill IDs and optimistic revision per workspace subject; no skill content.';
comment on function private.write_skill_preferences(uuid, text, text[], text[], bigint) is
  'Atomic revision-checked preference write for the dedicated server-only writer role.';
