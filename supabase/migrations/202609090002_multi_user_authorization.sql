create table if not exists public.workspace_memberships (
  workspace_id uuid not null references public.personal_workspaces(id),
  subject text not null,
  role text not null check (role in ('owner', 'admin', 'maintainer', 'member', 'viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (workspace_id, subject)
);

-- Ownership transfer is an explicit control-plane transaction; never allow
-- two simultaneous owner authorities for one workspace.
create unique index if not exists workspace_memberships_one_owner
  on public.workspace_memberships (workspace_id) where role = 'owner';

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.personal_workspaces(id),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.project_contexts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  context_digest text not null unique check (context_digest ~ '^sha256:[0-9a-f]{64}$'),
  release_digest text not null check (release_digest ~ '^sha256:[0-9a-f]{64}$'),
  revoked_at timestamptz,
  published_at timestamptz not null default now()
);

create table if not exists public.context_revocations (
  context_id uuid primary key references public.project_contexts(id),
  reason text not null,
  revoked_by text not null,
  revoked_at timestamptz not null default now()
);

create table if not exists public.quota_policies (
  workspace_id uuid primary key references public.personal_workspaces(id),
  requests_per_minute integer not null check (requests_per_minute > 0),
  concurrent_requests integer not null check (concurrent_requests > 0),
  bandwidth_bytes bigint not null check (bandwidth_bytes > 0)
);

alter table public.workspace_memberships enable row level security;
alter table public.projects enable row level security;
alter table public.project_contexts enable row level security;
alter table public.context_revocations enable row level security;
alter table public.quota_policies enable row level security;

create policy membership_self_or_owner on public.workspace_memberships for select using (
  subject = auth.jwt() ->> 'sub' or workspace_id in (
    select workspace_id from public.workspace_memberships where subject = auth.jwt() ->> 'sub' and role in ('owner', 'admin') and active
  )
);
create policy project_member_read on public.projects for select using (
  workspace_id in (select workspace_id from public.workspace_memberships where subject = auth.jwt() ->> 'sub' and active)
);
create policy context_member_read on public.project_contexts for select using (
  project_id in (select p.id from public.projects p join public.workspace_memberships m on m.workspace_id = p.workspace_id
    where m.subject = auth.jwt() ->> 'sub' and m.active)
);
create policy context_revocation_member_read on public.context_revocations for select using (
  context_id in (select c.id from public.project_contexts c join public.projects p on p.id = c.project_id
    join public.workspace_memberships m on m.workspace_id = p.workspace_id where m.subject = auth.jwt() ->> 'sub' and m.active)
);
create policy quota_owner_read on public.quota_policies for select using (
  workspace_id in (select workspace_id from public.workspace_memberships where subject = auth.jwt() ->> 'sub' and role in ('owner', 'admin') and active)
);
