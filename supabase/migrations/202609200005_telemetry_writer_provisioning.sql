-- CONTRACT-T1 §5: trusted server writer, INSERT only, with RLS enforced.
-- Signed role JWT issuance is an operator action; no signing key goes to runtime.
do $provision$
begin
  if not exists (select 1 from pg_roles where rolname = 'ega_telemetry_writer') then
    create role ega_telemetry_writer nologin;
  end if;
  alter role ega_telemetry_writer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  -- An inherited role could silently widen this authority.
  if exists (select 1 from pg_auth_members where member = 'ega_telemetry_writer'::regrole) then
    raise exception 'writer must not inherit any role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    if (select rolinherit from pg_roles where rolname = 'authenticator') then
      raise exception 'authenticator must be NOINHERIT before writer provisioning';
    end if;
    grant ega_telemetry_writer to authenticator;
  end if;
end
$provision$;

grant usage on schema public to ega_telemetry_writer;
revoke all on public.mcp_tool_executions from ega_telemetry_writer;
grant insert on public.mcp_tool_executions to ega_telemetry_writer;
revoke all on sequence public.mcp_tool_executions_id_seq from ega_telemetry_writer;
grant usage on sequence public.mcp_tool_executions_id_seq to ega_telemetry_writer;
revoke execute on function public.purge_expired_telemetry(integer) from ega_telemetry_writer;

drop policy if exists mcp_telemetry_writer_insert on public.mcp_tool_executions;
create policy mcp_telemetry_writer_insert on public.mcp_tool_executions
  for insert to ega_telemetry_writer with check (true);
-- The authority is the signed database role, not a browser-supplied subject.
-- Existing foreign keys and checks validate rows; the server derives attribution.
-- No SELECT policy, UPDATE policy, or DELETE policy applies to this role.

do $verify$
declare
  relation record;
begin
  if has_schema_privilege('ega_telemetry_writer', 'public', 'CREATE') then
    raise exception 'writer must not have schema CREATE authority';
  end if;
  if pg_has_role('authenticated', 'ega_telemetry_writer', 'MEMBER')
     or pg_has_role('anon', 'ega_telemetry_writer', 'MEMBER') then
    raise exception 'client roles must not be able to assume writer authority';
  end if;
  for relation in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and c.oid <> 'public.mcp_tool_executions'::regclass
  loop
    if has_table_privilege('ega_telemetry_writer', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'writer has unrelated table authority; remove explicit or PUBLIC grants before provisioning';
    end if;
  end loop;
  for relation in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and c.oid <> 'public.mcp_tool_executions_id_seq'::regclass
  loop
    if has_sequence_privilege('ega_telemetry_writer', relation.oid, 'USAGE,SELECT,UPDATE') then
      raise exception 'writer has unrelated sequence authority';
    end if;
  end loop;
  if has_table_privilege('ega_telemetry_writer', 'public.mcp_tool_executions', 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_function_privilege('ega_telemetry_writer', 'public.purge_expired_telemetry(integer)', 'EXECUTE') then
    raise exception 'writer authority exceeds INSERT';
  end if;
end
$verify$;
