/** Real pg_cron acceptance. Requires a disposable cluster's cron metadata DB. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
const url = process.env.EGA_PGCRON_DATABASE_URL;
if (!url) throw new Error('EGA_PGCRON_DATABASE_URL must identify an isolated disposable cron database');
const sql = (text) => execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', url], { input: text, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
const migration = 'supabase/migrations/202609200004_telemetry_scheduler_repair.sql';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('migrations, exact stored command, idempotency, denied roles and scheduler-triggered purge', async () => {
  assert.equal(sql("select current_database() = current_setting('cron.database_name')"), 't');
  sql(readFileSync('tests/rls/bootstrap.sql', 'utf8'));
  for (const file of readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort())
    sql(readFileSync(`supabase/migrations/${file}`, 'utf8'));
  sql(readFileSync('tests/rls/telemetry-seed.sql', 'utf8'));
  // Simulate a previously applied migration's invalid registered command.
  sql("select cron.alter_job(jobid, command := 'select service_role.public.purge_expired_telemetry(90);') from cron.job where jobname = 'ega-telemetry-retention'");
  for (let i = 0; i < 2; i++) sql(readFileSync(migration, 'utf8'));
  const jobs = JSON.parse(sql("select json_agg(j) from (select jobid, username, database, command, schedule, active from cron.job where jobname = 'ega-telemetry-retention') j"));
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.command, 'select public.purge_expired_telemetry(90);');
  assert.equal(job.username, sql('select current_user'));
  assert.equal(job.database, sql('select current_database()'));
  assert.equal(job.schedule, '17 3 * * *'); assert.equal(job.active, true);
  const agedRow = (key) => sql(`insert into public.mcp_tool_executions (workspace_id,subject,execution_id,idempotency_key,tool,latency_ms,result_class,observed_at) select id,'synthetic','${key}','${key}','search',1,'success',now()-interval '91 days' from public.personal_workspaces limit 1`);
  agedRow('direct-expired');
  const recent = sql('select count(*) from public.mcp_tool_executions where observed_at > now()-interval \'90 days\'');
  // Execute the exact registered SQL as its actual role, not an alternate RPC.
  assert.equal(sql(`set role "${job.username}"; ${job.command} reset role;`), '1');
  assert.equal(sql("select count(*) from public.mcp_tool_executions where idempotency_key='direct-expired'"), '0');
  assert.equal(sql('select count(*) from public.mcp_tool_executions'), recent);
  for (const role of ['anon','authenticated','ega_telemetry_writer']) {
    assert.throws(() => sql(`set role ${role}; ${job.command}`), (error) => /permission denied/.test(String(error.stderr)));
  }
  // A delegated principal still has authenticated authority; claims do not grant purge.
  assert.throws(() => sql(`set role authenticated; set "request.jwt.claims"='{"role":"authenticated","client_id":"synthetic-client"}'; ${job.command}`), (e) => /permission denied/.test(String(e.stderr)));
  agedRow('scheduler-expired');
  const baseline = Number(sql('select coalesce(max(runid),0) from cron.job_run_details'));
  try {
    // Test-only frequency change. The production command and role stay unchanged.
    sql(`select cron.alter_job(${job.jobid}, schedule := '1 second')`);
    const deadline = Date.now() + 15000;
    let evidence;
    while (Date.now() < deadline) {
      const result = sql(`select row_to_json(r) from (select jobid,runid,username,status,start_time,end_time from cron.job_run_details where jobid=${job.jobid} and runid>${baseline} and status='succeeded' order by runid desc limit 1) r`);
      if (result) { evidence = JSON.parse(result); break; }
      await sleep(250);
    }
    assert.ok(evidence, 'a real scheduler-triggered successful run must be observed');
    assert.equal(evidence.username, job.username);
    assert.equal(sql("select count(*) from public.mcp_tool_executions where idempotency_key='scheduler-expired'"), '0');
    assert.equal(sql('select count(*) from public.mcp_tool_executions'), recent);
    console.info('SANITIZED_CRON_EVIDENCE', JSON.stringify(evidence));
  } finally {
    sql(readFileSync(migration, 'utf8'));
  }
  assert.equal(sql("select count(*) from cron.job where jobname='ega-telemetry-retention' and schedule='17 3 * * *'"), '1');
});
