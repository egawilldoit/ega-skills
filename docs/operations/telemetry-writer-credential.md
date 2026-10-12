# Telemetry writer credential (CONTRACT-T1 §5.3)

The telemetry writer needs a privileged key to insert into
`public.mcp_tool_executions`. CONTRACT-T1 §5.3 requires that credential to be
**distinct** from the runtime's read-only data-plane credential, and the runtime
enforces that: it will not start a writer that reuses the read key.

Enforcement lives in `packages/mcp/src/hosted-runtime.ts`, and
`tests/mcp/telemetry-config.test.mjs` covers it.

## Why the separation matters

With one shared secret, §5.3 is satisfied only on paper. Compromise of the
read path would also grant telemetry writes; revoking the read credential for a
read-path incident would silently stop telemetry; and an audit of "who can write
telemetry" would name the same principal that answers every catalog read. The
runtime treats a reused key as a misconfiguration: telemetry is disabled, a
sanitized warning naming only the variables is logged, and tools keep working
(CONTRACT-T1 §6.7 — telemetry is never a readiness precondition).

## Configuration

| Variable | Purpose | Required |
|---|---|---|
| `EGA_HOSTED_TELEMETRY_ENABLED` | Exact string `true` enables telemetry. Any other value — `1`, `yes`, `TRUE` — leaves it off, so a typo cannot switch on a writer that persists rows. | To enable |
| `EGA_HOSTED_TELEMETRY_WRITER_KEY` | The dedicated writer credential. Must differ from `EGA_HOSTED_SUPABASE_SECRET_KEY`. | To enable |
| `EGA_HOSTED_SUPABASE_URL` | Supabase project URL. Shared with reads. | To enable |
| `EGA_HOSTED_SUPABASE_SECRET_KEY` | Read-path credential, used for workspace attribution. | Already required for context resolution |

No credential values are recorded in this repository, in any example file, or in
any fixture.

## Provisioning

This is the part that cannot be done from the repository. What an operator must
do on the hosted project:

1. **Create the writer role.** A dedicated Postgres role with only the telemetry
   write grants, rather than a second copy of the service key:

   ```sql
   create role ega_telemetry_writer nologin;
   grant usage on schema public to ega_telemetry_writer;
   grant insert on public.mcp_tool_executions to ega_telemetry_writer;
   -- Deliberately NOT granted: select, update, delete, truncate.
   ```

   The table's RLS remains in force for this role; the writer is additionally
   gated by the policies in `202609200002`, so a compromised writer still cannot
   read another workspace's rows.

2. **Mint a key** bound to that role, and store it wherever the deployment keeps
   secrets. Do not reuse the read key.

3. **Set the environment** for the hosted MCP deployment:
   `EGA_HOSTED_TELEMETRY_ENABLED=true` and `EGA_HOSTED_TELEMETRY_WRITER_KEY=<key>`.

4. **Grant the scheduler its own authority.** `purge_expired_telemetry` is
   restricted to `service_role`; see `telemetry-retention.md`.

### Rotation

Rotate the writer key independently of the read key. Because they are separate
secrets, rotation of one does not affect the other — which is the operational
benefit of §5.3. A rotation is complete when a fresh key is deployed and the
runtime's `telemetry.failure_classes` contains no `write_failed`.

## What this repository proves, and what it does not

- **Proven here (E2, executed):** the runtime refuses a reused credential; it
  refuses a missing one; it refuses any value of the enable flag other than the
  exact string `true`; it starts and serves tools regardless; no credential value
  reaches the handle or a log line.
- **Not proven here:** that any hosted deployment has actually been provisioned
  with two distinct credentials, or that the writer role holds exactly the grants
  above. Both require observing a hosted instance. Until then, credential
  separation is **implemented and tested, not observed in a deployment**.

## Verifying separation on a deployed instance

```sql
-- The writer role exists and holds only the intended grants.
select grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_name = 'mcp_tool_executions'
 order by grantee, privilege_type;
```

Expect `service_role` (full) and `ega_telemetry_writer` (insert only). If the
deployed writer role shows `select`, the separation was not applied.

Then confirm the runtime reports itself enabled and the writer is not the read
key:

```bash
curl -s "$HOSTED_MCP/healthz" | jq
# and, on a handle exposing diagnostics:
# telemetry.enabled == true, with no "disabled" failure class
```