/** Isolated self-hosted Kong/PostgREST acceptance; never hosted/production proof.
 * Requires an already provisioned disposable database. Docker runs loopback only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const database = process.env.EGA_PGCRON_DATABASE_URL;
if (!database || !['localhost','127.0.0.1'].includes(new URL(database).hostname)) throw new Error('A disposable loopback database is required');
const dir = mkdtempSync(join(tmpdir(), 'ega-gateway-'));
const suffix = randomBytes(5).toString('hex');
const rest = `ega-rest-${suffix}`, gateway = `ega-gateway-${suffix}`;
const restPort = 55448, gatewayPort = 55450;
const secret = randomBytes(32).toString('hex');
const appKey = `sb_publishable_${randomBytes(24).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const dbUrl = new URL(database); dbUrl.username = 'authenticator'; dbUrl.password = password;
const docker = (...args) => execFileSync('docker', args, { stdio: ['ignore','pipe','pipe'], encoding: 'utf8' }).trim();
try {
  execFileSync('psql', ['-X','-q','-v','ON_ERROR_STOP=1',database], {
    input: `alter role authenticator login password '${password}';`, stdio: ['pipe','ignore','pipe'],
  });
  writeFileSync(join(dir,'rest.env'), `PGRST_DB_URI=${dbUrl}\nPGRST_DB_SCHEMAS=public\nPGRST_DB_ANON_ROLE=anon\nPGRST_JWT_SECRET=${secret}\nPGRST_SERVER_HOST=127.0.0.1\nPGRST_SERVER_PORT=${restPort}\n`, { mode: 0o600 });
  writeFileSync(join(dir,'kong.yml'), `_format_version: '2.1'\nconsumers:\n  - username: isolated-application\n    keyauth_credentials:\n      - key: ${appKey}\nservices:\n  - name: isolated-rest\n    url: http://127.0.0.1:${restPort}\n    routes:\n      - name: rest\n        paths: [/rest/v1/]\n        strip_path: true\n    plugins:\n      - name: key-auth\n        config:\n          key_names: [apikey]\n          hide_credentials: true\n`, { mode: 0o600 });
  docker('run','-d','--name',rest,'--network','host','--env-file',join(dir,'rest.env'),'postgrest/postgrest:v13.0.7');
  docker('run','-d','--name',gateway,'--network','host','--user','0','-v',`${dir}:/isolated:ro`,'-e','KONG_DATABASE=off','-e','KONG_DECLARATIVE_CONFIG=/isolated/kong.yml','-e',`KONG_PROXY_LISTEN=127.0.0.1:${gatewayPort}`,'-e','KONG_ADMIN_LISTEN=off','kong:2.8.1');
  let ready = false;
  for (let i=0; i<80; i++) {
    try { const result = await fetch(`http://127.0.0.1:${gatewayPort}/rest/v1/`, { headers: { apikey: appKey } }); if (result.ok) { ready=true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Isolated gateway did not become ready');
  const result = spawnSync(process.execPath, ['--test','tests/rls/telemetry-gateway.rls.mjs'], {
    env: { ...process.env, EGA_TEST_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`, EGA_TEST_GATEWAY_KEY: appKey, EGA_TEST_GATEWAY_SIGNER: secret }, stdio:'inherit',
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch {
  // Docker configuration/errors may contain secrets. Never print raw output.
  console.error('Isolated gateway setup failed; no hosted acceptance claimed');
  process.exitCode=1;
} finally {
  for (const container of [gateway,rest]) { try { docker('rm','-f',container); } catch {} }
  execFileSync('psql',['-X','-q',database], { input: 'alter role authenticator nologin password null;', stdio:['pipe','ignore','pipe'] });
  rmSync(dir,{recursive:true,force:true});
}
