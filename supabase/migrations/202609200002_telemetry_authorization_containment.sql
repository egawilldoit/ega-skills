-- Contract T1 telemetry: authorization entry point, delegated containment, and
-- retention bound.
--
-- Forward migration. `202609200001_contract_t1_telemetry.sql` created
-- `mcp_tool_executions` and its policies, and those policies have three defects
-- that only surface against a real PostgreSQL:
--
--   1. `mcp_telemetry_self_read` called `private.is_active_member(workspace_id)`
--      directly. Migration `202609090005` revoked client EXECUTE on that helper
--      precisely so it could not be used as a membership oracle. A policy calling
--      it therefore raised `permission denied for function is_active_member`,
--      which fails the whole query — including for a subject who genuinely owns
--      their own telemetry row.
--   2. The table was never added to the delegated-OAuth containment list in
--      `202609180001`, so a delegated client token could read raw event rows
--      directly through PostgREST even when its subject belongs to the
--      workspace.
--   3. `purge_expired_telemetry` accepted an unbounded `retention_days`, so a
--      caller could configure retention beyond CONTRACT-T1's 90-day maximum.
--
-- None of these is repaired by editing `202609200001`: it may already be applied
-- outside disposable CI. This is additive and idempotent.

-- ---------------------------------------------------------------------------
-- 1. Authorization entry point
-- ---------------------------------------------------------------------------
--
-- The pattern is the one `202609090004` established for projects and contexts: a
-- `SECURITY DEFINER` entry point that calls the owner-only helper, with policies
-- referencing only the entry point. `SECURITY DEFINER` runs as the function
-- owner, so `private.is_active_member` is reached with the privileges its owner
-- has and RLS behavior inside it is unchanged. `anon` and `authenticated` still
-- cannot call `is_active_member` directly.
--
-- `search_path = ''` is not optional: every name inside is schema-qualified, so
-- an empty search path cannot be redirected by a caller-controlled schema.
--
-- The subject is taken from the verified JWT claim rather than passed in, so a
-- caller cannot ask the question for somebody else. This is deliberately the
-- same shape as `private.is_active_member`, which already binds subject from
-- `auth.jwt()` internally.
create or replace function private.can_read_own_telemetry(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_member(target_workspace_id);
$$;

comment on function private.can_read_own_telemetry(uuid) is
  'Entry point for the telemetry self-read policy. SECURITY DEFINER so the '
  'owner-only private.is_active_member can be reached without granting it to '
  'client roles, per 202609090005.';

-- The entry point is the only new client-callable surface, and it answers a
-- boolean about the caller''s own membership in one workspace. That is strictly
-- narrower than the helper it wraps: it exposes no deny table and no raw
-- membership row.
grant execute on function private.can_read_own_telemetry(uuid) to authenticated;
revoke execute on function private.can_read_own_telemetry(uuid) from anon, public;

-- Rebuild the policy to use the entry point. Semantics are unchanged: the row's
-- own `subject` must match the caller AND the caller must be an active member
-- of that workspace. Both halves still fail closed — an inactive member matches
-- neither, and a row belonging to another subject never matches the first.
drop policy if exists mcp_telemetry_self_read on public.mcp_tool_executions;
create policy mcp_telemetry_self_read on public.mcp_tool_executions
  for select to authenticated
  using (
    subject = (auth.jwt() ->> 'sub')
    and private.can_read_own_telemetry(workspace_id)
  );

-- The owner/admin policy used `private.has_workspace_role`, which
-- `202609090005` deliberately did NOT revoke — only `is_denied`,
-- `has_inactive_membership` and `is_active_member` were. It is therefore already
-- correct and is left alone. It is restated only as `to authenticated` so both
-- read policies are explicit about the role they apply to; a policy with no role
-- list also applies to `anon`, and telemetry rows must never be reachable
-- anonymously even before containment is applied.
drop policy if exists mcp_telemetry_admin_read on public.mcp_tool_executions;
create policy mcp_telemetry_admin_read on public.mcp_tool_executions
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['owner', 'admin']::text[]));

-- ---------------------------------------------------------------------------
-- 2. Delegated OAuth containment
-- ---------------------------------------------------------------------------
--
-- Identical RESTRICTIVE policy to every other control-plane table. RESTRICTIVE
-- policies AND with permissive ones, so a delegated token reads zero telemetry
-- rows while first-party sessions keep working and the service role still
-- bypasses RLS.
drop policy if exists delegated_oauth_containment on public.mcp_tool_executions;
create policy delegated_oauth_containment on public.mcp_tool_executions
  as restrictive for all to authenticated
  using ((auth.jwt() ->> 'client_id') is null)
  with check ((auth.jwt() ->> 'client_id') is null);

-- ---------------------------------------------------------------------------
-- 3. Retention bound
-- ---------------------------------------------------------------------------
--
-- CONTRACT-T1 §8 caps retention at 90 days. The previous signature accepted any
-- integer and clamped only at 1, so `purge_expired_telemetry(3650)` was a legal
-- call that retained ten years of events. The maximum is enforced here rather
-- than trusted to the caller, and a NULL or nonsense argument is clamped into
-- range instead of raising or deleting the whole table.
create or replace function public.purge_expired_telemetry(retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_days integer;
  deleted_count integer;
begin
  -- NULL (or a NULL-coalescing caller mistake) becomes the contract default; an
  -- out-of-range value is clamped. Nothing here can exceed 90 days or drop
  -- below 1, so the function can neither retain forever nor wipe the table.
  effective_days := least(greatest(coalesce(retention_days, 90), 1), 90);

  delete from public.mcp_tool_executions
  where observed_at < (now() - make_interval(days => effective_days));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Only the trusted writer/scheduler may invoke it. Client roles cannot purge
-- telemetry, which would otherwise be a way for any member to erase the
-- workspace's history and then read a clean-looking empty window.
revoke execute on function public.purge_expired_telemetry(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_telemetry(integer) to service_role;

comment on function public.purge_expired_telemetry(integer) is
  'Deletes telemetry older than retention_days, clamped to [1, 90] per CONTRACT-T1. '
  'Idempotent. Invoke from the platform scheduler with service_role.';

-- Writes stay with the service/writer role only. Stated explicitly because
-- `202609200001` granted SELECT to authenticated and the write privilege should
  -- never be widened by a later edit: an end-user session must not be able to
  -- insert, update or delete arbitrary telemetry rows.
revoke insert, update, delete on public.mcp_tool_executions from public, anon, authenticated;