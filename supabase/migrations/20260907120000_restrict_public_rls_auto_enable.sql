-- The hosted control plane must not expose a SECURITY DEFINER helper from the
-- public schema to anonymous or authenticated callers. Keep the function for
-- the platform until ownership is confirmed, but remove its default PUBLIC
-- execution grant before any application tables are introduced.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;
