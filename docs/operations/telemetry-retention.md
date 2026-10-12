# MCP telemetry retention

CONTRACT-T1 §8 caps telemetry retention at 90 days. This document records what
is implemented, what is configured, what has actually been observed, and how to
verify each — because those are different claims and only one of them can be
established without a hosted environment.

## Status, stated precisely

| Layer | Status | Evidence |
|---|---|---|
| **Purge implementation** | **PROVEN** | `purge_expired_telemetry` exists, is clamped to [1, 90] days, is idempotent, and deletes only telemetry. 35/35 `tests/rls/telemetry-authz.rls.mjs` against real PostgreSQL 16. |
| **Scheduler configuration** | **PROVEN** | `202609200003_telemetry_retention_schedule.sql` installs a daily `pg_cron` job, idempotently. The migration applies cleanly on a real PostgreSQL and re-applies as a no-op. |
| **Schedule activation** | **BLOCKED** | Requires a hosted Supabase instance where `pg_cron` is installed. No such instance was reachable from the build environment. |
| **Observed scheduled execution** | **NOT OBSERVED** | Nothing may claim retention is operational until a real scheduled run has been seen deleting rows. |

The distinction matters: an installed schedule on a machine nobody has watched
is a configuration, not evidence.

## The clamp is enforced in the function, not trusted to the caller

`purge_expired_telemetry(retention_days integer default 90)` clamps its argument:

```sql
effective_days := least(greatest(coalesce(retention_days, 90), 1), 90);
```

So `purge_expired_telemetry(3650)` — ten years — is a legal call that retains 90
days. `NULL` resolves to the contract default rather than deleting the table.
Verified in `tests/rls/telemetry-authz.rls.mjs` against real PostgreSQL.

## Authority

Only `service_role` holds EXECUTE. Client roles — `authenticated`, `anon` — are
revoked. This is deliberate: a member who could invoke the purge could erase the
workspace's history and then read a clean-looking empty analytics window, which
would look like a tenant that never used the product.

## Verifying activation on a hosted instance

1. Confirm the extension and the job exist:

   ```sql
   select extname, extversion from pg_extension where extname = 'pg_cron';
   select jobid, jobname, schedule, command from cron.job
    where jobname = 'ega-telemetry-retention';
   ```

   Exactly one row. Two rows means the idempotent unschedule did not run — apply
   `202609200003` again.

2. Confirm recent history of the job:

   ```sql
   select jobid, runid, status, start_time, end_time
     from cron.job_run_details
    where jobid = (select jobid from cron.job where jobname = 'ega-telemetry-retention')
    order by start_time desc
    limit 10;
   ```

   `status = 0` is success in `pg_cron`. A non-zero status here is the signal to
   investigate; the job's own output is discarded, so a failing purge is silent
   apart from this table. That is a real limitation of relying on `pg_cron` and
   the reason to alert on row age rather than assume success.

3. Prove rows actually expire. Insert a deliberately old row, wait for the next
   03:17 UTC run, then confirm it is gone and a recent row is untouched:

   ```sql
   select count(*) filter (where observed_at < now() - interval '90 days') as expired,
          count(*) filter (where observed_at >= now() - interval '90 days') as retained
     from public.mcp_tool_executions;
   ```

   This is the only step that establishes *observed* execution. Until it has been
   run against a hosted instance, report retention as configured, not operating.

## Failure recovery

| Symptom | Cause | Action |
|---|---|---|
| No row in `cron.job` | `pg_cron` absent | Enable the extension, then re-apply `202609200003` |
| Two rows with the same name | Migration run outside the tracked path | Re-apply `202609200003`; it unschedules by name first |
| `status <> 0` in `job_run_details` | Purge raised | Run the statement by hand as `service_role` to surface the real error |
| Rows older than 90 days remain and the job looks healthy | Job runs but writes nothing | Confirm the job's role holds EXECUTE after any grant change |
| Analytics show zero but rows exist | Rows were purged, or the writer is failing | Check `HostedRuntimeHandle.telemetry` (`dropped`, `expired`, `failed`) before concluding usage fell |

## Monitoring

Alert on `max(observed_at)` age rather than on job status. A healthy-looking job
that deletes nothing is the failure this table cannot show, and row age is the
only signal that distinguishes the two.

## Recovery from an over-broad purge

Retention deletes; it does not archive. There is no undelete. If a purge ran with
a retention value beyond the contract maximum, the clamp in `202609200002`
prevents it going forward, but already-deleted rows cannot be recovered except
from a backup taken before the run.