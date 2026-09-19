-- Contract F helper least privilege. Migration 004 granted EXECUTE on every
-- authorization helper to `authenticated`, which turned implementation-only
-- helpers into directly callable metadata oracles: the deny table probe and
-- raw membership probes were invocable by any ordinary user.
--
-- Policies reach authorization only through the minimal entry-point helpers.
-- Implementation-only helpers keep owner-only execution: SECURITY DEFINER
-- entry points call them as the function owner, so RLS behavior is unchanged
-- while anon and authenticated lose direct access. This is a forward
-- migration because 004 may already be applied outside disposable CI.

-- The projects policy moves to the project-scoped entry point so the raw
-- membership probe is no longer needed by any policy.
drop policy if exists project_member_read on public.projects;
create policy project_member_read on public.projects
  for select using (private.can_read_project(id));

revoke all on function private.is_denied(uuid, text, text)
  from public, anon, authenticated;
revoke all on function private.has_inactive_membership(uuid)
  from public, anon, authenticated;
revoke all on function private.is_active_member(uuid)
  from public, anon, authenticated;
