-- Immutable data-plane inventory and publication metadata.  Objects remain
-- content-addressed and are never deleted by this migration.
create table if not exists public.immutable_objects (
  object_digest text primary key check (object_digest ~ '^sha256:[0-9a-f]{64}$'),
  object_kind text not null check (object_kind in ('hub_release', 'sqlite', 'content_blob', 'project_context')),
  byte_length bigint not null check (byte_length >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.hub_release_artifacts (
  hub_id uuid not null,
  release_digest text not null,
  artifact_kind text not null check (artifact_kind in ('release', 'sqlite')),
  object_digest text not null references public.immutable_objects(object_digest),
  created_at timestamptz not null default now(),
  primary key (hub_id, release_digest, artifact_kind),
  foreign key (hub_id, release_digest) references public.hub_releases(hub_id, release_digest)
);

-- Only opaque secret-manager references belong in the control plane.  Secret
-- values and provider credentials remain outside Postgres and the runtime.
create table if not exists public.source_credentials (
  workspace_id uuid not null references public.personal_workspaces(id),
  source_id text not null,
  secret_reference text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (workspace_id, source_id),
  check (secret_reference <> '')
);

create table if not exists public.quota_usage (
  workspace_id uuid not null references public.personal_workspaces(id),
  window_started timestamptz not null,
  request_count bigint not null default 0 check (request_count >= 0),
  bandwidth_bytes bigint not null default 0 check (bandwidth_bytes >= 0),
  primary key (workspace_id, window_started)
);

create table if not exists public.public_hub_publications (
  hub_id uuid primary key references public.hubs(id),
  publisher_subject text not null,
  policy_version text not null,
  published_at timestamptz not null default now()
);

alter table public.immutable_objects enable row level security;
alter table public.hub_release_artifacts enable row level security;
alter table public.source_credentials enable row level security;
alter table public.quota_usage enable row level security;
alter table public.public_hub_publications enable row level security;

-- Runtime reads are authorized through the owning workspace graph.  Writes
-- are intentionally left to the trusted publisher/service role.
create policy immutable_object_member_read on public.immutable_objects for select using (
  exists (
    select 1
    from public.hub_release_artifacts a
    join public.hubs h on h.id = a.hub_id
    join public.workspace_memberships m on m.workspace_id = h.workspace_id
    where a.object_digest = immutable_objects.object_digest
      and m.subject = auth.jwt() ->> 'sub' and m.active
  )
);

create policy release_artifact_member_read on public.hub_release_artifacts for select using (
  exists (
    select 1
    from public.hubs h
    join public.workspace_memberships m on m.workspace_id = h.workspace_id
    where h.id = hub_release_artifacts.hub_id
      and m.subject = auth.jwt() ->> 'sub' and m.active
  )
);

create policy source_credential_admin_read on public.source_credentials for select using (
  exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = source_credentials.workspace_id
      and m.subject = auth.jwt() ->> 'sub'
      and m.role in ('owner', 'admin') and m.active
  )
);

create policy quota_admin_read on public.quota_usage for select using (
  exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = quota_usage.workspace_id
      and m.subject = auth.jwt() ->> 'sub'
      and m.role in ('owner', 'admin') and m.active
  )
);

create policy public_publication_read on public.public_hub_publications for select using (
  exists (select 1 from public.hubs h where h.id = public_hub_publications.hub_id and h.visibility = 'public')
  or exists (
    select 1 from public.hubs h
    join public.workspace_memberships m on m.workspace_id = h.workspace_id
    where h.id = public_hub_publications.hub_id
      and m.subject = auth.jwt() ->> 'sub' and m.active
  )
);
