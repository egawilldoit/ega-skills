-- Telemetry authorization fixture.
--
-- Two workspaces, distinct subjects and roles, so the telemetry RLS tests can
-- distinguish every case the contract cares about:
--
--   workspace A ("t1-owner" owns it)
--     - t1-owner     owner,  active    -> sees own rows and all of A
--     - t1-admin     admin,  active    -> sees all of A
--     - t1-viewer    viewer, active    -> sees only its own row
--     - t1-inactive  admin,  INACTIVE  -> sees nothing, including its own row
--   workspace B ("t1-stranger" owns it)
--     - t1-stranger  owner,  active    -> sees only B
--
-- `t1-inactive` is deliberately an admin rather than an owner: a second owner
-- row in the same workspace would violate `workspace_memberships_one_owner`.
-- Admin still exercises "an inactive membership grants nothing", because the
-- entry point requires `active` regardless of role.
--
-- Telemetry rows mirror the subjects, so every policy branch has a row to
-- decide about. `t1-inactive` gets a row on purpose: the self-read policy must
-- still refuse it, which is only provable if the row exists.
do $$
declare
  owner_ws uuid := gen_random_uuid();
  other_ws uuid := gen_random_uuid();
begin
  insert into public.personal_workspaces (id, owner_subject) values
    (owner_ws, 't1-owner'),
    (other_ws, 't1-stranger');

  insert into public.workspace_memberships (workspace_id, subject, role, active) values
    (owner_ws,  't1-owner',    'owner',  true),
    (owner_ws,  't1-admin',    'admin',  true),
    (owner_ws,  't1-viewer',   'viewer', true),
    (owner_ws,  't1-inactive', 'admin',  false),
    (other_ws,  't1-stranger', 'owner',  true);

  insert into public.mcp_tool_executions
    (workspace_id, subject, execution_id, idempotency_key, tool, latency_ms, result_class)
  values
    (owner_ws, 't1-owner',    'e-owner',    'k-owner',    'search',  12, 'success'),
    (owner_ws, 't1-owner',    'e-owner-2',  'k-owner-2',  'inspect',  9, 'success'),
    (owner_ws, 't1-admin',    'e-admin',    'k-admin',    'search',  15, 'error'),
    (owner_ws, 't1-viewer',   'e-viewer',   'k-viewer',   'resolve',  7, 'success'),
    (owner_ws, 't1-inactive', 'e-inactive', 'k-inactive', 'search',   5, 'success'),
    (other_ws, 't1-stranger', 'e-stranger', 'k-stranger', 'search',   4, 'success');
end
$$;