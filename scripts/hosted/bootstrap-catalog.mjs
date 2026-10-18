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
 *     `public.hubs.id` is a `uuid` — there is no mapping to derive, so guessing
 *     one would be a fabrication;
 *  3. **prepares one transaction** that registers a `private` hub and the release;
 *  4. **never overwrites**. Every disagreement with an existing row raises and
 *     aborts the transaction, and every write is `on conflict do nothing`. There
 *     is no `update` and no `delete` in the forward transaction;
 *  5. prints a **dependency-aware rollback** that removes only what the
 *     bootstrap registers, child before parent, and refuses if anything else has
 *     come to depend on them.
 *
 * ## It prepares by default; it executes only when asked
 *
 * With no `--apply`, the script contacts no database and prints the exact
 * transaction and rollback for review. `--apply` / `--rollback` run the printed
 * statement with `psql` against `EGA_BOOTSTRAP_DATABASE_URL`. The connection
 * string is read from the environment (never an argument) and is never printed.
 *
 * ## What it deliberately does not do
 *
 * No schema, policy, grant or role change. No `hub_stable_pointers`,
 * `immutable_objects`, `hub_release_artifacts`, `public_hub_publications` or
 * `audit_events` write — those tables have no writer anywhere in the repository
 * and inventing one here would be a different change with its own review. The
 * rollback treats any such row as a dependency and refuses rather than
 * cascading.
 *
 * Usage:
 *   node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid>
 *   node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> --apply
 *   node scripts/hosted/bootstrap-catalog.mjs --workspace <uuid> --hub <uuid> --rollback
 *
 * Options:
 *   --workspace <uuid>   public.personal_workspaces.id that owns the hub (required)
 *   --hub <uuid>         public.hubs.id to register, recorded out of band (required)
 *   --artifact <dir>     artifact directory (default packages/mcp/artifact)
 *   --json               emit the plan as JSON instead of prose + SQL
 *   --apply              execute the transaction (requires EGA_BOOTSTRAP_DATABASE_URL)
 *   --rollback           execute the rollback (requires EGA_BOOTSTRAP_DATABASE_URL)
 *   --help
 */

import { existsSync, readFileSync, statSync } from "node:fs";
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

/**
 * Import the domain release loader, building the workspace first if needed.
 *
 * The digest this script registers must be the digest the deployed console
 * verifies. Re-deriving it here would create a second authority for release
 * identity — the exact mistake `scripts/web/stage-artifact.mjs` documents having
 * made once (the envelope digest is a canonicalized-JSON digest, not a hash of
 * the file bytes). So the verification is delegated, not reimplemented.
 */
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

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

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
 * anyone else. Widening visibility is a separate authorization decision, not a
 * bootstrap detail.
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
  "-- Review before running. Idempotent; never overwrites an existing row.",
];

/**
 * The forward transaction.
 *
 * Every interpolated value passed {@link planBootstrap}'s closed-form validation
 * (canonical uuid / canonical digest / fixed visibility), so nothing a caller
 * supplies can alter the shape of the statement.
 */
export function renderTransaction(plan) {
  return `${[...HEADER, ""].join("\n")}begin;

do $bootstrap$
declare
  c_workspace      constant uuid := '${plan.workspaceId}';
  c_hub            constant uuid := '${plan.hubId}';
  c_visibility     constant text := '${plan.visibility}';
  c_release_digest constant text := '${plan.releaseDigest}';
  c_sqlite_digest  constant text := '${plan.sqliteDigest}';
  v_row            record;
begin
  if to_regclass('public.personal_workspaces') is null
     or to_regclass('public.hubs') is null
     or to_regclass('public.hub_releases') is null then
    raise exception 'E_BOOTSTRAP_SCHEMA_MISSING: the control-plane tables are not present in this database';
  end if;

  if not exists (select 1 from public.personal_workspaces where id = c_workspace) then
    raise exception 'E_BOOTSTRAP_WORKSPACE_MISSING: personal_workspaces % does not exist', c_workspace;
  end if;

  select id, workspace_id, visibility into v_row from public.hubs where id = c_hub;
  if found and (v_row.workspace_id <> c_workspace or v_row.visibility <> c_visibility) then
    raise exception 'E_BOOTSTRAP_HUB_CONFLICT: hub % already exists with workspace % and visibility %',
      c_hub, v_row.workspace_id, v_row.visibility;
  end if;

  select hub_id, release_digest, sqlite_artifact_digest into v_row
    from public.hub_releases where hub_id = c_hub and release_digest = c_release_digest;
  if found and v_row.sqlite_artifact_digest <> c_sqlite_digest then
    raise exception 'E_BOOTSTRAP_RELEASE_CONFLICT: release % is already registered with sqlite digest %',
      c_release_digest, v_row.sqlite_artifact_digest;
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

  insert into public.hubs (id, workspace_id, visibility)
    values (c_hub, c_workspace, c_visibility)
    on conflict (id) do nothing;

  insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
    values (c_hub, c_release_digest, c_sqlite_digest)
    on conflict (hub_id, release_digest) do nothing;
end
$bootstrap$;

commit;`;
}

/**
 * The rollback, in dependency order.
 *
 * It deletes the release row before the hub row (the foreign key makes the
 * reverse order impossible) and refuses — rather than cascading — when anything
 * else now references either. A refused rollback is a safe no-op: the
 * transaction aborts and nothing is removed.
 */
export function renderRollback(plan) {
  return `${[...HEADER, "-- Rollback: removes only what the bootstrap registers."].join("\n")}
begin;

do $rollback$
declare
  c_workspace      constant uuid := '${plan.workspaceId}';
  c_hub            constant uuid := '${plan.hubId}';
  c_release_digest constant text := '${plan.releaseDigest}';
begin
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
  end if;

  if exists (select 1 from public.hubs where id = c_hub and workspace_id <> c_workspace) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_CONFLICT: hub % belongs to a different workspace', c_hub;
  end if;

  if to_regclass('public.project_contexts') is not null
     and exists (select 1 from public.project_contexts where release_digest = c_release_digest) then
    raise exception 'E_BOOTSTRAP_ROLLBACK_DEPENDENT: a project context pins release %', c_release_digest;
  end if;

  delete from public.hub_releases where hub_id = c_hub and release_digest = c_release_digest;
  delete from public.hubs where id = c_hub;
end
$rollback$;

commit;`;
}

/** The exact read-back used to prove the hub is registered as planned. */
export function renderReadBack(plan) {
  return `select id::text, workspace_id::text, visibility from public.hubs where id = '${plan.hubId}';`;
}

/** The exact read-back used to prove the release is registered as reviewed. */
export function renderReleaseReadBack(plan) {
  return `select hub_id::text, release_digest, sqlite_artifact_digest
    from public.hub_releases
   where hub_id = '${plan.hubId}' and release_digest = '${plan.releaseDigest}';`;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/** Where `--apply` / `--rollback` read the connection string. Never an argument. */
export const DATABASE_URL_ENV = "EGA_BOOTSTRAP_DATABASE_URL";

function runSql(url, sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", url],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (result.error) {
    refuse(
      "E_BOOTSTRAP_PSQL_UNAVAILABLE",
      `psql could not be run (${result.error.code ?? result.error.message}); it is required to apply or roll back`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run `sql` and return stdout, refusing (with the SQL's own code) on failure. */
function runOrRefuse(url, sql) {
  const { status, stdout, stderr } = runSql(url, sql);
  if (status !== 0) {
    const detail = stderr.trim().split("\n").slice(0, 4).join(" ").slice(0, 400);
    const code = /E_BOOTSTRAP_[A-Z_]+/.exec(stderr)?.[0] ?? "E_BOOTSTRAP_APPLY_FAILED";
    refuse(code, `the statement was refused by the database: ${detail}`);
  }
  return stdout;
}

/** The connection string, or a refusal naming the variable (never its value). */
export function databaseUrlFromEnv(env = process.env) {
  const url = env[DATABASE_URL_ENV];
  if (typeof url !== "string" || url.trim() === "") {
    refuse(
      "E_BOOTSTRAP_DATABASE_URL_MISSING",
      `${DATABASE_URL_ENV} is required to apply or roll back; the script prepares without it`,
    );
  }
  return url;
}

/** Apply the transaction, then read back what is now registered. */
export function applyBootstrap(plan, url) {
  runOrRefuse(url, renderTransaction(plan));
  const hub = runOrRefuse(url, renderReadBack(plan)).trim();
  const release = runOrRefuse(url, renderReleaseReadBack(plan)).trim();
  const expectedHub = `${plan.hubId}|${plan.workspaceId}|${plan.visibility}`;
  const expectedRelease = `${plan.hubId}|${plan.releaseDigest}|${plan.sqliteDigest}`;
  if (hub !== expectedHub) {
    refuse(
      "E_BOOTSTRAP_READBACK_MISMATCH",
      "the database did not report the hub exactly as it was registered; inspect before proceeding",
    );
  }
  if (release !== expectedRelease) {
    refuse(
      "E_BOOTSTRAP_READBACK_MISMATCH",
      "the database did not report the release exactly as it was registered; inspect before proceeding",
    );
  }
  return { hub, release };
}

/** Apply the rollback; the guards make a partially-referenced rollback a no-op. */
export function applyRollback(plan, url) {
  runOrRefuse(url, renderRollback(plan));
  const release = runOrRefuse(url, renderReleaseReadBack(plan)).trim();
  const hub = runOrRefuse(url, renderReadBack(plan)).trim();
  return { hub, release };
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
    "  --json               emit the plan as JSON",
    "  --apply              execute the transaction (requires " + DATABASE_URL_ENV + ")",
    "  --rollback           execute the rollback (requires " + DATABASE_URL_ENV + ")",
    "  --help",
    "",
    "Without --apply/--rollback the script contacts no database and prints the exact",
    "transaction and rollback for review.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { workspace: null, hub: null, artifact: DEFAULT_ARTIFACT_DIR, json: false, apply: false, rollback: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace") options.workspace = argv[++i] ?? null;
    else if (arg === "--hub") options.hub = argv[++i] ?? null;
    else if (arg === "--artifact") options.artifact = argv[++i] ?? null;
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
function formatPlan(plan) {
  const lines = [
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
  ];
  return lines.join("\n");
}

export async function main(argv, env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.workspace === null) refuse("E_BOOTSTRAP_ARGUMENT_INVALID", "--workspace is required");
  if (options.hub === null) refuse("E_BOOTSTRAP_ARGUMENT_INVALID", "--hub is required");

  // Resolve the connection BEFORE anything is printed. A missing connection
  // string must not produce a half-written plan that looks like a successful
  // preparation, and the value itself is never echoed.
  const databaseUrl = options.apply || options.rollback ? databaseUrlFromEnv(env) : null;

  const release = await verifyReviewedRelease(options.artifact ?? DEFAULT_ARTIFACT_DIR);
  const plan = planBootstrap({ workspaceId: options.workspace, hubId: options.hub, release });
  const transaction = renderTransaction(plan);
  const rollback = renderRollback(plan);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          executed: options.apply ? "apply" : options.rollback ? "rollback" : "none",
          artifact: {
            dir: plan.artifactDir,
            hub_release_digest: plan.releaseDigest,
            sqlite_artifact_digest: plan.sqliteDigest,
            skill_count: plan.skillCount,
            artifact_hub_id: plan.artifactHubId,
          },
          registration: {
            workspace_id: plan.workspaceId,
            hub_id: plan.hubId,
            visibility: plan.visibility,
          },
          transaction,
          rollback,
        },
        null,
        2,
      )}\n`,
    );
    // In JSON mode nothing else is written, so the stream stays machine-readable.
    if (options.apply) {
      const outcome = applyBootstrap(plan, databaseUrl);
      process.stdout.write(`${JSON.stringify({ applied: true, hub: outcome.hub, release: outcome.release }, null, 2)}\n`);
    } else if (options.rollback) {
      const outcome = applyRollback(plan, databaseUrl);
      process.stdout.write(`${JSON.stringify({ rolled_back: true, hub: outcome.hub, release: outcome.release }, null, 2)}\n`);
    }
    return 0;
  }

  process.stdout.write(
    `${formatPlan(plan)}\n\n--- transaction (run with --apply) ---\n${transaction}\n\n--- rollback (run with --rollback) ---\n${rollback}\n`,
  );

  if (options.apply) {
    const outcome = applyBootstrap(plan, databaseUrl);
    process.stdout.write(
      `\nbootstrap-catalog: applied\n  hub     ${outcome.hub}\n  release ${outcome.release}\n  re-running this command writes nothing new.\n`,
    );
  } else if (options.rollback) {
    const outcome = applyRollback(plan, databaseUrl);
    process.stdout.write(
      `\nbootstrap-catalog: rolled back\n  hub     ${outcome.hub === "" ? "(removed)" : outcome.hub}\n  release ${outcome.release === "" ? "(removed)" : outcome.release}\n`,
    );
  } else {
    process.stdout.write(
      `\nbootstrap-catalog: nothing was executed. Review the transaction above, then re-run with --apply.\n`,
    );
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
