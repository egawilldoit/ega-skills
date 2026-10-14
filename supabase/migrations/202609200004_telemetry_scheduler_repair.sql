-- Forward repair for instances which registered the original invalid command.
-- The historical migration also has two minimal bootstrap corrections so a
-- fresh pg_cron-enabled install can reach this forward migration.
-- pg_cron executes as the scheduling operator, separately from SQL qualification.
do $repair$
declare
  previous_job_id bigint;
  scheduled_job_id bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'retention INACTIVE: pg_cron is not installed; no schedule installed';
    return;
  end if;
  if current_user in ('anon', 'authenticated', 'ega_telemetry_writer')
     or not has_function_privilege(current_user, 'public.purge_expired_telemetry(integer)', 'EXECUTE') then
    raise exception 'retention setup requires an authorized maintenance operator';
  end if;
  if not exists (select 1 from pg_class c join pg_roles r on r.rolname = current_user
    where c.oid = 'cron.job'::regclass and (c.relowner = r.oid or r.rolsuper or r.rolbypassrls)) then
    raise exception 'retention setup requires administrative visibility of all jobs';
  end if;
  for previous_job_id in
    select j.jobid from cron.job as j where j.jobname = 'ega-telemetry-retention'
  loop
    perform cron.unschedule(previous_job_id);
  end loop;
  scheduled_job_id := cron.schedule(
    'ega-telemetry-retention', '17 3 * * *',
    'select public.purge_expired_telemetry(90);'
  );
  if not exists (
    select 1 from cron.job as j where j.jobid = scheduled_job_id
      and j.username = current_user and j.database = current_database()
      and j.active and j.command = 'select public.purge_expired_telemetry(90);'
  ) then
    raise exception 'retention execution identity or command verification failed';
  end if;
  if (select count(*) from cron.job j where j.jobname = 'ega-telemetry-retention') <> 1 then
    raise exception 'retention setup did not leave exactly one intended job';
  end if;
  raise notice 'retention schedule configured as maintenance operator %; execution not yet observed', current_user;
end
$repair$;
