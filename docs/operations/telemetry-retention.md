# Telemetry retention

CONTRACT-T1 §9.5 limits raw telemetry retention to 90 days. The purge function
clamps its argument to [1, 90], deletes telemetry only and is idempotent.

## Four separate claims

1. **Purge implementation:** migration `202609200002` clamps the bound and
   restricts EXECUTE to maintenance authority; client and dedicated writer roles
   cannot purge.
2. **Scheduler configuration:** `202609200004` is the forward repair. It replaces
   previously registered invalid commands and verifies command, database, active
   state and execution identity independently. The stored SQL is exactly
   `select public.purge_expired_telemetry(90);`.
3. **Installation:** only inspection of the identified environment's `cron.job`
   proves installation. A skipped migration does not install retention.
4. **Observed execution:** a successful scheduler-triggered run in
   `cron.job_run_details`, plus expired-row deletion and recent-row survival,
   proves execution in that environment. A direct function call does not.

The historical `202609200003` has minimal fresh-install corrections for ambiguous
PL/pgSQL variable resolution and its invalid function qualification. Those edits
alone cannot repair an already applied migration; the forward migration replaces
the existing job. Apply the complete chain using the authorized migration
operator. Setup requires an operator that can inspect all cron jobs, removes
all previously named jobs, and verifies exactly one intended job. A restricted
operator that cannot see other users' jobs is rejected, preventing hidden
duplicates from being mistaken for idempotent installation.

## Identity, activation and inactive state

pg_cron executes as the scheduling operator (`cron.job.username`), independently
of SQL schema qualification. Apply as the platform's authorized maintenance
operator, normally `postgres`, with EXECUTE on the purge. The migration verifies
that stored execution username equals the operator and database equals the
current database. No end-user, delegated or writer grants are added.

Enable/preload pg_cron using the platform-supported setup. Local stock PostgreSQL
requires `shared_preload_libraries=pg_cron` and a restart. pg_cron metadata belongs
to one database per cluster. This migration installs jobs in that database; an
unconfigured or other database emits an explicit **INACTIVE** notice. If pg_cron
is unavailable, not preloaded or not installed, retention is inactive. Migration
success in that state is not installation or operational retention. Disable
telemetry or arrange an authorized bounded purge until scheduling is available.

The production schedule is `17 3 * * *` (03:17 in the configured cron timezone;
verify UTC/GMT). Background-worker mode or a correctly configured local database
connection is required for jobs to start. Extension presence alone is insufficient.

## Sanitized verification

Run as the authorized maintenance observer:

```sql
select jobid, jobname, schedule, command, database, username, active
from cron.job where jobname = 'ega-telemetry-retention';

select jobid, runid, username, status, start_time, end_time
from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'ega-telemetry-retention')
order by runid desc limit 5;

select count(*) as expired_rows
from public.mcp_tool_executions
where observed_at < now() - interval '90 days';
```

Success is the text status `succeeded`, not numeric zero. Record job/run IDs and
start/end times, without telemetry rows or credentials. In an authorized isolated
test, seed expired and recent synthetic rows, execute the exact stored command
under its stored role, repeat setup, verify denied roles, then temporarily shorten
the schedule and observe a clock-triggered run. Restore the daily schedule.

`tests/rls/telemetry-scheduler.rls.mjs` executes this acceptance against a disposable
PostgreSQL 16 cluster with real pg_cron. `tests/rls/telemetry-authz.rls.mjs` tests
purge bounds, isolation and the explicit inactive setup path. CI runs both paths.
These establish local/CI evidence, not installation or execution in hosted
Supabase. Hosted retention acceptance remains open until an isolated project and
its actual scheduler run are identified in the implementation map.
