-- Contract T1 §8 retention scheduling.
--
-- `202609200002` clamps `purge_expired_telemetry` to [1, 90] days and restricts
-- execution to `service_role`, but nothing ever CALLS it. Retention therefore
-- had a bound but no enforcement: rows past 90 days simply accumulated.
--
-- This migration installs the schedule. It is deliberately written so that:
--
--   - it is IDEMPOTENT — re-running replaces the schedule rather than adding a
--     second one, so a repeated migration cannot double the purge rate;
--   - it is SAFE on an instance without `pg_cron` — the extension is checked
--     for and the schedule is skipped with a NOTICE instead of failing the
--     migration, because telemetry retention must never block a deploy on a
--     platform that does not offer scheduling;
--   - it deletes telemetry ONLY — the body is a single statement against
--     `mcp_tool_executions`, and no other table is referenced.
--
-- ## Activation is still an operator action
--
-- This file creates the schedule ONCE APPLIED. It does not prove the schedule
-- runs: that requires the extension to be enabled on the target instance and a
-- real clock to pass. `docs/operations/telemetry-retention.md` records how to
-- verify it, and nothing may claim retention is operational until that check has
-- been observed.

-- Enable pg_cron when the platform offers it. On Supabase this is already
-- available to the `postgres` role; where it is not, `create extension` fails
-- harmlessly and the guard below turns that into a documented skip.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when insufficient_privilege or undefined_file then
      raise notice 'pg_cron present but not installable by this role; retention schedule NOT installed';
    end;
  else
    raise notice 'pg_cron unavailable on this instance; retention schedule NOT installed';
  end if;
end
$$;

do $$
declare
  jobid bigint;
  daily text := '17 3 * * *';  -- 03:17 UTC daily, deliberately off the hour
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'skipping retention schedule: pg_cron is not installed';
    return;
  end if;

  -- Idempotency: drop any previous schedule for this function before adding one.
  -- Selecting by jobname (not jobid) is what makes this safe to re-run — the
  -- jobid changes when the extension is reinstalled, so a stored id would
  -- silently orphan the old schedule and purge twice per day.
  for jobid in
    select jobid from cron.job where jobname = 'ega-telemetry-retention'
  loop
    perform cron.unschedule(jobid);
  end loop;

  -- `service_role` and `postgres` are the only roles with EXECUTE on the purge
  -- function (202609200002), so the schedule cannot be pointed at a role that
  -- would fail or, worse, that a client could assume.
  -- The statement uses a DIFFERENT dollar-quote tag than the surrounding DO
  -- block. Reusing the same tag inside terminated the block early and produced
  -- a syntax error, so the distinct tag is load-bearing rather than stylistic.
  perform cron.schedule(
    'ega-telemetry-retention',
    daily,
    $body$select service_role.public.purge_expired_telemetry(90);$body$
  );
end
$$;