/** Real self-hosted API-key gateway + JWT-verified PostgREST + PostgreSQL.
 * Ephemeral local credentials; never claims hosted Supabase acceptance.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createSupabaseTelemetryWriter } from '../../packages/mcp/dist/index.js';
const url = process.env.EGA_TEST_GATEWAY_URL;
const apiKey = process.env.EGA_TEST_GATEWAY_KEY;
const secret = process.env.EGA_TEST_GATEWAY_SIGNER;
const database = process.env.EGA_PGCRON_DATABASE_URL;
if (!url || !apiKey || !secret || !database || new URL(url).hostname !== '127.0.0.1') throw new Error('Run only through the isolated gateway harness');
const observer = (sql) => execFileSync('psql', ['-X','-qAt','-v','ON_ERROR_STOP=1',database], { input: sql, encoding:'utf8', stdio:['pipe','pipe','pipe'] }).trim();
const jwt = (role, extra = {}) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({alg:'HS256',typ:'JWT'})}.${part({role,exp:Math.floor(Date.now()/1000)+300,...extra})}`;
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
};
const writerToken = jwt('ega_telemetry_writer');
const request = (path, method='GET', token=writerToken, key=apiKey, body) => fetch(`${url}/rest/v1/${path}`, {
  method, headers: { apikey:key, authorization:`Bearer ${token}`, 'content-type':'application/json', prefer:'return=minimal' }, ...(body ? {body:JSON.stringify(body)} : {}),
});
test('dedicated writer persists through separate application-key and role authorization', async () => {
  const workspace = observer('select id from public.personal_workspaces limit 1');
  const id = randomUUID();
  const record = { workspace_id:workspace,subject:'synthetic-gateway',execution_id:id,idempotency_key:id,tool:'search',latency_ms:1,result_class:'success',schema_version:1,observed_at:new Date().toISOString() };
  const writer = createSupabaseTelemetryWriter({
    supabaseUrl:'https://isolated.invalid',apiKey,writerToken,
    // Map only the external transport to the disposable self-hosted gateway.
    fetch: async (input, init) => {
      const response = await fetch(input.replace('https://isolated.invalid',url),init);
      if (!response.ok) {
        const error = await response.clone().json();
        console.info('SANITIZED_GATEWAY_FAILURE',JSON.stringify({status:response.status,code:/^[A-Z0-9]+$/.test(error.code) ? error.code : 'unknown',reason: /permission denied for table mcp_tool_executions/.test(error.message) ? 'telemetry table permission' : /row-level security/.test(error.message) ? 'RLS' : 'other'}));
      }
      return response;
    },
  });
  assert.equal((await request('mcp_tool_executions','POST',writerToken,apiKey,[{...record,idempotency_key:randomUUID()}])).status,201,'plain INSERT');
  await writer.writeExecution(record);
  assert.equal(writer.stats.written,1);
  assert.equal(observer(`select count(*) from public.mcp_tool_executions where idempotency_key='${id}' and id>0`),'1');
  for (const [path,method,body] of [
    ['mcp_tool_executions','GET'],
    [`mcp_tool_executions?idempotency_key=eq.${id}`,'PATCH',{latency_ms:0}],
    [`mcp_tool_executions?idempotency_key=eq.${id}`,'DELETE'],
    ['personal_workspaces','GET'],
    ['rpc/purge_expired_telemetry','POST',{retention_days:90}],
  ]) assert.equal((await request(path,method,writerToken,apiKey,body)).status,403,`${method} ${path}`);
  assert.equal((await request('mcp_tool_executions','POST',writerToken,'invalid-key',[record])).status,401);
  assert.equal((await request('mcp_tool_executions','POST',`${writerToken}invalid`,apiKey,[record])).status,401);
  for (const token of [jwt('authenticated',{sub:'t1-owner'}),jwt('authenticated',{sub:'t1-owner',client_id:'synthetic-delegated'})])
    assert.equal((await request('mcp_tool_executions','POST',token,apiKey,[{...record,idempotency_key:randomUUID()}])).status,403);
  assert.equal((await request('mcp_tool_executions','POST',writerToken,apiKey,[{...record,idempotency_key:randomUUID(),latency_ms:-1}])).status,400);
  assert.equal((await request('mcp_tool_executions','POST',writerToken,apiKey,[{...record,idempotency_key:randomUUID(),workspace_id:randomUUID()}])).status,409);
  assert.equal(observer(`select count(*) from public.mcp_tool_executions where idempotency_key='${id}' and latency_ms=1`),'1');
  await writer.writeExecution({...record,idempotency_key:randomUUID(),workspace_id:randomUUID()});
  assert.equal(writer.stats.failed,1,'foreign-key conflict is a failure');
  await writer.writeExecution(record);
  assert.equal(writer.stats.duplicate,1,'retry preserves one stored event');
  const invalidWriter = createSupabaseTelemetryWriter({supabaseUrl:'https://isolated.invalid',apiKey:'sb_publishable_invalid',writerToken,fetch:(input,init)=>fetch(input.replace('https://isolated.invalid',url),init)});
  await invalidWriter.writeExecution({...record,idempotency_key:randomUUID()});
  assert.equal(invalidWriter.stats.failed,1); assert.equal(invalidWriter.stats.written,0);
  console.info('SANITIZED_GATEWAY_EVIDENCE',JSON.stringify({gateway:'Kong 2.8.1',rest:'PostgREST 13.0.7',writer_role:'ega_telemetry_writer',persisted:1,invalid_auth:'rejected',reads_and_mutations:'denied',scope:'isolated self-hosted, not hosted Supabase'}));
});
