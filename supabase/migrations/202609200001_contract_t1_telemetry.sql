-- Contract T1: MCP Read-Path Usage Telemetry
--
-- Dedicated, mutable, append-oriented model owned by the control plane.
-- Strictly separate from immutable data-plane artifacts.
-- Permitted fields only, RLS-enforced read access, service-role write only.

create table if not exists public.mcp_tool_executions (
  id bigserial primary key,
  workspace_id uuid not null references public.personal_workspaces(id) on delete cascade,
  subject text not null,
  request_id text,
  execution_id text not null,
  idempotency_key text not null unique,
  tool text not null check (tool in ('search', 'resolve', 'inspect', 'get_content')),
  release_digest text check (release_digest is null or release_digest ~ '^sha256:[0-9a-f]{64}$'),
  latency_ms integer not null check (latency_ms >= 0),
  result_class text not null check (result_class in ('success', 'error', 'denied', 'rate_limited')),
  error_class text,
  rate_limit_result text,
  auth_decision text,
  request_bytes integer check (request_bytes is null or request_bytes >= 0),
  response_bytes integer check (response_bytes is null or response_bytes >= 0),
  result_count integer check (result_count is null or result_count >= 0),
  content_level text check (content_level is null or content_level in ('L1', 'L2', 'companion')),
  telemetry_failure_class text,
  schema_version integer not null default 1,
  observed_at timestamptz not null default now()
);

-- RLS: enabled, write-prohibited for client roles, read-scoped by workspace and subject
alter table public.mcp_tool_executions enable row level security;

-- Admin/owner can read all telemetry within their workspace
drop policy if exists mcp_telemetry_admin_read on public.mcp_tool_executions;
create policy mcp_telemetry_admin_read on public.mcp_tool_executions
  for select using (private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

-- Active members can read their own telemetry rows
drop policy if exists mcp_telemetry_self_read on public.mcp_tool_executions;
create policy mcp_telemetry_self_read on public.mcp_tool_executions
  for select using (
    subject = auth.jwt() ->> 'sub'
    and private.is_active_member(workspace_id)
  );

-- Indexes for time-series queries and funnel aggregation
create index if not exists idx_mcp_tool_executions_ws_observed
  on public.mcp_tool_executions (workspace_id, observed_at desc);

create index if not exists idx_mcp_tool_executions_funnel
  on public.mcp_tool_executions (workspace_id, tool, result_class);

-- Retention: 90-day maximum retention purge function
create or replace function public.purge_expired_telemetry(retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  delete from public.mcp_tool_executions
  where observed_at < (now() - (greatest(retention_days, 1) || ' days')::interval);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

grant select on public.mcp_tool_executions to authenticated;
grant execute on function public.purge_expired_telemetry(integer) to service_role;
revoke execute on function public.purge_expired_telemetry(integer) from authenticated, anon, public;
