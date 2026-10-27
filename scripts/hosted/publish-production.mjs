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
 *            predecessor, acquire the publication lease, create a PREVIEW
 *            deployment (never the public domain) and prove that deployment
 *            serves the exact candidate digest.
 *   promote  re-verify everything, re-read the live alias and served digest
 *            immediately before the write, require Git production auto-deploy
 *            to be disabled and the canonical alias to be the only production
 *            alias, promote WITHOUT --force, then poll the alias and the served
 *            digest. A mismatch triggers an automatic restore of the recorded
 *            predecessor when, and only when, this promotion is still the
 *            current one.
 *   rollback promote a previously recorded deployment and verify its digest.
 *
 * Every outcome writes an append-only receipt bound to the approval, candidate,
 * predecessor, deployment and publication revision. The receipt chain is the
 * rollback authority.
 *
 * ## Residual risk (explicit, not hidden)
 *
 * A Vercel principal that can independently promote or assign the production
 * alias can still bypass this script. The gate therefore requires the operator
 * to remove that capability from every other principal and to disable Git
 * production deployments; it verifies the observable settings before each
 * write. If the platform cannot prove exclusivity, this script refuses rather
 * than claiming an atomic guarantee. See
 * docs/operations/RELEASE-2.0-RUNBOOK.md ("Production publication boundary").
 *
 * Usage:
 *   node scripts/hosted/publish-production.mjs stage \
 *     --candidate <dir> --approval <approval.json> \
 *     --team <team_id> --project <project_id> \
 *     --production-branch release/2.0 \
 *     --alias ega-skills-mcp.vercel.app \
 *     --expect-release <sha256:...> --expect-deployment <dpl_...> \
 *     --expect-revision <n> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs promote \
 *     --staging <staging.json> --candidate <dir> --approval <approval.json> \
 *     ...same target flags... --receipt <receipt.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs rollback \
 *     --receipt <current.json> --to <earlier.json> --receipt <new.json> [--apply]
 *
 * `--apply` performs the Vercel mutation. Without it the script verifies and
 * prints the plan, contacting only read-only endpoints.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * Acquire an owner-bound exclusive lease. `mkdir` is atomic on every supported
 * host, so two publishers cannot both create the directory. A stale owner is
 * reclaimed only after re-reading the exact owner marker and moving that exact
 * directory aside; a concurrent replacement owner is never removed.
 */
export async function acquirePublicationLease(options = {}) {
  const stateDir = resolve(options.stateDir ?? defaultStateDir());
  const owner = {
    acquired_at: new Date(options.now ?? Date.now()).toISOString(),
    expires_at: new Date((options.now ?? Date.now()) + (options.ttlMs ?? 30 * 60_000)).toISOString(),
    host: hostname(),
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    publisher: options.publisher ?? "unknown",
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = leasePath(stateDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(file, { mode: 0o700 });
      writeFileSync(join(file, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      return { owner, path: file, release: () => releasePublicationLease({ file, nonce: owner.nonce }) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readLease(join(file, "owner.json"));
      if (current === undefined) {
        refuse("E_PUBLICATION_LEASE", "publication lease exists but has no readable owner marker; refusing to reclaim it");
      }
      if (Date.parse(current.expires_at) > (options.now ?? Date.now())) {
        refuse("E_PUBLICATION_LEASE", `another publisher holds the lease (${current.publisher} on ${current.host}, expires ${current.expires_at})`);
      }
      const aside = `${file}.stale-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(file, aside);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        refuse("E_PUBLICATION_LEASE", "could not reclaim the stale publication lease atomically");
      }
      if (readLease(join(aside, "owner.json"))?.nonce !== current.nonce) {
        // A replacement owner appeared between the read and the move. Put the
        // directory back only if the name is free; never delete it.
        try {
          renameSync(aside, file);
        } catch {}
        refuse("E_PUBLICATION_LEASE", "publication lease owner changed during reclamation");
      }
      rmSync(aside, { recursive: true, force: true });
    }
  }
  refuse("E_PUBLICATION_LEASE", "could not acquire the publication lease");
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
  const productionBranch = project?.link?.productionBranch ?? git.productionBranch;
  if (typeof productionBranch !== "string" || productionBranch.length === 0) {
    refuse("E_PLATFORM_GUARD", "the Vercel production branch is not observable; refusing to infer it");
  }
  const linkedRepository = typeof project?.link?.org === "string" && typeof project?.link?.repo === "string"
    ? `${project.link.org}/${project.link.repo}`
    : undefined;
  const policyRules = project?.deploymentPolicy?.gitSources;
  const policyDisabledProduction = Array.isArray(policyRules) && policyRules.some((rule) => {
    if (rule?.enabled !== false || !Array.isArray(rule.environments) || !rule.environments.includes("production")) return false;
    const sources = rule.sources;
    // An empty source list is deny-all for that rule. A source-scoped rule only
    // covers this project when it names the linked repository; otherwise it
    // disables production for some other integration and proves nothing.
    if (!Array.isArray(sources) || sources.length === 0) return true;
    return typeof linkedRepository === "string" && sources.every((entry) => typeof entry === "string") && sources.includes(linkedRepository);
  });
  const providerDisabled = project?.gitProviderOptions?.createDeployments === "disabled";
  const legacyDisabled = enabled === false || (enabled !== null && typeof enabled === "object" && enabled[productionBranch] === false);
  const autoDeploy = !(legacyDisabled || policyDisabledProduction || providerDisabled);
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
    const served = await probe(expected.canonical_alias);
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

function runVercel(args, { token, scope, cwd }) {
  const result = spawnSync(process.platform === "win32" ? "vercel.cmd" : "vercel", [...args, ...(scope ? ["--scope", scope] : [])], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, VERCEL_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) refuse("E_VERCEL_CLI", `vercel ${args[0]} failed with status ${result.status}`);
  return { stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

/**
 * A failed or interrupted promotion is restored only when this promotion is
 * still the current one. If another publication already won, restoring would
 * clobber a newer release, so it is refused instead.
 */
async function restoreAfterFailure({ approval, candidate, deps, expected }) {
  if (typeof deps.rollback !== "function") return undefined;
  const served = await deps.probe(expected.canonical_alias);
  const observed = await deps.readObservation(expected, served);
  if (observed.alias_target_deployment_id !== expected.staged_deployment_id) {
    refuse("E_PUBLICATION_SUPERSEDED", "promotion was superseded by another publication; refusing to restore over it");
  }
  deps.rollback(expected.predecessor_deployment_id);
  const restored = await deps.probe(expected.canonical_alias);
  if (restored.release_digest !== expected.predecessor_release_digest) {
    refuse("E_ROLLBACK_UNVERIFIED", "automatic restore did not return the predecessor release digest");
  }
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
    publication_revision: expected.expected_revision + 1,
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
      deps.promote(expected.staged_deployment_id);
      promoted = true;
      const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
      let attempts = 0;
      for (;;) {
        const served = await deps.probe(expected.canonical_alias);
        observed = await deps.readObservation(expected, served);
        if (observed.alias_target_deployment_id === expected.staged_deployment_id && served.release_digest === candidate.release_digest) break;
        attempts += 1;
        if (!apply || attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) {
          refuse("E_PROMOTION_UNVERIFIED", "the production alias did not reach the staged deployment and release digest");
        }
        await deps.sleep?.(PROMOTE_POLL_MS);
      }
    } catch (error) {
      if (promoted) {
        const receipt = await restoreAfterFailure({ approval, candidate, deps, expected });
        if (receipt && typeof error === "object" && error !== null) error.receipt = receipt;
      }
      throw error;
    }

    return {
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
    };
  } finally {
    lease.release();
  }
}

/**
 * Stage a preview deployment and prove its release identity. It never passes
 * `--prod`, so the public alias cannot move during staging.
 */
export async function executeStage({ approval, candidate, expected, deps, apply }) {
  const domain = await projectModule();
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

    const deployed = deps.deployPreview();
    if (typeof deployed?.deployment_id !== "string") refuse("E_STAGE", "the staging deployment did not report an id");
    const staged = await deps.probe(deployed.url, { bypass: deps.bypass });
    if (staged.release_digest !== candidate.release_digest) refuse("E_STAGE", "the staged deployment serves a different release digest");

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
export async function executeRollback({ chain, current, target, deps, apply }) {
  const domain = await projectModule();
  if (!Array.isArray(chain) || chain.length === 0) refuse("E_ROLLBACK_TARGET", "the full receipt chain is required");
  if (chain[0]?.digest !== current.digest) refuse("E_ROLLBACK_TARGET", "the receipt chain does not start at the current publication");
  for (let index = 1; index < chain.length; index += 1) {
    domain.verifyPublicationReceipt(chain[index - 1], chain[index]);
  }
  if (!chain.some((receipt) => receipt.digest === target.digest)) refuse("E_ROLLBACK_TARGET", "the rollback target is not in this receipt chain");
  if (current.payload.publication_revision <= target.payload.publication_revision) {
    refuse("E_ROLLBACK_TARGET", "the rollback target must precede the current publication");
  }
  if (target.payload.release_digest === current.payload.release_digest) refuse("E_ROLLBACK_TARGET", "the rollback target already matches the current release");

  const lease = await acquirePublicationLease({
    now: deps.now?.() ?? Date.now(),
    publisher: `rollback:${current.payload.actor.vercel_user_id}:${current.payload.canonical_alias}`,
    stateDir: deps.stateDir,
  });
  try {
    const verifyCurrent = async () => {
      const served = await deps.probe(current.payload.canonical_alias);
      if (served.release_digest !== current.payload.release_digest) {
        refuse("E_PREDECESSOR_MISMATCH", "live production is not at the current receipt; refusing to roll back over an unknown release");
      }
      return served;
    };
    await verifyCurrent();
    if (!apply) return { status: "DRY_RUN", target: target.digest };

    // Re-read immediately before the mutation. The alias has no CAS; the lease
    // serializes supported publishers and this re-read rejects an outside move.
    await verifyCurrent();
    deps.promote(target.payload.deployment_id);
    const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
    let attempts = 0;
    for (;;) {
      const now = await deps.probe(current.payload.canonical_alias);
      if (now.release_digest === target.payload.release_digest) break;
      attempts += 1;
      if (attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) refuse("E_ROLLBACK_UNVERIFIED", "the production alias did not return the retained release digest");
      await deps.sleep?.(PROMOTE_POLL_MS);
    }

    return {
      receipt: domain.createPublicationReceipt({
        action: "ROLLBACK",
        actor: current.payload.actor,
        approval_digest: target.payload.approval_digest,
        candidate_digest: target.payload.candidate_digest,
        canonical_alias: current.payload.canonical_alias,
        completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        deployment_id: target.payload.deployment_id,
        detail: `rolled back to publication receipt ${target.digest}`,
        hub_id: target.payload.hub_id,
        policy_digest: target.payload.policy_digest,
        previous_deployment_id: current.payload.deployment_id,
        previous_release_digest: current.payload.release_digest,
        previous_revision: current.payload.publication_revision,
        publication_revision: current.payload.publication_revision + 1,
        release_digest: target.payload.release_digest,
        status: "SUCCEEDED",
      }),
      status: "ROLLED_BACK",
    };
  } finally {
    lease.release();
  }
}
/**
 * Complete the receipt for a promotion that moved the alias but whose process
 * was killed before it could write evidence. It never moves the alias: it only
 * accepts the exact staged deployment and candidate release already live.
 */
export async function executeReconcile({ approval, candidate, expected, deps, apply }) {
  const domain = await projectModule();
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
  return {
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
  };
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
  if (mode === "verify") {
    const alias = required(values, "alias");
    print(await probeReady(alias.startsWith("http") ? alias : `https://${alias}`));
    return;
  }
  const expected = {
    canonical_alias: required(values, "alias"),
    expected_revision: Number(required(values, "expect-revision")),
    predecessor_deployment_id: required(values, "expect-deployment"),
    predecessor_release_digest: required(values, "expect-release"),
    production_branch: required(values, "production-branch"),
    project_id: required(values, "project"),
    publisher_vercel_user_id: required(values, "publisher"),
    staged_deployment_id: values["staged-deployment"],
    team_id: required(values, "team"),
  };
  if (mode === "promote") { required(values, "staged-deployment"); required(values, "staging"); }
  if (!Number.isSafeInteger(expected.expected_revision) || expected.expected_revision < 0) refuse("E_ARGUMENT", "--expect-revision must be a non-negative integer");

  const token = vercelToken();
  const api = new VercelApi({ teamId: expected.team_id, token });
  const probe = (url, options = {}) => probeReady(url.startsWith("http") ? url : `https://${url}`, options);
  const deps = {
    bypass: process.env.EGA_VERCEL_BYPASS_FILE ? readFileSync(process.env.EGA_VERCEL_BYPASS_FILE, "utf8").trim() : undefined,
    deployPreview: () => {
      const output = runVercel(["deploy", "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: expected.team_id, token });
      const url = output.stdout.trim().split("\n").filter((line) => /^https:\/\//.test(line.trim())).at(-1)?.trim();
      if (!url) refuse("E_STAGE", "could not read the preview deployment URL");
      const deployment = runVercel(["inspect", url, "--json"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: expected.team_id, token });
      const parsed = JSON.parse(deployment.stdout);
      return { deployment_id: parsed.id, url };
    },
    now: () => Date.now(),
    probe,
    promote: (deployment) => {
      // Never pass --force: deployment checks must be allowed to block.
      runVercel(["promote", deployment, "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: expected.team_id, token });
    },
    readObservation: async (expectation, served) => {
      const current = await api.readProduction({ ...expectation, canonical_alias: expectation.canonical_alias }, (alias) => probe(alias));
      return { ...current, served_deployment_id: current.alias_target_deployment_id, served_release_digest: served.release_digest };
    },
    rollback: (deployment) => {
      runVercel(["rollback", deployment, "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: expected.team_id, token });
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    stateDir: process.env.EGA_PUBLICATION_STATE_DIR,
  };

  if (mode === "stage") {
    const candidate = await readCandidate(required(values, "candidate"));
    const approval = (await projectModule()).verifyPublicationApproval(JSON.parse(readFileSync(resolve(required(values, "approval")), "utf8")));
    print(await executeStage({ approval, apply: values.apply === true, candidate, deps, expected }));
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
    const staging = JSON.parse(readFileSync(resolve(values.staging), "utf8"));
    if (staging.deployment_id !== expected.staged_deployment_id || staging.release_digest !== candidate.release_digest || staging.approval_digest !== approval.digest || staging.previous_release_digest !== expected.predecessor_release_digest) {
      refuse("E_STAGE", "the staging record does not bind this candidate, approval and predecessor");
    }
    const receiptPath = resolve(required(values, "receipt"));
    const writeReceipt = (receipt) => {
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    };
    let result;
    try {
      result = await executePromotion({ approval, apply: values.apply === true, candidate, deps, expected });
    } catch (error) {
      if (error?.receipt) writeReceipt(error.receipt);
      throw error;
    }
    if (result.receipt) writeReceipt(result.receipt);
    print(result);
    return;
  }
  if (mode === "reconcile") {
    const candidate = await readCandidate(required(values, "candidate"));
    const domain = await projectModule();
    const approval = domain.verifyPublicationApproval(JSON.parse(readFileSync(resolve(required(values, "approval")), "utf8")));
    const staging = JSON.parse(readFileSync(resolve(required(values, "staging")), "utf8"));
    if (staging.deployment_id !== expected.staged_deployment_id || staging.release_digest !== candidate.release_digest || staging.approval_digest !== approval.digest || staging.previous_release_digest !== expected.predecessor_release_digest) {
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
    const result = await executeReconcile({ approval, apply: values.apply === true, candidate, deps, expected });
    if (result.receipt) {
      const receiptPath = resolve(required(values, "receipt"));
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    print(result);
    return;
  }
  if (mode === "rollback") {
    const domain = await projectModule();
    const chain = required(values, "chain").split(",").map((file) => domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(file.trim()), "utf8"))));
    const current = domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(required(values, "current")), "utf8")));
    const target = domain.verifyPublicationReceipt(JSON.parse(readFileSync(resolve(required(values, "target")), "utf8")));
    if (chain[0]?.digest !== current.digest) refuse("E_ROLLBACK_TARGET", "the receipt chain must start at --current");
    const result = await executeRollback({ apply: values.apply === true, chain, current, deps, target });
    if (result.receipt) {
      const receiptPath = resolve(required(values, "receipt"));
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    print(result);
    return;
  }
  refuse("E_ARGUMENT", "mode must be stage, promote, reconcile, rollback or verify");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "E_PUBLICATION"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
