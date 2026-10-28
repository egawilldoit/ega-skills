#!/usr/bin/env node
/**
 * Trusted production publication boundary for the hosted MCP.
 *
 * ## Why this is a separate operation
 *
 * Contract R2 promotes a release through a durable, revisioned retained
 * manifest. The hosted service, however, is activated by a Vercel production
 * alias, and a Vercel alias is last-write-wins: the platform exposes no
 * compare-and-swap on an alias. A deployment, `vercel promote`, a dashboard
 * action or Git auto-deploy can all move the alias without ever consulting the
 * retained manifest.
 *
 * This script is the single supported publisher. It does not pretend the alias
 * is atomic. It makes the *decision* serialized and reviewable, and it fails
 * closed when the observable platform state shows that a bypass is possible:
 *
 *   stage    verify the exact candidate and approval, prove the live
 *            predecessor, acquire the publication lease, create a staged production
 *            deployment with --skip-domain (never the public domain) and prove that deployment
 *            serves the exact candidate digest.
 *   promote  re-verify everything, re-read the live alias and served digest
 *            immediately before the write, require Git production auto-deploy
 *            to be disabled and the canonical alias to be the only production
 *            alias, promote WITHOUT --force, then poll the alias and the served
 *            digest. A mismatch triggers an automatic restore of the recorded
 *            predecessor when, and only when, this promotion is still the
 *            current one.
 *   reconcile record an already-live staged promotion after the process died.
 *   rollback restore a previously recorded deployment and verify its digest.
 *
 * Every completed promotion or rollback writes an append-only receipt bound to
 * the approval, candidate, predecessor, deployment and publication revision.
 * A handled failure that restored the predecessor writes a FAILED receipt;
 * dry-run attempts write nothing; blocked applying attempts may leave intent. The receipt chain is the rollback
 * authority, and `reconcile` completes a receipt after an interrupted process.
 *
 * ## Residual risk (explicit, not hidden)
 *
 * A Vercel principal that can independently promote or assign the production
 * alias can still bypass this script. The gate therefore requires the operator
 * to remove that capability from every other principal and to disable Git
 * production deployments; it verifies the observable settings before each
 * write. Principal exclusivity cannot be established by these API reads; it is a
 * separate, mandatory operator certification before --apply. See
 * docs/operations/RELEASE-2.0-RUNBOOK.md ("Production publication boundary").
 *
 * Usage:
 *   node scripts/hosted/publish-production.mjs stage \
 *     --candidate <dir> --approval <approval.json> \
 *     --team <team_id> --project <project_id> --publisher <user_id> \
 *     --production-branch release/2.0 \
 *     --alias ega-skills-mcp.vercel.app \
 *     --expect-release <sha256:...> --expect-deployment <dpl_...> \
 *     --expect-revision <n> --staging-out <staging.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs promote \
 *     --staging <staging.json> --candidate <dir> --approval <approval.json> \
 *     ...same target flags... --staged-deployment <dpl_...> \
 *     (--previous-receipt <last.json> | --genesis) \
 *     --receipt <receipt.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs reconcile \
 *     --candidate <dir> --approval <approval.json> --staging <staging.json> \
 *     ...same target flags... --staged-deployment <dpl_...> \
 *     (--previous-receipt <last.json> | --genesis) \
 *     --receipt <receipt.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs rollback \
 *     --chain <newest.json,...> --current <newest.json> --target <older.json> \
 *     ...same target flags... --receipt <new.json> [--apply]
 *   For the first governed release, replace --target with
 *     --predecessor-candidate <verified-retained-original-candidate-dir>.
 *
 * Applying commands also require --readiness <externally-certified-record.json>.
 * `--apply` performs the Vercel mutation. Without it the script verifies and
 * prints the plan, contacting only read-only endpoints.
 */

import { closeSync, existsSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Errors and small helpers                                                    */
/* -------------------------------------------------------------------------- */

export class PublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new PublicationError(code, message);
}

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

export const REPO_ROOT = findRepoRoot();
const MAX_APPROVAL_AGE_MS = 24 * 60 * 60 * 1000;
const PROMOTE_TIMEOUT_MS = 10 * 60 * 1000;
const PROMOTE_POLL_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Domain gate (compiled package)                                              */
/* -------------------------------------------------------------------------- */

async function projectModule() {
  const entry = join(REPO_ROOT, "packages", "project", "dist", "index.js");
  if (!existsSync(entry)) {
    const built = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "tsc", "-b"], { cwd: REPO_ROOT, stdio: "inherit" });
    if (built.status !== 0) refuse("E_PUBLICATION_BUILD", "the domain packages must be built before publication");
  }
  return import(pathToFileURL(entry).href);
}

/** Verify a candidate locally and return the exact identity the gate binds. */
export async function readCandidate(candidateDirectory) {
  const domain = await projectModule();
  const directory = resolve(candidateDirectory);
  const candidatePath = join(directory, "candidate.json");
  if (!existsSync(candidatePath)) refuse("E_CANDIDATE", `candidate.json is missing in ${directory}`);
  const raw = JSON.parse(readFileSync(candidatePath, "utf8"));
  let verified;
  if (raw?.schema_version === 3) verified = domain.verifyInvocationCandidate(directory);
  else if (raw?.schema_version === 2) verified = domain.verifyReleaseCandidate(directory);
  else refuse("E_CANDIDATE", "unsupported candidate schema");
  const previous = raw?.payload?.publication?.previous_release_digest;
  if (typeof previous !== "string") refuse("E_CANDIDATE", "candidate does not bind a previous release");
  let sourceSnapshot = "";
  if (raw.schema_version === 3) {
    const sourceIds = [...new Set(verified.policy.payload.bindings.map((binding) => binding.source_id))];
    if (sourceIds.length !== 1) refuse("E_CANDIDATE", "the governed candidate must bind exactly one governed source");
    const adopted = verified.release.payload.adopted_sources.find((source) => source.source_id === sourceIds[0]);
    if (!adopted) refuse("E_CANDIDATE", "the governed source is missing from the release");
    sourceSnapshot = adopted.vendored_snapshot_digest;
  }
  return {
    candidate: verified.candidate,
    candidate_digest: verified.candidate.digest,
    directory,
    hub_id: verified.release.payload.hub_id,
    policy_digest: raw.schema_version === 3 ? verified.policy.digest : "",
    previous_release_digest: previous,
    release_digest: verified.release.digest,
    skill_versions: verified.release.payload.skill_versions,
    source_snapshot_digest: sourceSnapshot,
  };
}

/* -------------------------------------------------------------------------- */
/* Exclusive publication lease                                                 */
/* -------------------------------------------------------------------------- */

function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "ega-skills", "publication");
}

function leasePath(stateDir) {
  return join(resolve(stateDir), "publication.lock");
}

function readLease(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Atomic directory acquisition on the single, shared publisher filesystem.
 * Never reclaim automatically: expiry cannot prove the former writer stopped,
 * and a read/rename reclaim can move a replacement owner's live lock.
 */
export async function acquirePublicationLease(options = {}) {
  const stateDir = resolve(options.stateDir ?? defaultStateDir());
  const owner = {
    acquired_at: new Date(options.now ?? Date.now()).toISOString(),
    expires_at: new Date((options.now ?? Date.now()) + (options.ttlMs ?? 30 * 60_000)).toISOString(),
    host: hostname(), nonce: randomBytes(16).toString("hex"), pid: process.pid,
    publisher: options.publisher ?? "unknown",
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = leasePath(stateDir);
  try { mkdirSync(file, { mode: 0o700 }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    refuse("E_PUBLICATION_LEASE", "publication lease exists; verify the former writer has stopped and reconcile before manual recovery");
  }
  writeFileSync(join(file, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  return {
    owner, path: file,
    assertHeld: (now = Date.now()) => {
      if (readLease(join(file, "owner.json"))?.nonce !== owner.nonce || now >= Date.parse(owner.expires_at)) {
        refuse("E_PUBLICATION_LEASE", "publication lease lost or expired; refusing mutation");
      }
    },
    release: () => releasePublicationLease({ file, nonce: owner.nonce }),
  };
}

export function releasePublicationLease({ file, nonce }) {
  const current = readLease(join(file, "owner.json"));
  if (current?.nonce !== nonce) return false;
  rmSync(file, { recursive: true, force: true });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Live observations                                                           */
/* -------------------------------------------------------------------------- */

/** Read `/readyz` and require the exact release identity reported by the app. */
export async function probeReady(url, options = {}) {
  const target = new URL("/readyz", url.endsWith("/") ? url : `${url}/`);
  if (target.protocol !== "https:" && target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
    refuse("E_PROBE_URL", "the release probe must use HTTPS");
  }
  const headers = {};
  if (options.bypass) headers["x-vercel-protection-bypass"] = options.bypass;
  const response = await (options.fetch ?? fetch)(target, { headers, signal: options.signal });
  const body = await response.json().catch(() => undefined);
  if (response.status !== 200 || body?.status !== "ready" || typeof body.release_digest !== "string") {
    refuse("E_PROBE_UNAVAILABLE", `release probe at ${target.href} did not report a ready release`);
  }
  return {
    publication_revision: Number.isSafeInteger(body.publication_revision) ? body.publication_revision : 0,
    release_digest: body.release_digest,
  };
}

/**
 * Build the observation the gate consumes from Vercel API documents. Kept pure
 * so the platform mapping is unit-tested without network access.
 */
export function observationFromVercel({ user, project, deployments, served, expected }) {
  if (user?.id === undefined || String(user.id) !== String(expected.publisher_vercel_user_id)) {
    refuse("E_PUBLISHER_IDENTITY", "authenticated Vercel identity is not the approved publisher");
  }
  if (project?.id !== expected.project_id) refuse("E_PLATFORM_GUARD", "Vercel project identity mismatch");
  if (String(project?.accountId ?? project?.teamId ?? "") !== String(expected.team_id)) {
    refuse("E_PLATFORM_GUARD", "Vercel team identity mismatch");
  }
  const production = (deployments ?? []).filter((deployment) => deployment?.target === "production");
  // Project aliases name custom production domains; deployment aliases name the
  // assigned automatic aliases (including *.vercel.app). Use both: neither view
  // alone is complete, and an unseen production alias is a bypass path.
  const projectAliases = (project?.alias ?? []).filter((entry) => entry?.target === "PRODUCTION");
  const aliases = new Set();
  for (const deployment of production) for (const alias of deployment.alias ?? []) aliases.add(alias);
  for (const entry of projectAliases) if (typeof entry.domain === "string") aliases.add(entry.domain);
  let canonical = production.find((deployment) => Array.isArray(deployment.alias) && deployment.alias.includes(expected.canonical_alias));
  if (!canonical) {
    const byDomain = projectAliases.find((entry) => entry.domain === expected.canonical_alias);
    if (byDomain?.deployment) canonical = { ...byDomain.deployment, target: "production" };
  }
  if (!canonical) refuse("E_ALIAS_DRIFT", "no production deployment currently owns the canonical alias");
  if (served.served_deployment_id !== undefined && served.served_deployment_id !== canonical.id) {
    refuse("E_ALIAS_DRIFT", "the deployment behind the alias is not the deployment that answered the probe");
  }
  // Git production deployment must be observably disabled. `git.deploymentEnabled`
  // is the legacy per-branch switch; `deploymentPolicy.gitSources` and
  // `gitProviderOptions.createDeployments` are the current project controls.
  const git = project?.git ?? {};
  const enabled = git.deploymentEnabled;
  const linkedBranch = project?.link?.productionBranch;
  const gitBranch = git.productionBranch;
  if (typeof linkedBranch === "string" && typeof gitBranch === "string" && linkedBranch !== gitBranch) {
    refuse("E_PLATFORM_GUARD", "the linked production branch and the Git integration branch disagree");
  }
  const productionBranch = linkedBranch ?? gitBranch;
  if (typeof productionBranch !== "string" || productionBranch.length === 0) {
    refuse("E_PLATFORM_GUARD", "the Vercel production branch is not observable; refusing to infer it");
  }
  const linkedRepository = typeof project?.link?.org === "string" && typeof project?.link?.repo === "string"
    ? `${project.link.org}/${project.link.repo}`
    : undefined;
  const policyRules = project?.deploymentPolicy?.gitSources;
  const ruleCoversProject = (rule) => {
    if (!Array.isArray(rule?.environments) || !rule.environments.includes("production")) return false;
    const sources = rule.sources;
    if (!Array.isArray(sources) || sources.length === 0) return true;
    return typeof linkedRepository === "string" && sources.every((entry) => typeof entry === "string") && sources.includes(linkedRepository);
  };
  const policyDisabledProduction = Array.isArray(policyRules) && policyRules.some((rule) => rule?.enabled === false && ruleCoversProject(rule));
  const policyEnabledProduction = Array.isArray(policyRules) && policyRules.some((rule) => {
    if (rule?.enabled !== true || !Array.isArray(rule.environments) || !rule.environments.includes("production")) return false;
    const sources = rule.sources;
    // `enabled: true` with no sources is deny-all, not an allow.
    return Array.isArray(sources) && sources.length > 0 && typeof linkedRepository === "string" && sources.every((entry) => typeof entry === "string") && sources.includes(linkedRepository);
  });
  const providerSetting = project?.gitProviderOptions?.createDeployments;
  const providerDisabled = providerSetting === "disabled";
  const providerEnabled = providerSetting === "enabled";
  const legacyEnabled = enabled === true || (enabled !== null && typeof enabled === "object" && enabled[productionBranch] === true);
  const legacyDisabled = enabled === false || (enabled !== null && typeof enabled === "object" && enabled[productionBranch] === false);
  // Contradictory observables are not proof of control. Any explicit "enabled"
  // wins over a different signal that says "disabled".
  const autoDeploy = legacyEnabled || providerEnabled || policyEnabledProduction || !(legacyDisabled || policyDisabledProduction || providerDisabled);
  const conclusion = String(canonical.checksConclusion ?? "");
  const state = String(canonical.checksState ?? "");
  const checks = conclusion === "succeeded" ? "succeeded"
    : conclusion === "failed" || conclusion === "canceled" ? "failed"
    : state === "pending" || state === "in_progress" ? "pending"
    : "none";
  return {
    alias_target_deployment_id: String(canonical.id),
    canonical_alias: expected.canonical_alias,
    deployment_checks_state: checks,
    deployment_ready_state: String(canonical.readyState ?? ""),
    git_production_auto_deploy: autoDeploy,
    production_aliases: [...aliases].sort(),
    production_branch: productionBranch,
    project_id: String(project.id),
    served_deployment_id: served.served_deployment_id ?? String(canonical.id),
    served_release_digest: served.release_digest,
    team_id: String(project.accountId ?? project.teamId ?? ""),
  };
}

/* -------------------------------------------------------------------------- */
/* Vercel HTTP API                                                             */
/* -------------------------------------------------------------------------- */

export class VercelApi {
  constructor({ token, teamId, fetch: fetcher = fetch, baseUrl = "https://api.vercel.com" }) {
    if (typeof token !== "string" || token.length === 0) refuse("E_VERCEL_TOKEN", "a Vercel token is required");
    this.token = token;
    this.teamId = teamId;
    this.fetch = fetcher;
    this.baseUrl = baseUrl;
  }

  async get(path) {
    const url = new URL(path, this.baseUrl);
    if (this.teamId && path !== "/v2/user") url.searchParams.set("teamId", this.teamId);
    const response = await this.fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) refuse("E_VERCEL_API", `Vercel API ${path} failed with ${response.status}`);
    return body;
  }

  async readProduction(expected, probe) {
    const user = await this.get("/v2/user");
    const project = await this.get(`/v9/projects/${encodeURIComponent(expected.project_id)}`);
    const deployments = await this.get(`/v6/deployments?projectId=${encodeURIComponent(expected.project_id)}&target=production&limit=20`);
    // Recovery may need the authenticated immutable deployment identity while
    // /readyz is unavailable. Do not invent a served release in that case.
    const served = probe ? await probe(expected.canonical_alias) : {};
    return observationFromVercel({ deployments: deployments?.deployments ?? [], expected, project, served, user: user?.user ?? user });
  }
}

/* -------------------------------------------------------------------------- */
/* Vercel mutation runner                                                      */
/* -------------------------------------------------------------------------- */

function vercelToken() {
  const file = process.env.EGA_VERCEL_TOKEN_FILE;
  if (!file) refuse("E_VERCEL_TOKEN", "EGA_VERCEL_TOKEN_FILE must name a 0600 Vercel token file");
  return readFileSync(file, "utf8").trim();
}

export function assertPublicationPlatform(platform = process.platform) {
  if (platform !== "linux") refuse("E_PUBLICATION_PLATFORM", "production publication is supported only on the reviewed Linux host");
}

function runVercel(args, { token, scope, cwd }) {
  assertPublicationPlatform();
  const result = spawnSync("vercel", [...args, ...(scope ? ["--scope", scope] : [])], {
    cwd,
    encoding: "utf8",
    timeout: 10 * 60_000,
    env: { ...process.env, VERCEL_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) refuse("E_VERCEL_CLI", `vercel ${args[0]} failed with status ${result.status}`);
  return { stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

/** An operator-reviewed record is an external prerequisite, not a platform ACL.
 * Its authenticity must be checked against review_record by the release owner. */
export function verifyPublicationReadiness(record, expected, now, stateDir) {
  const verified = Date.parse(record?.verified_at);
  const expires = Date.parse(record?.expires_at);
  if (record?.schema_version !== 1 || !Number.isFinite(verified) || !Number.isFinite(expires) ||
      verified > now || expires <= now || expires - verified > MAX_APPROVAL_AGE_MS ||
      record.publisher_vercel_user_id !== expected.publisher_vercel_user_id || record.team_id !== expected.team_id ||
      record.project_id !== expected.project_id || record.canonical_alias !== expected.canonical_alias ||
      record.production_branch !== expected.production_branch || record.state_dir !== resolve(stateDir ?? defaultStateDir()) ||
      typeof record.certified_by !== "string" || !record.certified_by.trim() ||
      typeof record.review_record !== "string" || !/^https:\/\//.test(record.review_record) ||
      record.access_controls_reviewed !== true || record.single_writer_controls_reviewed !== true || record.residual_alias_race_accepted !== true) {
    refuse("E_PUBLICATION_READINESS", "fresh external publication-readiness certification for this exact target and shared state directory is required");
  }
}

function checkReadiness(apply, deps, expected) {
  if (apply) verifyPublicationReadiness(deps.readiness, expected, deps.now?.() ?? Date.now(), deps.stateDir);
}

/** Reserve and fsync intent before touching the alias; persist the final receipt
 * inside the caller's lease. A crash leaves intent for read-only reconciliation. */
export async function withPublicationReceipt(file, apply, operation) {
  if (!apply) return operation(undefined);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ status: "PENDING", created_at: new Date().toISOString() })}\n`);
    fsyncSync(fd);
    return await operation(async (receipt) => {
      ftruncateSync(fd, 0);
      writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 0);
      fsyncSync(fd);
    });
  } finally { closeSync(fd); }
}

async function finishPublication(result, deps, apply) {
  if (apply && result.receipt) {
    if (typeof deps.recordReceipt !== "function") refuse("E_PUBLICATION_RECEIPT", "durable receipt sink is required");
    await deps.recordReceipt(result.receipt);
  }
  return result;
}

/** Checks shared by recovery and normal publication. These are observable
 * settings, not proof that other Vercel principals lack alias-write rights. */
function verifyTargetControls(observed, expected, deployment) {
  if (observed.alias_target_deployment_id !== deployment || observed.served_deployment_id !== deployment) {
    refuse("E_PREDECESSOR_MISMATCH", "live alias deployment differs from the expected publication");
  }
  if (observed.team_id !== expected.team_id || observed.project_id !== expected.project_id ||
      observed.production_branch !== expected.production_branch || observed.canonical_alias !== expected.canonical_alias ||
      observed.git_production_auto_deploy !== false || observed.production_aliases?.length !== 1 ||
      observed.production_aliases[0] !== expected.canonical_alias) {
    refuse("E_PLATFORM_GUARD", "live publication target or production controls differ from the verified target");
  }
}

function verifyLiveTarget(observed, expected, deployment, release) {
  verifyTargetControls(observed, expected, deployment);
  if (observed.served_release_digest !== release) refuse("E_PREDECESSOR_MISMATCH", "served release differs from the expected publication");
  if (observed.deployment_ready_state !== "READY") refuse("E_DEPLOYMENT_NOT_READY", "retained deployment is not READY");
  if (observed.deployment_checks_state !== "succeeded") refuse("E_CHECKS_NOT_PASSED", "retained deployment checks have not succeeded");
}

async function recoveryObservation(deps, expected) {
  if (typeof deps.readRecoveryObservation === "function") return deps.readRecoveryObservation(expected);
  const served = await deps.probe(expected.canonical_alias);
  return deps.readObservation(expected, served);
}

/**
 * A failed or interrupted promotion is restored only when this promotion is
 * still the current one. If another publication already won, restoring would
 * clobber a newer release, so it is refused instead.
 */
async function restoreAfterFailure({ approval, candidate, deps, expected, lease }) {
  if (typeof deps.rollback !== "function") return undefined;
  const observed = await recoveryObservation(deps, expected);
  if (observed.alias_target_deployment_id !== expected.staged_deployment_id) {
    refuse("E_PUBLICATION_SUPERSEDED", "promotion was superseded by another publication; refusing to restore over it");
  }
  // A failed current deployment may be restored; the restored predecessor must be healthy.
  verifyTargetControls(observed, expected, expected.staged_deployment_id);
  checkReadiness(true, deps, expected);
  lease.assertHeld(deps.now?.() ?? Date.now());
  await deps.rollback(expected.predecessor_deployment_id);
  const restored = await deps.probe(expected.canonical_alias);
  if (restored.release_digest !== expected.predecessor_release_digest) {
    refuse("E_ROLLBACK_UNVERIFIED", "automatic restore did not return the predecessor release digest");
  }
  const restoredObservation = await deps.readObservation(expected, restored);
  verifyLiveTarget(restoredObservation, expected, expected.predecessor_deployment_id, expected.predecessor_release_digest);
  const domain = await projectModule();
  return domain.createPublicationReceipt({
    action: "PROMOTE",
    actor: approval.payload.publisher,
    approval_digest: approval.digest,
    candidate_digest: candidate.candidate_digest,
    canonical_alias: expected.canonical_alias,
    completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    deployment_id: expected.staged_deployment_id,
    detail: "promotion failed verification; predecessor restored and verified",
    hub_id: candidate.hub_id,
    policy_digest: candidate.policy_digest,
    previous_deployment_id: expected.predecessor_deployment_id,
    previous_release_digest: expected.predecessor_release_digest,
    previous_revision: expected.expected_revision,
    publication_revision: expected.expected_revision,
    release_digest: candidate.release_digest,
    status: "FAILED",
  });
}

/**
 * Execute one promotion. All I/O is injected so concurrency, drift, interrupted
 * promotion and rollback can be proven without touching a real project.
 */
export async function executePromotion({ approval, candidate, expected, deps, apply }) {
  const domain = await projectModule();
  checkReadiness(apply, deps, expected);
  if (apply && typeof deps.recordReceipt !== "function") refuse("E_PUBLICATION_RECEIPT", "durable receipt sink is required before mutation");
  const lease = await acquirePublicationLease({
    now: deps.now?.() ?? Date.now(),
    publisher: `${expected.publisher_vercel_user_id}:${expected.canonical_alias}`,
    stateDir: deps.stateDir,
  });
  try {
    const assess = async () => {
      const served = await deps.probe(expected.canonical_alias);
      const observation = await deps.readObservation(expected, served);
      const result = domain.assessProductionPublication({ approval, candidate, expected: { ...expected, now: new Date(deps.now?.() ?? Date.now()).toISOString(), max_approval_age_ms: MAX_APPROVAL_AGE_MS }, observation });
      if (result.status !== "READY") {
        refuse("E_PUBLICATION_BLOCKED", result.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; "));
      }
      return { observation, result };
    };

    const first = await assess();
    if (!apply) return { status: "DRY_RUN", first: first.result };
    const second = await assess();
    if (JSON.stringify(first.observation) !== JSON.stringify(second.observation)) {
      refuse("E_PUBLICATION_RACE", "live production identity changed between verification and promotion");
    }
    if (second.observation.served_release_digest !== expected.predecessor_release_digest) {
      refuse("E_PUBLICATION_RACE", "live production release changed immediately before promotion");
    }

    let promoted = false;
    let observed;
    try {
      checkReadiness(true, deps, expected);
      lease.assertHeld(deps.now?.() ?? Date.now());
      promoted = true; // CLI failure can still follow a successful alias move.
      await deps.promote(expected.staged_deployment_id);
      const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
      let attempts = 0;
      for (;;) {
        const served = await deps.probe(expected.canonical_alias);
        observed = await deps.readObservation(expected, served);
        if (observed.alias_target_deployment_id === expected.staged_deployment_id && served.release_digest === candidate.release_digest) {
          verifyLiveTarget(observed, expected, expected.staged_deployment_id, candidate.release_digest);
          break;
        }
        attempts += 1;
        if (!apply || attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) {
          refuse("E_PROMOTION_UNVERIFIED", "the production alias did not reach the staged deployment and release digest");
        }
        await deps.sleep?.(PROMOTE_POLL_MS);
      }
    } catch (error) {
      if (promoted) {
        const receipt = await restoreAfterFailure({ approval, candidate, deps, expected, lease });
        if (receipt && typeof error === "object" && error !== null) error.receipt = receipt;
      }
      throw error;
    }

    return await finishPublication({
      observation: observed,
      receipt: domain.createPublicationReceipt({
        action: "PROMOTE",
        actor: approval.payload.publisher,
        approval_digest: approval.digest,
        candidate_digest: candidate.candidate_digest,
        canonical_alias: expected.canonical_alias,
        completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        deployment_id: expected.staged_deployment_id,
        detail: "promoted through the trusted publication boundary and verified against the live alias",
        hub_id: candidate.hub_id,
        policy_digest: candidate.policy_digest,
        previous_deployment_id: expected.predecessor_deployment_id,
        previous_release_digest: expected.predecessor_release_digest,
        previous_revision: expected.expected_revision,
        publication_revision: expected.expected_revision + 1,
        release_digest: candidate.release_digest,
        status: "SUCCEEDED",
      }),
      status: "PROMOTED",
    }, deps, apply);
  } finally {
    lease.release();
  }
}

/**
 * Stage a production deployment with --skip-domain and prove its release
 * identity, then confirm the public alias still serves the predecessor.
 */
export async function executeStage({ approval, candidate, expected, deps, apply }) {
  const domain = await projectModule();
  checkReadiness(apply, deps, expected);
  const lease = await acquirePublicationLease({
    now: deps.now?.() ?? Date.now(),
    publisher: `${expected.publisher_vercel_user_id}:${expected.canonical_alias}`,
    stateDir: deps.stateDir,
  });
  try {
    const served = await deps.probe(expected.canonical_alias);
    const observation = await deps.readObservation(expected, served);
    const result = domain.assessProductionPublication({
      approval,
      candidate,
      expected: { ...expected, now: new Date(deps.now?.() ?? Date.now()).toISOString(), max_approval_age_ms: MAX_APPROVAL_AGE_MS },
      observation,
    });
    if (result.status !== "READY") refuse("E_PUBLICATION_BLOCKED", result.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; "));
    if (!apply) return { observation, status: "DRY_RUN" };

    checkReadiness(true, deps, expected);
    lease.assertHeld(deps.now?.() ?? Date.now());
    const deployed = await deps.deployStagedProduction();
    if (typeof deployed?.deployment_id !== "string") refuse("E_STAGE", "the staging deployment did not report an id");
    const staged = await deps.probe(deployed.url, { bypass: deps.bypass });
    if (staged.release_digest !== candidate.release_digest) refuse("E_STAGE", "the staged deployment serves a different release digest");
    const current = await deps.probe(expected.canonical_alias);
    verifyLiveTarget(await deps.readObservation(expected, current), expected, expected.predecessor_deployment_id, expected.predecessor_release_digest);

    return {
      observation,
      staging: {
        approval_digest: approval.digest,
        candidate_digest: candidate.candidate_digest,
        deployment_id: deployed.deployment_id,
        previous_deployment_id: expected.predecessor_deployment_id,
        previous_release_digest: expected.predecessor_release_digest,
        release_digest: candidate.release_digest,
        staged_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        url: deployed.url,
      },
      status: "STAGED",
    };
  } finally {
    lease.release();
  }
}

/**
 * Roll back from the current receipt to an earlier retained receipt. The
 * earlier receipt is the authority: no arbitrary digest or deployment can be
 * selected, and the chain must be contiguous and already verified.
 */
export async function executeRollback({ chain, current, target, previousCandidate, expected, deps, apply }) {
  const domain = await projectModule();
  current = domain.verifyPublicationReceipt(current);
  if (!Array.isArray(chain) || chain.length === 0) refuse("E_ROLLBACK_TARGET", "the full receipt chain is required");
  chain = chain.map((receipt) => domain.verifyPublicationReceipt(receipt));
  if (chain[0].digest !== current.digest || chain.some((receipt) => receipt.payload.status !== "SUCCEEDED")) {
    refuse("E_ROLLBACK_TARGET", "the successful receipt chain must start at the current publication");
  }
  for (let index = 1; index < chain.length; index += 1) domain.verifyPublicationReceipt(chain[index - 1], chain[index]);
  if (!expected || expected.expected_revision !== current.payload.publication_revision ||
      expected.predecessor_deployment_id !== current.payload.deployment_id || expected.predecessor_release_digest !== current.payload.release_digest) {
    refuse("E_ROLLBACK_TARGET", "rollback must bind the exact current revision, deployment and release");
  }
  for (const receipt of chain) {
    const p = receipt.payload;
    if (p.hub_id !== current.payload.hub_id || p.canonical_alias !== expected.canonical_alias ||
        p.actor.project_id !== expected.project_id || p.actor.team_id !== expected.team_id ||
        p.actor.vercel_user_id !== expected.publisher_vercel_user_id || p.actor.owner_subject !== current.payload.actor.owner_subject) {
      refuse("E_ROLLBACK_TARGET", "receipt chain crosses a Hub, alias or publisher identity");
    }
  }
  let retained;
  if (previousCandidate !== undefined) {
    // The first governed promotion has no earlier receipt. Recover its original
    // deployment only with the independently retained, verified R1 candidate.
    if (target !== undefined || chain.length !== 1 || current.payload.previous_revision !== 0 ||
        previousCandidate.release_digest !== current.payload.previous_release_digest || previousCandidate.hub_id !== current.payload.hub_id) {
      refuse("E_ROLLBACK_TARGET", "genesis recovery requires the exact retained predecessor candidate");
    }
    retained = {
      ...current.payload, approval_digest: current.payload.approval_digest,
      candidate_digest: previousCandidate.candidate_digest, policy_digest: previousCandidate.policy_digest,
      deployment_id: current.payload.previous_deployment_id, release_digest: previousCandidate.release_digest,
    };
  } else {
    target = domain.verifyPublicationReceipt(target);
    if (!chain.some((receipt) => receipt.digest === target.digest) || current.payload.publication_revision <= target.payload.publication_revision) {
      refuse("E_ROLLBACK_TARGET", "rollback target must be an earlier receipt in this chain");
    }
    retained = target.payload;
  }
  if (retained.release_digest === current.payload.release_digest) refuse("E_ROLLBACK_TARGET", "rollback target already matches the current release");
  checkReadiness(apply, deps, expected);
  if (apply && typeof deps.recordReceipt !== "function") refuse("E_PUBLICATION_RECEIPT", "durable receipt sink is required before mutation");
  const lease = await acquirePublicationLease({ now: deps.now?.() ?? Date.now(), publisher: `rollback:${expected.publisher_vercel_user_id}:${expected.canonical_alias}`, stateDir: deps.stateDir });
  try {
    const observe = async (deployment, release) => {
      const observed = await recoveryObservation(deps, expected);
      verifyTargetControls(observed, expected, deployment);
      // The receipt binds the exact immutable current deployment. An unavailable
      // health endpoint must not prevent escape, but conflicting evidence must.
      if (observed.served_release_digest !== undefined && observed.served_release_digest !== release) {
        refuse("E_PREDECESSOR_MISMATCH", "current recovery observation reports a conflicting release");
      }
      return observed;
    };
    const first = await observe(current.payload.deployment_id, current.payload.release_digest);
    if (!apply) return { status: "DRY_RUN", target: target?.digest ?? previousCandidate.candidate_digest };
    const second = await observe(current.payload.deployment_id, current.payload.release_digest);
    if (JSON.stringify(first) !== JSON.stringify(second)) refuse("E_PUBLICATION_RACE", "live production changed before rollback");
    checkReadiness(true, deps, expected);
    lease.assertHeld(deps.now?.() ?? Date.now());
    // Retained deployments have already served production: use Vercel rollback,
    // not promote (which is for newly staged deployments).
    await deps.rollback(retained.deployment_id);
    const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
    let attempts = 0;
    for (;;) {
      const served = await deps.probe(expected.canonical_alias);
      const observed = await deps.readObservation(expected, served);
      // Never certify an unrelated deployment just because it serves the same bytes.
      if (observed.alias_target_deployment_id === retained.deployment_id && served.release_digest === retained.release_digest) {
        verifyLiveTarget(observed, expected, retained.deployment_id, retained.release_digest);
        break;
      }
      if (++attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) refuse("E_ROLLBACK_UNVERIFIED", "alias did not return the retained deployment and release");
      await deps.sleep?.(PROMOTE_POLL_MS);
    }
    return await finishPublication({
      receipt: domain.createPublicationReceipt({
        action: "ROLLBACK", actor: current.payload.actor, approval_digest: retained.approval_digest,
        candidate_digest: retained.candidate_digest, canonical_alias: expected.canonical_alias,
        completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(), deployment_id: retained.deployment_id,
        detail: target ? `rolled back to publication receipt ${target.digest}` : "restored the verified genesis predecessor candidate",
        hub_id: retained.hub_id, policy_digest: retained.policy_digest,
        previous_deployment_id: current.payload.deployment_id, previous_release_digest: current.payload.release_digest,
        previous_revision: current.payload.publication_revision, publication_revision: current.payload.publication_revision + 1,
        release_digest: retained.release_digest, status: "SUCCEEDED",
      }), status: "ROLLED_BACK",
    }, deps, apply);
  } finally { lease.release(); }
}

/**
 * Complete the receipt for a promotion that moved the alias but whose process
 * was killed before it could write evidence. It never moves the alias: it only
 * accepts the exact staged deployment and candidate release already live.
 */
export async function executeReconcile({ approval, candidate, expected, deps, apply }) {
  const domain = await projectModule();
  checkReadiness(apply, deps, expected);
  if (apply && typeof deps.recordReceipt !== "function") refuse("E_PUBLICATION_RECEIPT", "durable receipt sink is required before mutation");
  const lease = await acquirePublicationLease({
    now: deps.now?.() ?? Date.now(),
    publisher: `reconcile:${approval.payload.publisher.vercel_user_id}:${expected.canonical_alias}`,
    stateDir: deps.stateDir,
  });
  try {
    const served = await deps.probe(expected.canonical_alias);
    if (served.release_digest !== candidate.release_digest) {
      refuse("E_RECONCILE_STATE", "live production is not serving the candidate release; nothing to reconcile");
    }
    const observation = await deps.readObservation(expected, served);
    if (observation.alias_target_deployment_id !== expected.staged_deployment_id) {
      refuse("E_RECONCILE_STATE", "live production alias does not point at the staged deployment");
    }
    // Re-run the gate with the already-advanced predecessor fields restored, so
    // approval, publisher, policy, version and platform-guard bindings are still
    // checked. This does not fabricate the live candidate identity above.
    const assessment = domain.assessProductionPublication({
      approval,
      candidate,
      expected: { ...expected, now: new Date(deps.now?.() ?? Date.now()).toISOString(), max_approval_age_ms: MAX_APPROVAL_AGE_MS },
      observation: {
        ...observation,
        alias_target_deployment_id: expected.predecessor_deployment_id,
        served_deployment_id: expected.predecessor_deployment_id,
        served_release_digest: expected.predecessor_release_digest,
      },
    });
    if (assessment.status !== "READY") {
      refuse("E_RECONCILE_STATE", assessment.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; "));
    }
    if (!apply) return { observation, status: "DRY_RUN" };
    return await finishPublication({
      receipt: domain.createPublicationReceipt({
        action: "PROMOTE",
        actor: approval.payload.publisher,
        approval_digest: approval.digest,
        candidate_digest: candidate.candidate_digest,
        canonical_alias: expected.canonical_alias,
        completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        deployment_id: expected.staged_deployment_id,
        detail: "reconciled a completed promotion after the publishing process was interrupted",
        hub_id: candidate.hub_id,
        policy_digest: candidate.policy_digest,
        previous_deployment_id: expected.predecessor_deployment_id,
        previous_release_digest: expected.predecessor_release_digest,
        previous_revision: expected.expected_revision,
        publication_revision: expected.expected_revision + 1,
        release_digest: candidate.release_digest,
        status: "SUCCEEDED",
      }),
      status: "RECONCILED",
    }, deps, apply);
  } finally {
    lease.release();
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) refuse("E_ARGUMENT", `unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (key === "apply") {
      values.apply = true;
      continue;
    }
    if (key === "genesis") {
      values.genesis = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) refuse("E_ARGUMENT", `--${key} requires a value`);
    values[key] = value;
    index += 1;
  }
  return { mode, values };
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) refuse("E_ARGUMENT", `--${key} is required`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { mode, values } = parseArgs(process.argv.slice(2));
  if (values.apply === true) assertPublicationPlatform();
  if (mode === "verify") {
    const alias = required(values, "alias");
    print(await probeReady(alias.startsWith("http") ? alias : `https://${alias}`));
    return;
  }
  if (mode === "promote" || mode === "reconcile") { required(values, "staged-deployment"); required(values, "staging"); }

  const teamId = required(values, "team");
  const expected = {
    canonical_alias: required(values, "alias"),
    expected_revision: Number(required(values, "expect-revision")),
    predecessor_deployment_id: required(values, "expect-deployment"),
    predecessor_release_digest: required(values, "expect-release"),
    production_branch: required(values, "production-branch"),
    project_id: required(values, "project"),
    publisher_vercel_user_id: required(values, "publisher"),
    staged_deployment_id: values["staged-deployment"],
    team_id: teamId,
  };
  if (!Number.isSafeInteger(expected.expected_revision) || expected.expected_revision < 0) refuse("E_ARGUMENT", "--expect-revision must be a non-negative integer");
  const token = vercelToken();
  const api = new VercelApi({ teamId, token });
  const probe = (url, options = {}) => probeReady(url.startsWith("http") ? url : `https://${url}`, options);
  const deps = {
    readiness: values.readiness === undefined ? undefined : JSON.parse(readFileSync(resolve(values.readiness), "utf8")),
    bypass: process.env.EGA_VERCEL_BYPASS_FILE ? readFileSync(process.env.EGA_VERCEL_BYPASS_FILE, "utf8").trim() : undefined,
    deployStagedProduction: () => {
      const output = runVercel(["deploy", "--prod", "--skip-domain", "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: teamId, token });
      const url = output.stdout.trim().split("\n").filter((line) => /^https:\/\//.test(line.trim())).at(-1)?.trim();
      if (!url) refuse("E_STAGE", "could not read the staged production deployment URL");
      const deployment = runVercel(["inspect", url, "--json"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: teamId, token });
      const parsed = JSON.parse(deployment.stdout);
      return { deployment_id: parsed.id, url };
    },
    now: () => Date.now(),
    probe,
    promote: (deployment) => {
      // Never pass --force: deployment checks must be allowed to block.
      runVercel(["promote", deployment, "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: teamId, token });
    },
    readObservation: async (expectation, served) => {
      const current = await api.readProduction({ ...expectation, canonical_alias: expectation.canonical_alias }, (alias) => probe(alias));
      return { ...current, served_deployment_id: current.alias_target_deployment_id, served_release_digest: served.release_digest };
    },
    readRecoveryObservation: (expectation) => api.readProduction(expectation),
    rollback: (deployment) => {
      runVercel(["rollback", deployment, "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: teamId, token });
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    stateDir: process.env.EGA_PUBLICATION_STATE_DIR,
  };

  if (mode === "rollback") {
    const domain = await projectModule();
    const chain = required(values, "chain").split(",").map((file) => domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(file.trim()), "utf8"))));
    const current = domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(required(values, "current")), "utf8")));
    const target = values.target === undefined ? undefined : domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(values.target), "utf8")));
    const previousCandidate = values["predecessor-candidate"] === undefined ? undefined : await readCandidate(values["predecessor-candidate"]);
    if (chain[0]?.digest !== current.digest) refuse("E_ROLLBACK_TARGET", "the receipt chain must start at --current");
    const result = await withPublicationReceipt(resolve(required(values, "receipt")), values.apply === true,
      (recordReceipt) => executeRollback({ apply: values.apply === true, chain, current, deps: { ...deps, recordReceipt }, expected, previousCandidate, target }));
    print(result);
    return;
  }



  if (mode === "stage") {
    const candidate = await readCandidate(required(values, "candidate"));
    const approval = (await projectModule()).verifyPublicationApproval(JSON.parse(readFileSync(resolve(required(values, "approval")), "utf8")));
    const staged = await executeStage({ approval, apply: values.apply === true, candidate, deps, expected });
    if (values["staging-out"] !== undefined && staged.staging) {
      const stagingPath = resolve(values["staging-out"]);
      mkdirSync(dirname(stagingPath), { recursive: true });
      writeFileSync(stagingPath, `${JSON.stringify(staged.staging, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    print(staged);
    return;
  }
  if (mode === "promote") {
    const candidate = await readCandidate(required(values, "candidate"));
    const domain = await projectModule();
    const approval = domain.verifyPublicationApproval(JSON.parse(readFileSync(resolve(required(values, "approval")), "utf8")));
    if (values["previous-receipt"] !== undefined) {
      const previous = domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(values["previous-receipt"]), "utf8")));
      if (previous.payload.publication_revision !== expected.expected_revision) refuse("E_REVISION_STALE", "the previous receipt does not match --expect-revision");
      if (previous.payload.release_digest !== expected.predecessor_release_digest || previous.payload.deployment_id !== expected.predecessor_deployment_id) {
        refuse("E_PREDECESSOR_MISMATCH", "the previous receipt does not match the expected predecessor");
      }
    } else if (expected.expected_revision !== 0 || values.genesis !== true) {
      refuse("E_REVISION_STALE", "promotion after the first release requires --previous-receipt; use --genesis only for revision 0");
    }
    const stagingDocument = JSON.parse(readFileSync(resolve(values.staging), "utf8"));
    const staging = stagingDocument.staging ?? stagingDocument;
    if (staging.deployment_id !== expected.staged_deployment_id || staging.release_digest !== candidate.release_digest || staging.candidate_digest !== candidate.candidate_digest || staging.approval_digest !== approval.digest || staging.previous_release_digest !== expected.predecessor_release_digest || staging.previous_deployment_id !== expected.predecessor_deployment_id) {
      refuse("E_STAGE", "the staging record does not bind this candidate, approval and predecessor");
    }
    const receiptPath = resolve(required(values, "receipt"));
    let result;
    try {
      result = await withPublicationReceipt(receiptPath, values.apply === true,
        (recordReceipt) => executePromotion({ approval, apply: values.apply === true, candidate, deps: { ...deps, recordReceipt }, expected }));
    } catch (error) {
      if (error?.receipt) {
        const failedPath = `${receiptPath}.failed.json`;
        mkdirSync(dirname(failedPath), { recursive: true });
        writeFileSync(failedPath, `${JSON.stringify(error.receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      }
      throw error;
    }
    print(result);
    return;
  }
  if (mode === "reconcile") {
    const candidate = await readCandidate(required(values, "candidate"));
    const domain = await projectModule();
    const approval = domain.verifyPublicationApproval(JSON.parse(readFileSync(resolve(required(values, "approval")), "utf8")));
    const stagingDocument = JSON.parse(readFileSync(resolve(required(values, "staging")), "utf8"));
    const staging = stagingDocument.staging ?? stagingDocument;
    if (staging.deployment_id !== expected.staged_deployment_id || staging.release_digest !== candidate.release_digest || staging.candidate_digest !== candidate.candidate_digest || staging.approval_digest !== approval.digest || staging.previous_release_digest !== expected.predecessor_release_digest || staging.previous_deployment_id !== expected.predecessor_deployment_id) {
      refuse("E_STAGE", "the staging record does not bind this candidate, approval and predecessor");
    }
    if (values["previous-receipt"] !== undefined) {
      const previous = domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(values["previous-receipt"]), "utf8")));
      if (previous.payload.publication_revision !== expected.expected_revision || previous.payload.release_digest !== expected.predecessor_release_digest || previous.payload.deployment_id !== expected.predecessor_deployment_id) {
        refuse("E_REVISION_STALE", "the previous receipt does not match the expected predecessor");
      }
    } else if (expected.expected_revision !== 0 || values.genesis !== true) {
      refuse("E_REVISION_STALE", "reconcile after the first release requires --previous-receipt; use --genesis only for revision 0");
    }
    const result = await withPublicationReceipt(resolve(required(values, "receipt")), values.apply === true,
      (recordReceipt) => executeReconcile({ approval, apply: values.apply === true, candidate, deps: { ...deps, recordReceipt }, expected }));
    print(result);
    return;
  }
  refuse("E_ARGUMENT", "mode must be stage, promote, reconcile, rollback or verify");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "E_PUBLICATION"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
