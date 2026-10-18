#!/usr/bin/env node
/**
 * Catalog bootstrap: register the reviewed release in the hosted control plane.
 *
 * ## Why this exists
 *
 * The console's release routes are gated by `authorizeArtifactRequest`
 * (`apps/web/server/api.ts`), which reads `public.hub_releases` under the
 * **caller's own** RLS and refuses with
 * `403 E_WEB_CONTROL_PLANE_FORBIDDEN` when the deployed release digest is not
 * readable. That gate is intended (EGA-719). What did not exist is any supported
 * way to put the first row in: nothing in `packages/` or `apps/` writes `hubs` or
 * `hub_releases`, and the schema grants `authenticated` SELECT only, so the
 * registration is by definition a trusted-publisher (service-role) operation.
 *
 * This script is that operation, and nothing else. It:
 *
 *  1. **verifies the committed artifact** through the one existing authority
 *     (`loadHostedReleaseSnapshot` — the same loader the console's
 *     release-identity check and the deployment staging step use), so the digest
 *     it registers is the digest the deployment serves;
 *  2. takes the **workspace** and the **hub UUID** as explicit operator inputs,
 *     because the artifact's own `hub_id` is the opaque string `"personal"` and
 *     `public.hubs.id` is a `uuid` — there is no mapping to derive;
 *  3. **prepares one transaction** that registers a `private` hub and the release;
 *  4. **never overwrites**. The writes are append-only (`on conflict do
 *     nothing`) and the authoritative identity check runs **inside** the same
 *     transaction, after the inserts and under row locks, so a conflicting
 *     concurrent writer cannot leave a registration attached to the wrong
 *     workspace, visibility or SQLite digest. There is no `update` and no
 *     `delete` in the forward transaction;
 *  5. records a **small execution receipt** of what *this* execution actually
 *     inserted, and generates the rollback from that receipt — so a rollback can
 *     never delete a row the bootstrap merely reused;
 *  6. keeps a **dependency-aware rollback** that removes only what the receipt
 *     claims, child before parent, and refuses if anything else depends on it.
 *
 * ## It prepares by default; it executes only when asked
 *
 * With no `--apply`, the script contacts no database and prints the exact
 * transaction for review. `--apply` and `--rollback` need `--receipt <path>` and
 * read the connection string from `EGA_BOOTSTRAP_DATABASE_URL`.
 *
 * ## Credentials
 *
 * The connection string is **never** an argument and never reaches a child's
 * argv. It is decomposed into libpq's own environment variables
 * (`PGHOST`/`PGUSER`/`PGPASSWORD`/…), which are set on the child process only;
 * inherited `PG*` variables are cleared first so a stray `.pgpass`/`PGPASSWORD`
 * cannot redirect the connection. Reported failures are bounded and sanitised:
 * the URL, the password and any DSN-shaped or `password=` text are redacted, and
 * only a known `E_BOOTSTRAP_*` code is preserved.
 *
 * ## What it deliberately does not do
 *
 * No schema, policy, grant or role change, and no write to
 * `hub_stable_pointers`, `immutable_objects`, `hub_release_artifacts`,
 * `public_hub_publications` or `audit_events` — those tables have no writer
 * anywhere in the repository and inventing one here would be a different change
 * with its own review. The rollback treats any such row as a dependency.
 *
 * Usage:
 *   node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid>
 *   node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> --receipt <file> --apply
 *   node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> --receipt <file> --rollback
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* -------------------------------------------------------------------------- */
/* Repository root and the one release-identity authority                      */
/* -------------------------------------------------------------------------- */

/** Discover the repository root regardless of the runner's cwd. */
function findRepoRoot() {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

const REPO_ROOT = findRepoRoot();

/** The committed release artifact. A deployment copies this; it never rebuilds it. */
export const DEFAULT_ARTIFACT_DIR = join(REPO_ROOT, "packages", "mcp", "artifact");

/** Largest acceptable input length, so an absurd argument is refused early. */
const MAX_ARG_LENGTH = 512;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RELEASE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The only visibility this script writes. See {@link planBootstrap}. */
export const BOOTSTRAP_VISIBILITY = "private";

/** Version of the on-disk execution receipt this build reads and writes. */
export const RECEIPT_VERSION = 1;

/** Files a release cannot be verified without. Mirrors the staging verifier. */
const REQUIRED_ARTIFACT_FILES = [
  "hub-release.json",
  "release-package.json",
  "registry.sqlite",
  "candidate.json",
  "alias-map.json",
  "publication-preflight.json",
];

/** A refusal that names a stable code and never carries a secret. */
export class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new BootstrapError(code, message);
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

async function loadReleaseLoader() {
  const entry = join(REPO_ROOT, "packages", "mcp", "dist", "index.js");
  if (!existsSync(entry)) {
    const built = spawnSync("pnpm", ["exec", "tsc", "-b"], { cwd: REPO_ROOT, stdio: "inherit" });
    if (built.status !== 0) {
      refuse("E_BOOTSTRAP_BUILD_FAILED", "the domain packages could not be built before verification");
    }
  }
  const module = await import(pathToFileURL(entry).href);
  return module.loadHostedReleaseSnapshot;
}

/**
 * Verify a release artifact and return the identity a registration must carry.
 *
 * All authority stays in `loadHostedReleaseSnapshot`: envelope digest, the
 * declared SQLite byte digest, SQLite integrity, the release projection, and blob
 * presence. This function only reads the two declared digests back out so the
 * operator can see exactly what will be registered.
 */
export async function verifyReviewedRelease(dir) {
  const resolved = isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    refuse("E_BOOTSTRAP_ARTIFACT_MISSING", `${resolved} is not a directory`);
  }
  const missing = REQUIRED_ARTIFACT_FILES.filter((name) => !existsSync(join(resolved, name)));
  if (missing.length > 0) {
    refuse(
      "E_BOOTSTRAP_ARTIFACT_INCOMPLETE",
      `${resolved} is missing required files: ${missing.join(", ")}`,
    );
  }

  const loadHostedReleaseSnapshot = await loadReleaseLoader();
  let snapshot;
  try {
    snapshot = loadHostedReleaseSnapshot(resolved);
  } catch (error) {
    refuse(
      "E_BOOTSTRAP_ARTIFACT_INVALID",
      `the reviewed artifact did not verify: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let declared;
  try {
    declared = JSON.parse(readFileSync(join(resolved, "release-package.json"), "utf8"));
  } catch (error) {
    refuse(
      "E_BOOTSTRAP_ARTIFACT_INVALID",
      `release-package.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const hubReleaseDigest = snapshot.releaseDigest;
  const sqliteArtifactDigest = declared?.sqlite_artifact_digest;
  const declaredRows = declared?.snapshot_rows;
  const skillCount = Object.keys(snapshot.release.payload.skill_versions ?? {}).length;

  if (!RELEASE_DIGEST_PATTERN.test(String(hubReleaseDigest))) {
    refuse("E_BOOTSTRAP_ARTIFACT_INVALID", "the verified release digest is not a canonical sha256 digest");
  }
  if (!RELEASE_DIGEST_PATTERN.test(String(sqliteArtifactDigest))) {
    refuse("E_BOOTSTRAP_ARTIFACT_INVALID", "release-package.json declares no canonical sqlite_artifact_digest");
  }
  if (declaredRows !== skillCount) {
    refuse(
      "E_BOOTSTRAP_ARTIFACT_INVALID",
      `release-package.json declares ${declaredRows} snapshot rows but the envelope carries ${skillCount} skills`,
    );
  }

  return Object.freeze({
    dir: resolved,
    hubReleaseDigest,
    sqliteArtifactDigest,
    skillCount,
    /** The artifact's own label. Not a `public.hubs.id`; never registered as one. */
    artifactHubId: typeof snapshot.release.payload.hub_id === "string" ? snapshot.release.payload.hub_id : null,
  });
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

function requireUuid(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ARG_LENGTH) {
    refuse("E_BOOTSTRAP_ARGUMENT_INVALID", `${label} is required`);
  }
  if (!UUID_PATTERN.test(value)) {
    refuse("E_BOOTSTRAP_ARGUMENT_INVALID", `${label} must be a canonical lowercase uuid`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !RELEASE_DIGEST_PATTERN.test(value)) {
    refuse("E_BOOTSTRAP_ARGUMENT_INVALID", `${label} must be a canonical sha256:<64 lowercase hex> digest`);
  }
  return value;
}

/**
 * Build the registration plan. Pure: it contacts nothing and writes nothing.
 *
 * `visibility` is fixed to `private` on purpose. A `private` hub is readable by
 * its owner's subject under the original control-plane policy **and** under
 * Contract F's `private.can_read_hub`, so the same registration works whichever
 * policy generation the database is actually running — and it grants nothing to
 * anyone else. Widening visibility is a separate authorization decision.
 */
export function planBootstrap({ workspaceId, hubId, release }) {
  const workspace = requireUuid(workspaceId, "--workspace");
  const hub = requireUuid(hubId, "--hub");
  if (release === null || typeof release !== "object") {
    refuse("E_BOOTSTRAP_ARGUMENT_INVALID", "a verified release is required");
  }
  const releaseDigest = requireDigest(release.hubReleaseDigest, "the verified release digest");
  const sqliteDigest = requireDigest(release.sqliteArtifactDigest, "the verified sqlite artifact digest");

  return Object.freeze({
    workspaceId: workspace,
    hubId: hub,
    visibility: BOOTSTRAP_VISIBILITY,
    releaseDigest,
    sqliteDigest,
    skillCount: release.skillCount,
    artifactDir: release.dir,
    artifactHubId: release.artifactHubId,
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const HEADER = [
  "-- Catalog bootstrap — generated by scripts/hosted/bootstrap-catalog.mjs.",
  "-- Review before running. Append-only; never overwrites an existing row.",
];

/**
 * The forward transaction.
 *
 * Shape, and why:
 *
 *  1. Preconditions that do not depend on concurrency (schema present, workspace
 *     exists, no explicit deny).
 *  2. Two append-only inserts in **separate statements**, each reporting whether
 *     it actually inserted. They are separate on purpose: data-modifying CTEs in
 *     one statement are not ordered, and the release row has a foreign key to the
 *     hub row.
 *  3. The **authoritative** identity check, inside the same transaction, after
 *     the inserts, under `FOR UPDATE` on both rows. This is what makes a
 *     conflicting concurrent writer safe. `ON CONFLICT DO NOTHING` is the
 *     serialization point: a writer that inserted the same key first makes our
 *     insert a no-op, and the row lock then holds the deciding row still while we
 *     check it. Any mismatch raises and rolls back **every** write above,
 *     including the hub this transaction may have just created.
 *
 * An advisory lock is not used: it would only bind writers that also take it.
 */
export function renderTransaction(plan) {
  const w = plan.workspaceId;
  const h = plan.hubId;
  const r = plan.releaseDigest;
  const s = plan.sqliteDigest;
  const v = plan.visibility;
  return `${[...HEADER, ""].join("\n")}begin;

create temp table bootstrap_inserted (
  kind text primary key,
  inserted boolean not null
) on commit drop;

do $precheck$
declare
  c_workspace      constant uuid := '${w}';
  c_hub            constant uuid := '${h}';
  c_release_digest constant text := '${r}';
begin
  if to_regclass('public.personal_workspaces') is null
     or to_regclass('public.hubs') is null
     or to_regclass('public.hub_releases') is null then
    raise exception 'E_BOOTSTRAP_SCHEMA_MISSING: the control-plane tables are not present in this database';
  end if;

  if not exists (select 1 from public.personal_workspaces where id = c_workspace) then
    raise exception 'E_BOOTSTRAP_WORKSPACE_MISSING: personal_workspaces % does not exist', c_workspace;
  end if;

  if to_regclass('public.security_denies') is not null
     and exists (
       select 1 from public.security_denies d
       where d.workspace_id = c_workspace
         and ((d.kind = 'hub' and d.identity = c_hub::text)
           or (d.kind = 'release' and d.identity = c_release_digest))
     ) then
    raise exception 'E_BOOTSTRAP_DENY_PRESENT: an explicit deny covers hub % or release %',
      c_hub, c_release_digest;
  end if;
end
$precheck$;

with inserted as (
  insert into public.hubs (id, workspace_id, visibility)
    values ('${h}', '${w}', '${v}')
    on conflict (id) do nothing
  returning id
)
insert into bootstrap_inserted (kind, inserted)
select 'hub', count(*) = 1 from inserted;

with inserted as (
  insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
    values ('${h}', '${r}', '${s}')
    on conflict (hub_id, release_digest) do nothing
  returning hub_id
)
insert into bootstrap_inserted (kind, inserted)
select 'release', count(*) = 1 from inserted;

do $verify$
declare
  v_hub     record;
  v_release record;
begin
  select id, workspace_id, visibility into v_hub
    from public.hubs where id = '${h}' for update;
  if not found then
    raise exception 'E_BOOTSTRAP_HUB_MISSING: hub % is absent after registration', '${h}';
  end if;
  if v_hub.workspace_id <> '${w}'::uuid or v_hub.visibility <> '${v}' then
    raise exception 'E_BOOTSTRAP_HUB_CONFLICT: hub % is attached to workspace % with visibility %, not to workspace ${w} with visibility ${v}',
      '${h}', v_hub.workspace_id, v_hub.visibility;
  end if;

  select hub_id, release_digest, sqlite_artifact_digest into v_release
    from public.hub_releases
   where hub_id = '${h}' and release_digest = '${r}'
   for update;
  if not found then
    raise exception 'E_BOOTSTRAP_RELEASE_MISSING: release % is absent from hub % after registration',
      '${r}', '${h}';
  end if;
  if v_release.sqlite_artifact_digest <> '${s}' then
    raise exception 'E_BOOTSTRAP_RELEASE_CONFLICT: release % is registered with sqlite digest %, not the reviewed digest',
      '${r}', v_release.sqlite_artifact_digest;
  end if;
end
$verify$;

select
  coalesce((select inserted from bootstrap_inserted where kind = 'hub'), false),
  coalesce((select inserted from bootstrap_inserted where kind = 'release'), false);

commit;`;
}

/**
 * The rollback, generated from the execution receipt.
 *
 * Only a row the receipt records as inserted by the bootstrap may be deleted. A
 * reused row is never a candidate, and every delete is bound to the exact
 * identity the receipt recorded, so a row that has since changed is left alone
 * and the whole rollback aborts.
 */
export function renderRollback(receipt) {
  const { workspace_id: w, hub_id: h, visibility: v, release_digest: r, sqlite_artifact_digest: s } = receipt;
  const willDeleteHub = receipt.inserted.hub === true;
  const willDeleteRelease = receipt.inserted.release === true;

  const sections = [];

  if (willDeleteHub) {
    sections.push(`  -- Hub identity, held still while it is checked.
  select id, workspace_id, visibility into v_row from public.hubs where id = c_hub for update;
  if not found then
    raise exception 'E_BOOTSTRAP_ROLLBACK_MISSING: hub % recorded by the receipt is already absent', c_hub;
  end if;
  if v_row.workspace_id <> c_workspace or v_row.visibility <> c_visibility then
    raise exception 'E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED: hub % now has workspace % and visibility %, not the recorded % and %',
      c_hub, v_row.workspace_id, v_row.visibility, c_workspace, c_visibility;
  end if;`);
  }

  if (willDeleteRelease) {
    sections.push(`  -- Release identity, held still while it is checked.
  select hub_id, release_digest, sqlite_artifact_digest into v_row
    from public.hub_releases where hub_id = c_hub and release_digest = c_release_digest for update;
  if not found then
    raise exception 'E_BOOTSTRAP_ROLLBACK_MISSING: release % on hub % recorded by the receipt is already absent',
      c_release_digest, c_hub;
  end if;
  if v_row.sqlite_artifact_digest <> c_sqlite_digest then
    raise exception 'E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED: release % now has sqlite digest %, not the recorded %',
      c_release_digest, v_row.sqlite_artifact_digest, c_sqlite_digest;
  end if;`);
  }

  if (willDeleteHub) {
    sections.push(`  -- Dependents of the hub: refuse rather than cascade.
  if to_regclass('public.hub_stable_pointers') is not null
     and exists (select 1 from public.hub_stable_pointers where hub_id = c_hub) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_DEPENDENT: a stable pointer references hub %', c_hub;
  end if;
  if to_regclass('public.hub_release_artifacts') is not null
     and exists (select 1 from public.hub_release_artifacts where hub_id = c_hub) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_DEPENDENT: artifact inventory references hub %', c_hub;
  end if;
  if to_regclass('public.public_hub_publications') is not null
     and exists (select 1 from public.public_hub_publications where hub_id = c_hub) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_DEPENDENT: a publication references hub %', c_hub;
  end if;
  if exists (
    select 1 from public.hub_releases where hub_id = c_hub and release_digest <> c_release_digest
  ) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_DEPENDENT: hub % holds releases other than %',
      c_hub, c_release_digest;
  end if;`);
  }

  if (willDeleteRelease) {
    sections.push(`  -- Dependents of the release: refuse rather than cascade.
  if to_regclass('public.project_contexts') is not null
     and exists (select 1 from public.project_contexts where release_digest = c_release_digest) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_DEPENDENT: a project context pins release %', c_release_digest;
  end if;`);
  }

  if (willDeleteRelease) {
    sections.push(`  -- Child first, and only while it still carries the recorded identity.
  delete from public.hub_releases
   where hub_id = c_hub
     and release_digest = c_release_digest
     and sqlite_artifact_digest = c_sqlite_digest;
  if not found then
    raise exception 'E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED: release % changed during the rollback', c_release_digest;
  end if;`);
  }

  if (willDeleteHub) {
    sections.push(`  -- Parent last, and only while it still carries the recorded identity.
  delete from public.hubs
   where id = c_hub
     and workspace_id = c_workspace
     and visibility = c_visibility;
  if not found then
    raise exception 'E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED: hub % changed during the rollback', c_hub;
  end if;`);
  }

  const body =
    sections.length === 0
      ? `  -- The receipt records that this bootstrap inserted no rows of its own:\n  -- there is nothing to remove, and every row must be left untouched.`
      : sections.join("\n\n");

  return `${[...HEADER, "-- Rollback: removes only rows the execution receipt records as inserted by it."].join("\n")}
begin;

do $rollback$
declare
  c_workspace      constant uuid := '${w}';
  c_hub            constant uuid := '${h}';
  c_visibility     constant text := '${v}';
  c_release_digest constant text := '${r}';
  c_sqlite_digest  constant text := '${s}';
  v_row            record;
begin
${body}
end
$rollback$;

commit;`;
}

/** Post-commit observation. Never relied on as conflict protection. */
export function renderReadBack(plan) {
  return `select id::text, workspace_id::text, visibility from public.hubs where id = '${plan.hubId}';`;
}

export function renderReleaseReadBack(plan) {
  return `select hub_id::text, release_digest, sqlite_artifact_digest
    from public.hub_releases
   where hub_id = '${plan.hubId}' and release_digest = '${plan.releaseDigest}';`;
}

/* -------------------------------------------------------------------------- */
/* Execution receipt                                                           */
/* -------------------------------------------------------------------------- */

function receiptIdentity(plan) {
  return {
    hub: `${plan.hubId}|${plan.workspaceId}|${plan.visibility}`,
    release: `${plan.hubId}|${plan.releaseDigest}|${plan.sqliteDigest}`,
  };
}

/** Build a receipt from the transaction's own report plus the observed rows. */
export function buildReceipt(plan, inserted, observed) {
  return Object.freeze({
    receipt_version: RECEIPT_VERSION,
    created_at: new Date().toISOString(),
    artifact_dir: plan.artifactDir,
    skill_count: plan.skillCount,
    workspace_id: plan.workspaceId,
    hub_id: plan.hubId,
    visibility: plan.visibility,
    release_digest: plan.releaseDigest,
    sqlite_artifact_digest: plan.sqliteDigest,
    inserted: Object.freeze({ hub: inserted.hub === true, release: inserted.release === true }),
    observed: Object.freeze({ hub: observed.hub, release: observed.release }),
  });
}

/** Read and structurally validate a receipt. Missing or malformed refuses. */
export function readReceipt(path) {
  if (typeof path !== "string" || path.trim() === "") {
    refuse("E_BOOTSTRAP_RECEIPT_MISSING", "--receipt <path> is required to apply or roll back");
  }
  if (!existsSync(path)) {
    refuse("E_BOOTSTRAP_RECEIPT_MISSING", `no execution receipt at ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse("E_BOOTSTRAP_RECEIPT_INVALID", `${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const valid =
    parsed !== null &&
    typeof parsed === "object" &&
    parsed.receipt_version === RECEIPT_VERSION &&
    UUID_PATTERN.test(String(parsed.workspace_id)) &&
    UUID_PATTERN.test(String(parsed.hub_id)) &&
    typeof parsed.visibility === "string" &&
    RELEASE_DIGEST_PATTERN.test(String(parsed.release_digest)) &&
    RELEASE_DIGEST_PATTERN.test(String(parsed.sqlite_artifact_digest)) &&
    parsed.inserted !== null &&
    typeof parsed.inserted === "object" &&
    typeof parsed.inserted.hub === "boolean" &&
    typeof parsed.inserted.release === "boolean" &&
    parsed.observed !== null &&
    typeof parsed.observed === "object" &&
    typeof parsed.observed.hub === "string" &&
    typeof parsed.observed.release === "string";
  if (!valid) {
    refuse("E_BOOTSTRAP_RECEIPT_INVALID", `${path} is not a catalog-bootstrap receipt (version ${RECEIPT_VERSION})`);
  }
  // The recorded observation must encode exactly the recorded identities: a
  // receipt cannot be edited to claim ownership of a different hub or release.
  if (parsed.observed.hub !== `${parsed.hub_id}|${parsed.workspace_id}|${parsed.visibility}`) {
    refuse("E_BOOTSTRAP_RECEIPT_INVALID", `${path} records an observed hub identity that disagrees with its own identifiers`);
  }
  if (parsed.observed.release !== `${parsed.hub_id}|${parsed.release_digest}|${parsed.sqlite_artifact_digest}`) {
    refuse("E_BOOTSTRAP_RECEIPT_INVALID", `${path} records an observed release identity that disagrees with its own identifiers`);
  }
  return Object.freeze(parsed);
}

/** The receipt must describe the same registration the current arguments name. */
export function validateReceipt(receipt, plan) {
  const mismatches = [];
  if (receipt.workspace_id !== plan.workspaceId) mismatches.push("workspace");
  if (receipt.hub_id !== plan.hubId) mismatches.push("hub");
  if (receipt.visibility !== plan.visibility) mismatches.push("visibility");
  if (receipt.release_digest !== plan.releaseDigest) mismatches.push("release digest");
  if (receipt.sqlite_artifact_digest !== plan.sqliteDigest) mismatches.push("sqlite digest");
  if (mismatches.length > 0) {
    refuse(
      "E_BOOTSTRAP_RECEIPT_MISMATCH",
      `the receipt describes a different registration (${mismatches.join(", ")}); it is not this operation's receipt`,
    );
  }
  return receipt;
}

/** Write the receipt atomically, owner-only. It contains no credentials. */
export function writeReceipt(path, receipt) {
  const target = resolve(path);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return target;
}

/* -------------------------------------------------------------------------- */
/* Database access                                                             */
/* -------------------------------------------------------------------------- */

/** Where `--apply` / `--rollback` read the connection string. Never an argument. */
export const DATABASE_URL_ENV = "EGA_BOOTSTRAP_DATABASE_URL";

/** Query parameters mapped onto libpq environment variables. */
const URL_PARAMETER_ENV = Object.freeze({ sslmode: "PGSSLMODE" });

/**
 * Decompose a PostgreSQL URL into libpq environment variables.
 *
 * The credential goes into the child's environment — a supported libpq mechanism
 * — so it never appears in argv (`ps`/`/proc/<pid>/cmdline`). Unknown query
 * parameters are refused rather than dropped: silently discarding `sslmode`
 * would be a security downgrade, and silently discarding anything else would make
 * the connection disagree with the operator's intent.
 */
export function parseDatabaseUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    refuse("E_BOOTSTRAP_DATABASE_URL_MISSING", `${DATABASE_URL_ENV} is required to apply or roll back`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    refuse("E_BOOTSTRAP_DATABASE_URL_INVALID", `${DATABASE_URL_ENV} is not a URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    refuse("E_BOOTSTRAP_DATABASE_URL_INVALID", `${DATABASE_URL_ENV} must be a postgres:// or postgresql:// URL`);
  }
  if (parsed.hostname === "") {
    refuse("E_BOOTSTRAP_DATABASE_URL_INVALID", `${DATABASE_URL_ENV} must name a host`);
  }

  const env = {};
  env.PGHOST = parsed.hostname;
  if (parsed.port !== "") env.PGPORT = parsed.port;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database !== "") env.PGDATABASE = database;
  if (parsed.username !== "") env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password !== "") env.PGPASSWORD = decodeURIComponent(parsed.password);

  for (const [key, value] of parsed.searchParams) {
    const target = URL_PARAMETER_ENV[key];
    if (target === undefined) {
      refuse(
        "E_BOOTSTRAP_DATABASE_URL_UNSUPPORTED",
        `${DATABASE_URL_ENV} carries an unsupported parameter "${key}"; pass it through the environment instead`,
      );
    }
    env[target] = value;
  }

  return {
    env,
    /** Values that must never appear in a reported error. */
    secrets: [url, parsed.password === "" ? null : decodeURIComponent(parsed.password), parsed.username === "" ? null : decodeURIComponent(parsed.username)].filter(
      (value) => typeof value === "string" && value.length >= 4,
    ),
  };
}

/**
 * Build the child environment: inherited `PG*` cleared, then our own.
 *
 * Clearing first is deliberate. A stray `PGPASSWORD`/`PGHOST`/`.pgpass` in the
 * operator's shell must not be able to redirect a trusted-publisher operation to
 * a different database than the one the receipt will name.
 */
export function psqlEnvironment(url, baseEnv = process.env) {
  const { env, secrets } = parseDatabaseUrl(url);
  const child = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("PG")) continue;
    child[key] = value;
  }
  Object.assign(child, env);
  child.PGCONNECT_TIMEOUT = "10";
  child.PGAPPNAME = "ega-bootstrap";
  return { env: child, secrets };
}

/**
 * Redact the things that must never be reported, then bound the result.
 *
 * Only a few shapes are rewritten; the point is that a credential echoed by a
 * driver (a full DSN, a `password=` pair, or the exact values we passed) cannot
 * reach the operator's terminal, a log, or a ticket.
 */
export function sanitizeDiagnostics(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("<redacted>");
  }
  out = out
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "<redacted-dsn>")
    .replace(/(password\s*[=:]\s*)[^\s"',;]+/gi, "$1<redacted>")
    .replace(/\r/g, "");
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.slice(0, 3).join(" ").slice(0, 300);
}

/**
 * The exact child invocation.
 *
 * There is deliberately no connection string here: the child learns the target
 * from its environment (see {@link psqlEnvironment}), so nothing credential-shaped
 * can appear in `ps` or `/proc/<pid>/cmdline`. Exported so the argv can be
 * asserted without spawning anything.
 */
export function psqlInvocation() {
  return Object.freeze({
    command: "psql",
    args: Object.freeze(["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|"]),
  });
}

/**
 * Run one statement, returning stdout and refusing with a bounded, sanitised,
 * code-bearing message on failure.
 *
 * `spawnImpl` exists so the invocation and the failure formatting can be tested
 * on every platform without a database driver on `PATH`.
 */
export function runStatement(url, sql, spawnImpl = spawnSync) {
  const { env, secrets } = psqlEnvironment(url);
  const { command, args } = psqlInvocation();
  const result = spawnImpl(command, args, {
    input: sql,
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    refuse(
      "E_BOOTSTRAP_PSQL_UNAVAILABLE",
      `psql could not be run (${result.error.code ?? "spawn failed"}); it is required to apply or roll back`,
    );
  }
  const stderr = sanitizeDiagnostics(result.stderr, secrets);
  if (result.status !== 0) {
    const code = /E_BOOTSTRAP_[A-Z_]+/.exec(stderr)?.[0] ?? "E_BOOTSTRAP_APPLY_FAILED";
    refuse(code, stderr === "" ? "the database refused the statement" : `the database refused the statement: ${stderr}`);
  }
  return result.stdout ?? "";
}

/* -------------------------------------------------------------------------- */
/* Apply / roll back                                                           */
/* -------------------------------------------------------------------------- */

function parseInserted(stdout) {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .pop();
  if (typeof line !== "string") {
    refuse("E_BOOTSTRAP_READBACK_MISMATCH", "the database returned no registration report");
  }
  const [hub, release] = line.split("|");
  if (hub !== "t" && hub !== "f") {
    refuse("E_BOOTSTRAP_READBACK_MISMATCH", "the database returned an unreadable registration report");
  }
  if (release !== "t" && release !== "f") {
    refuse("E_BOOTSTRAP_READBACK_MISMATCH", "the database returned an unreadable registration report");
  }
  return { hub: hub === "t", release: release === "t" };
}

/**
 * Apply the transaction and record what it inserted.
 *
 * A pre-existing receipt is honoured, never rewritten: if this run reports the
 * same ownership the receipt records, the receipt is left byte-for-byte intact
 * (an idempotent rerun); if it reports different ownership, the run refuses
 * rather than claiming rows the original receipt does not.
 */
export function applyBootstrap(plan, url, receiptPath, spawnImpl = undefined) {
  if (typeof receiptPath !== "string" || receiptPath.trim() === "") {
    refuse("E_BOOTSTRAP_RECEIPT_MISSING", "--receipt <path> is required to apply");
  }
  const existing = existsSync(receiptPath) ? validateReceipt(readReceipt(receiptPath), plan) : null;

  const run = (sql) => (spawnImpl === undefined ? runStatement(url, sql) : runStatement(url, sql, spawnImpl));

  const inserted = parseInserted(run(renderTransaction(plan)));

  // Post-commit observation only. It is reported, not relied on for atomicity —
  // the authoritative check already ran inside the transaction.
  const hub = run(renderReadBack(plan)).trim();
  const release = run(renderReleaseReadBack(plan)).trim();
  const expected = receiptIdentity(plan);
  if (hub !== expected.hub || release !== expected.release) {
    refuse(
      "E_BOOTSTRAP_READBACK_MISMATCH",
      "the committed rows do not match the registration; inspect the database before proceeding",
    );
  }

  const receipt = buildReceipt(plan, inserted, { hub, release });

  if (existing !== null) {
    // An idempotent rerun reports fewer inserts (usually none) than the original
    // execution, which is exactly right: the rows already exist and this run did
    // not create them. The receipt is kept untouched. What must be refused is the
    // opposite — a run that inserts a row the receipt says it did not insert,
    // because then the recorded ownership no longer describes the database.
    const claimsNewOwnership =
      (inserted.hub && !existing.inserted.hub) || (inserted.release && !existing.inserted.release);
    if (claimsNewOwnership) {
      refuse(
        "E_BOOTSTRAP_RECEIPT_STALE",
        "this run inserted a row the existing receipt records as reused; keep that receipt and record the new registration separately",
      );
    }
    return { receipt: existing, inserted, receiptPath, reusedReceipt: true };
  }

  writeReceipt(receiptPath, receipt);
  return { receipt, inserted, receiptPath, reusedReceipt: false };
}

/**
 * Roll back from a receipt.
 *
 * The receipt is consumed only on success, so a failed rollback can be retried
 * and a repeated rollback is refused rather than silently doing nothing.
 */
export function rollbackBootstrap(receiptPath, url, spawnImpl = undefined) {
  const receipt = readReceipt(receiptPath);
  const run = (sql) => (spawnImpl === undefined ? runStatement(url, sql) : runStatement(url, sql, spawnImpl));

  run(renderRollback(receipt));

  const hubPresent = run(
    `select count(*) from public.hubs where id = '${receipt.hub_id}';`,
  ).trim();
  const releasePresent = run(
    `select count(*) from public.hub_releases where hub_id = '${receipt.hub_id}' and release_digest = '${receipt.release_digest}';`,
  ).trim();
  if (receipt.inserted.hub && hubPresent !== "0") {
    refuse("E_BOOTSTRAP_ROLLBACK_INCOMPLETE", "the hub recorded as inserted is still present after the rollback");
  }
  if (receipt.inserted.release && releasePresent !== "0") {
    refuse("E_BOOTSTRAP_ROLLBACK_INCOMPLETE", "the release recorded as inserted is still present after the rollback");
  }

  rmSync(receiptPath, { force: true });
  return { receipt, removedHub: receipt.inserted.hub, removedRelease: receipt.inserted.release };
}

/** One JSON document describing a completed rollback. */
export function buildRollbackReport(receipt, outcome, receiptPath) {
  return Object.freeze({
    executed: "rollback",
    rolledBack: true,
    removedHub: outcome.removedHub,
    removedRelease: outcome.removedRelease,
    receiptConsumed: receiptPath,
    receipt,
    transaction: renderRollback(receipt),
  });
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function usage() {
  return [
    "usage: node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> [options]",
    "",
    "  --workspace <uuid>   public.personal_workspaces.id that owns the hub (required)",
    "  --hub <uuid>         public.hubs.id to register, recorded out of band (required)",
    "  --artifact <dir>     artifact directory (default packages/mcp/artifact)",
    "  --receipt <path>     execution receipt (required with --apply and --rollback)",
    "  --json               emit the plan as JSON",
    "  --apply              execute the transaction (requires " + DATABASE_URL_ENV + ")",
    "  --rollback           execute the rollback from --receipt (requires " + DATABASE_URL_ENV + ")",
    "  --help",
    "",
    "Without --apply/--rollback the script contacts no database and prints the exact",
    "transaction for review.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    workspace: null,
    hub: null,
    artifact: DEFAULT_ARTIFACT_DIR,
    receipt: null,
    json: false,
    apply: false,
    rollback: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace") options.workspace = argv[++i] ?? null;
    else if (arg === "--hub") options.hub = argv[++i] ?? null;
    else if (arg === "--artifact") options.artifact = argv[++i] ?? null;
    else if (arg === "--receipt") options.receipt = argv[++i] ?? null;
    else if (arg === "--json") options.json = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--rollback") options.rollback = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else refuse("E_BOOTSTRAP_ARGUMENT_INVALID", `unknown argument: ${arg}`);
  }
  if (options.apply && options.rollback) {
    refuse("E_BOOTSTRAP_ARGUMENT_INVALID", "--apply and --rollback are mutually exclusive");
  }
  return options;
}

/** Human-readable summary. Never includes a connection string or a key. */
function formatPlan(plan, receiptPath) {
  return [
    "bootstrap-catalog: prepared (no database was contacted)",
    "",
    `  artifact            ${plan.artifactDir}`,
    `  release digest      ${plan.releaseDigest}`,
    `  sqlite digest       ${plan.sqliteDigest}`,
    `  skills              ${plan.skillCount}`,
    `  artifact hub_id     ${plan.artifactHubId ?? "absent"}  (not used: public.hubs.id is a uuid)`,
    `  workspace (target)  ${plan.workspaceId}`,
    `  hub (target)        ${plan.hubId}`,
    `  visibility          ${plan.visibility}`,
    `  receipt             ${receiptPath ?? "(pass --receipt <path> with --apply)"}`,
  ].join("\n");
}

export async function main(argv, env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.workspace === null) refuse("E_BOOTSTRAP_ARGUMENT_INVALID", "--workspace is required");
  if (options.hub === null) refuse("E_BOOTSTRAP_ARGUMENT_INVALID", "--hub is required");

  const executing = options.apply || options.rollback;
  if (executing && (options.receipt === null || options.receipt.trim() === "")) {
    refuse("E_BOOTSTRAP_RECEIPT_MISSING", "--receipt <path> is required to apply or roll back");
  }

  // Resolve the connection BEFORE anything is printed. A missing connection
  // string must not produce a half-written plan that looks like a successful
  // preparation, and the value itself is never echoed.
  const databaseUrl = executing ? (env[DATABASE_URL_ENV] ?? null) : null;
  if (executing) {
    // Validates and refuses without echoing the value.
    parseDatabaseUrl(databaseUrl);
  }

  // Rollback is generated from the receipt, so it needs no artifact.
  if (options.rollback) {
    const receipt = readReceipt(options.receipt);
    const plan = planBootstrap({
      workspaceId: options.workspace,
      hubId: options.hub,
      release: {
        hubReleaseDigest: receipt.release_digest,
        sqliteArtifactDigest: receipt.sqlite_artifact_digest,
        skillCount: receipt.skill_count,
        dir: receipt.artifact_dir,
        artifactHubId: null,
      },
    });
    validateReceipt(receipt, plan);

    // Present the statement before it runs, exactly as the apply path does.
    if (!options.json) {
      process.stdout.write(
        `${formatPlan(plan, options.receipt)}\n\n--- rollback (receipt: ${options.receipt}) ---\n${renderRollback(receipt)}\n`,
      );
    }

    // One JSON document for the whole command: the receipt, the statement that
    // ran, and what it removed.
    const outcome = rollbackBootstrap(options.receipt, databaseUrl);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildRollbackReport(receipt, outcome, options.receipt), null, 2)}\n`);
    } else {
      process.stdout.write(
        `\nbootstrap-catalog: rolled back\n  hub removed     ${outcome.removedHub}\n  release removed ${outcome.removedRelease}\n  receipt consumed: ${options.receipt}\n`,
      );
    }
    return 0;
  }

  const release = await verifyReviewedRelease(options.artifact ?? DEFAULT_ARTIFACT_DIR);
  const plan = planBootstrap({ workspaceId: options.workspace, hubId: options.hub, release });
  const transaction = renderTransaction(plan);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          executed: options.apply ? "apply" : "none",
          artifact: {
            dir: plan.artifactDir,
            hub_release_digest: plan.releaseDigest,
            sqlite_artifact_digest: plan.sqliteDigest,
            skill_count: plan.skillCount,
            artifact_hub_id: plan.artifactHubId,
          },
          registration: { workspace_id: plan.workspaceId, hub_id: plan.hubId, visibility: plan.visibility },
          transaction,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatPlan(plan, options.receipt)}\n\n--- transaction (run with --apply) ---\n${transaction}\n`);
  }

  if (options.apply) {
    const outcome = applyBootstrap(plan, databaseUrl, options.receipt);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ applied: true, inserted: outcome.inserted, receipt: outcome.receiptPath, reusedReceipt: outcome.reusedReceipt }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `\nbootstrap-catalog: applied\n  inserted hub     ${outcome.inserted.hub}\n  inserted release ${outcome.inserted.release}\n  receipt          ${outcome.receiptPath}${outcome.reusedReceipt ? " (unchanged; this run inserted nothing new)" : ""}\n`,
      );
    }
  } else if (!options.json) {
    process.stdout.write(`\nbootstrap-catalog: nothing was executed. Review the transaction above, then re-run with --apply.\n`);
  }

  return 0;
}

/** Exit status for a refusal, and the one line an operator needs. */
export function reportFailure(error) {
  const code = error instanceof BootstrapError ? error.code : "E_BOOTSTRAP_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`bootstrap-catalog: REFUSED — ${code}: ${message}\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.exitCode = reportFailure(error);
  }
}
