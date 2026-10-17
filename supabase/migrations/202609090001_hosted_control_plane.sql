-- Hosted control-plane metadata.  Immutable HubRelease/SQLite/blob artifacts
-- stay outside this mutable database.  This migration is intentionally not
-- applied by the local build or this implementation session.
create table if not exists public.personal_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_subject text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.hubs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.personal_workspaces(id),
  visibility text not null default 'private' check (visibility in ('private', 'workspace', 'public')),
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table if not exists public.hub_releases (
  hub_id uuid not null references public.hubs(id),
  release_digest text not null check (release_digest ~ '^sha256:[0-9a-f]{64}$'),
  sqlite_artifact_digest text not null check (sqlite_artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  published_at timestamptz not null default now(),
  primary key (hub_id, release_digest)
);

create table if not exists public.hub_stable_pointers (
  hub_id uuid primary key references public.hubs(id),
  release_digest text not null,
  updated_at timestamptz not null default now(),
  foreign key (hub_id, release_digest) references public.hub_releases(hub_id, release_digest)
);

create table if not exists public.security_denies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.personal_workspaces(id),
  kind text not null check (kind in ('hub', 'release', 'skill', 'source', 'blob')),
  identity text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, identity)
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.personal_workspaces(id),
  actor_subject text not null,
  operation text not null,
  target_identity text,
  old_identity text,
  new_identity text,
  result text not null,
  request_id text,
  created_at timestamptz not null default now()
);

alter table public.personal_workspaces enable row level security;
alter table public.hubs enable row level security;
alter table public.hub_releases enable row level security;
alter table public.hub_stable_pointers enable row level security;
alter table public.security_denies enable row level security;
alter table public.audit_events enable row level security;

create policy personal_workspace_owner on public.personal_workspaces
  for all using (owner_subject = auth.jwt() ->> 'sub')
  with check (owner_subject = auth.jwt() ->> 'sub');

create policy hub_owner on public.hubs for all using (
  workspace_id in (select id from public.personal_workspaces where owner_subject = auth.jwt() ->> 'sub')
) with check (
  workspace_id in (select id from public.personal_workspaces where owner_subject = auth.jwt() ->> 'sub')
);

create policy hub_release_owner on public.hub_releases for select using (
  hub_id in (select h.id from public.hubs h join public.personal_workspaces w on w.id = h.workspace_id
    where w.owner_subject = auth.jwt() ->> 'sub')
);

create policy stable_pointer_owner on public.hub_stable_pointers for select using (
  hub_id in (select h.id from public.hubs h join public.personal_workspaces w on w.id = h.workspace_id
    where w.owner_subject = auth.jwt() ->> 'sub')
);

create policy security_deny_owner on public.security_denies for select using (
  workspace_id in (select id from public.personal_workspaces where owner_subject = auth.jwt() ->> 'sub')
);

create policy audit_owner on public.audit_events for select using (
  workspace_id in (select id from public.personal_workspaces where owner_subject = auth.jwt() ->> 'sub')
);
