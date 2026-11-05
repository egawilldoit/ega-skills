# EGA-824 private skill preferences

## Data and access model

`public.skill_preferences` stores one row per `(workspace_id, subject)`. The
row contains canonical favorite IDs, up to three distinct default IDs, an
optimistic `revision`, and `updated_at`. It contains no skill content. IDs are
checked for canonical form and duplicates in PostgreSQL. RLS is enabled and
forced; authenticated callers can select only their own row while they hold an
active Owner membership. The table grants no insert, update, or delete to
`anon`, `authenticated`, or `service_role`.

The Console resolves the subject from the caller's bearer session and checks
active Owner membership using caller-scoped Supabase reads. New default IDs
must be in the verified current release catalog after the caller passes the
current release access check. Existing IDs can be removed without catalog
availability or current-release authorization. Writes call
`private.write_skill_preferences` using a dedicated server-only PostgreSQL
login. Its NOLOGIN role can execute only that function; it has no table
privileges.

**Precise trust boundaries (do not overstate):** the database function
independently checks that the *target* `p_subject` has active Owner membership
for `p_workspace_id`, enforces structural ID rules/distinctness/count limits,
and enforces optimistic revision/concurrency. It **cannot** independently
validate the HTTP session identity — the API/BFF must pass only the
authenticated caller's subject (a trusted writer identity boundary). The
database does **not** independently validate catalog membership; the API
validates newly added default IDs against the authorized current-release
catalog. Schema note: `workspace_memberships` enforces one owner role per
workspace. The function changes a row only when the revision matches, so
competing edits have one winner and stale writers receive HTTP 409.

PostgREST cannot call the writer function as `anon`, `authenticated`, or
`service_role`, and those roles have no direct table mutation grants. Do not
grant the writer role to a browser or PostgREST role. Do not use the Supabase
service-role secret as the Console write credential.

## API contract

Both routes are under `/api/skill-preferences` and require a valid authenticated
Console session.

* `GET ?workspace_id=<uuid>` returns `revision`, `favorite_skill_ids`,
  `default_skill_ids`, and `updated_at`. A workspace with no stored row returns
  revision `0`, empty arrays, and `updated_at: null`.
* `PUT` accepts exactly `workspace_id`, `expected_revision`,
  `favorite_skill_ids`, and `default_skill_ids`. It replaces both arrays and
  returns the stored record. The browser cannot supply a subject. A stale
  expected revision returns `409 E_WEB_PREFERENCES_CONFLICT`.
* Invalid IDs, duplicates, or more than three defaults return 400. Missing or
  inactive Owner membership returns 403; an invalid session follows the
  existing authenticated-read 401 contract.

Favorites are limited to 5,000 distinct canonical IDs and defaults to three.
The database enforces canonical form and distinctness on both arrays, and the
default count independently of the API.

## Deployment and least privilege

1. Apply `202609210001_private_skill_preferences.sql` through the approved
   deployment migration process, with the normal privileged migration identity.
   It is not safe to apply this migration to production as part of this PR.
2. Create a dedicated PostgreSQL LOGIN for the Console server and grant it
   membership in `ega_skill_preferences_writer`. Keep the login out of
   `anon`, `authenticated`, and `service_role`; verify it can execute only
   `private.write_skill_preferences` and has no table read or mutation rights.
   Provision and rotate its password through the deployment secret manager.
3. Set `EGA_SKILL_PREFERENCES_DATABASE_URL` only in the server runtime. It must
   use TLS with certificate verification and must never use a `VITE_` variable
   or be sent to the browser. No privileged credential is added to the client.
4. Verify the deployed database grants, forced RLS policy, one allowed writer
   function, and the focused authorization/concurrency checks before enabling
   writes.

The migration creates a NOLOGIN, NOINHERIT role and does not create a LOGIN or
set any password. Runtime login provisioning remains an operator-owned secret
operation. The function is SECURITY DEFINER and must remain owned by the
privileged migration owner that can inspect membership rows despite RLS. The
login role receives only the function's EXECUTE privilege through its granted
membership; it receives no direct table grant.

## Rollback

First remove the runtime URL and stop preference writes. Revoke the writer role
from the actual deployment login and remove that login/password through the
deployment secret process. Then, using the migration owner, run the following
in order (the login name shown is the recommended deployment role name). **Do
not drop `ega_skill_preferences_writer` if the cluster/database role may be
shared by other databases or has unexpected members/grants**; it is cluster-wide
and the migration reuses it only after strict least-privilege validation.

```sql
REVOKE ega_skill_preferences_writer FROM ega_skill_preferences_runtime; -- deployment login, if present
DROP TABLE IF EXISTS public.skill_preferences;
DROP FUNCTION IF EXISTS private.write_skill_preferences(uuid, text, text[], text[], bigint);
DROP FUNCTION IF EXISTS private.is_canonical_skill_id_array(text[], integer);
REVOKE ALL ON SCHEMA private FROM ega_skill_preferences_writer;
-- Inspect before dropping the cluster-wide role:
-- SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='ega_skill_preferences_writer';
-- SELECT * FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='ega_skill_preferences_writer';
-- DROP ROLE ega_skill_preferences_writer; -- only when confirmed safe/not shared
```

Dropping the table deletes saved preferences. There is no cascade in this
rollback; unexpected dependencies must be reviewed instead of dropped
automatically. This rollback is documentation only and has not been run against
any hosted database.
