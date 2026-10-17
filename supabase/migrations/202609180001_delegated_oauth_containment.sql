-- Delegated OAuth token containment (release gate).
--
-- Supabase OAuth 2.1 access tokens carry a `client_id` claim and otherwise
-- behave like ordinary user tokens: role `authenticated`, the subject in
-- `sub`, and the table grants plus RLS policies below. The EGA MCP never
-- forwards user tokens to PostgREST — it resolves authorized contexts with
-- the server-side secret key — so a delegated token must not become an
-- accidental general-purpose read credential for the EGA control plane.
--
-- These RESTRICTIVE policies AND with every existing permissive policy, so a
-- delegated token reads zero control-plane rows while first-party sessions
-- (no `client_id` claim) keep their current behavior and the trusted service
-- role keeps bypassing RLS. `client_id` is used only for this database
-- boundary; it is never an EGA skill authorization decision.
--
-- Forward migration: 202609090004 and 202609090005 may already be applied
-- outside disposable CI.

do $$
declare
  target text;
begin
  foreach target in array array[
    'personal_workspaces',
    'hubs',
    'hub_releases',
    'hub_stable_pointers',
    'security_denies',
    'audit_events',
    'workspace_memberships',
    'projects',
    'project_contexts',
    'context_revocations',
    'quota_policies',
    'immutable_objects',
    'hub_release_artifacts',
    'source_credentials',
    'quota_usage',
    'public_hub_publications'
  ]
  loop
    execute format('drop policy if exists delegated_oauth_containment on public.%I', target);
    execute format(
      'create policy delegated_oauth_containment on public.%I as restrictive for all to authenticated '
      || 'using ((auth.jwt() ->> ''client_id'') is null) '
      || 'with check ((auth.jwt() ->> ''client_id'') is null)',
      target
    );
  end loop;
end
$$;

-- The platform's RLS auto-enable helper (when present) is provisioning
-- tooling, not an API. A delegated token must not be able to call it, and
-- neither should any other client role.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;
