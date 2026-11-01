#!/usr/bin/env node
/**
 * Recover the canonical production alias after a failed live release.
 *
 * This helper is deliberately small and refuses to race a newer deployment:
 * it re-reads the canonical alias before selecting a predecessor and again
 * immediately before the promote write. It promotes a previously verified
 * deployment (never rollback, which can disable automatic production domain
 * assignment) and then proves the canonical runtime is healthy on it.
 *
 * Usage:
 *   node scripts/release/recover-production.mjs \
 *     --failed-deployment dpl_... [--previous-deployment dpl_...]
 *
 * Environment (same names as the verifier):
 *   EGA_VERIFY_ORIGIN               default https://ega-skills-mcp.vercel.app
 *   EGA_VERIFY_BYPASS               optional Vercel protection-bypass value
 *   EGA_VERIFY_TIMEOUT_MS           promotion/readiness bound (default 300000)
 *   EGA_VERIFY_POLL_MS              polling interval (default 5000)
 *   VERCEL_TOKEN                    required
 *   VERCEL_TEAM_ID                  optional team id
 *   VERCEL_PROJECT_ID               required
 *   VERCEL_CANONICAL_ALIAS          required
 *   VERCEL_API_BASE                 default https://api.vercel.com (test seam)
 *
 * Exit codes: 0 recovered or superseded no-op; 1 recovery failed.
 * Never prints the Vercel token or protection-bypass value.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigError,
  ciGateFailure,
  createVercelClient,
  probeReadyOnce,
} from "./verify-live.mjs";

const DEFAULT_ORIGIN = "https://ega-skills-mcp.vercel.app";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 5_000;

export class RecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecoveryError";
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RecoveryError(`${name} must be a positive integer`);
  return parsed;
}

export function parseRecoveryArgs(argv) {
  const result = { failedDeployment: null, previousDeployment: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--failed-deployment" || arg === "--previous-deployment") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
        throw new RecoveryError(`${arg} requires a deployment id`);
      }
      if (arg === "--failed-deployment") result.failedDeployment = value.trim();
      else result.previousDeployment = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--failed-deployment=")) {
      result.failedDeployment = arg.slice("--failed-deployment=".length).trim();
      continue;
    }
    if (arg.startsWith("--previous-deployment=")) {
      result.previousDeployment = arg.slice("--previous-deployment=".length).trim();
      continue;
    }
    throw new RecoveryError(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!result.failedDeployment) throw new RecoveryError("--failed-deployment is required");
  if (result.previousDeployment === result.failedDeployment) {
    throw new RecoveryError("--previous-deployment must differ from --failed-deployment");
  }
  return result;
}

export function readRecoveryConfig(env = process.env) {
  for (const name of ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_CANONICAL_ALIAS"]) {
    if (typeof env[name] !== "string" || env[name].trim() === "") throw new ConfigError(`${name} is required`);
  }
  let origin;
  try {
    origin = new URL(env.EGA_VERIFY_ORIGIN ?? DEFAULT_ORIGIN).origin;
  } catch {
    throw new ConfigError("EGA_VERIFY_ORIGIN must be an http(s) origin");
  }
  return {
    origin,
    bypass: env.EGA_VERIFY_BYPASS?.trim() || null,
    timeoutMs: positiveInteger(env.EGA_VERIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "EGA_VERIFY_TIMEOUT_MS"),
    pollMs: positiveInteger(env.EGA_VERIFY_POLL_MS, DEFAULT_POLL_MS, "EGA_VERIFY_POLL_MS"),
    vercel: {
      token: env.VERCEL_TOKEN.trim(),
      teamId: env.VERCEL_TEAM_ID?.trim() || null,
      projectId: env.VERCEL_PROJECT_ID.trim(),
      canonicalAlias: env.VERCEL_CANONICAL_ALIAS.trim().replace(/^https?:\/\//i, "").replace(/\/$/, ""),
      baseUrl: env.VERCEL_API_BASE?.trim() || "https://api.vercel.com",
    },
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function writeSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export function deploymentOrigin(deployment) {
  const value = deployment?.url;
  if (typeof value !== "string" || value.trim() === "") return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

export function deploymentTimestamp(deployment) {
  const value = deployment?.created ?? deployment?.createdAt ?? deployment?.created_at ?? 0;
  const numeric = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** Read /readyz once (with a few short retries) and return its release digest. */
export async function readDeploymentDigest(origin, { bypass, fetchImpl = fetch, attempts = 3, delayMs = 300 } = {}) {
  let last = { healthStatus: null, readyStatus: null, digest: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probeReadyOnce({ origin, bypass, fetchImpl });
    if (last.readyStatus === 200 && typeof last.digest === "string" && last.digest.startsWith("sha256:")) return last;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return last;
}

async function ciGateFailed(vercel, deploymentId) {
  try {
    const body = await vercel.readDeploymentChecks(deploymentId);
    return ciGateFailure(Array.isArray(body) ? body : body?.runs ?? body?.checks) !== null;
  } catch (error) {
    if (error?.status === 404) return false;
    throw error;
  }
}

function deploymentIdOf(deployment) {
  return deployment?.id ?? deployment?.uid ?? null;
}

/**
 * Choose the previous production deployment.
 *
 * Explicit ids are still probed and must serve a release digest. Automatic
 * selection only considers READY deployments created before the failed one,
 * skips failed ci-gate checks, and takes the newest healthy candidate.
 */
export async function choosePreviousDeployment({ vercel, config, failedDeployment, previousDeployment, fetchImpl = fetch }) {
  const listDeployments = async () => {
    const query = new URLSearchParams({ projectId: config.vercel.projectId, target: "production", limit: "100" });
    const listed = await vercel.get(`/v6/deployments?${query.toString()}`);
    return Array.isArray(listed) ? listed : Array.isArray(listed?.deployments) ? listed.deployments : [];
  };

  if (previousDeployment) {
    let deployment;
    try {
      deployment = await vercel.readDeployment(previousDeployment);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    if (deploymentIdOf(deployment) !== previousDeployment) {
      const deployments = await listDeployments();
      deployment = deployments.find((entry) => deploymentIdOf(entry) === previousDeployment);
    }
    if (deploymentIdOf(deployment) !== previousDeployment) throw new RecoveryError("previous deployment identity mismatch");
    if (await ciGateFailed(vercel, previousDeployment)) throw new RecoveryError("previous deployment has a failed ci-gate check");
    const origin = deploymentOrigin(deployment);
    if (!origin) throw new RecoveryError("previous deployment has no URL");
    const ready = await readDeploymentDigest(origin, { bypass: config.bypass, fetchImpl });
    if (ready.readyStatus !== 200 || typeof ready.digest !== "string") {
      throw new RecoveryError("previous deployment /readyz is not healthy");
    }
    return { deployment, digest: ready.digest, source: "argument" };
  }

  const deployments = await listDeployments();
  const failedFromList = deployments.find((entry) => deploymentIdOf(entry) === failedDeployment);
  let cutoff = deploymentTimestamp(failedFromList);
  if (cutoff <= 0) cutoff = deploymentTimestamp(await vercel.readDeployment(failedDeployment));
  if (cutoff <= 0) throw new RecoveryError("cannot determine when the failed deployment was created");
  const candidates = deployments
    .filter((entry) => deploymentIdOf(entry) !== failedDeployment)
    .filter((entry) => String(entry?.readyState ?? "").toUpperCase() === "READY")
    .filter((entry) => deploymentTimestamp(entry) < cutoff)
    .sort((left, right) => deploymentTimestamp(right) - deploymentTimestamp(left));

  // Prefer an immutable Git production deployment over a local CLI/prebuilt
  // deployment. The old publisher left READY CLI deployments that serve a
  // different artifact; they are not the previous canonical release even when
  // their /readyz is healthy.
  const cleanGit = candidates.filter((entry) => {
    const meta = entry?.meta ?? {};
    return meta.gitDirty !== "1" && (meta.githubDeployment === "1" || meta.githubCommitSha !== undefined);
  });
  const ordered = [...cleanGit, ...candidates.filter((entry) => !cleanGit.includes(entry))];

  for (const candidate of ordered) {
    const id = deploymentIdOf(candidate);
    if (typeof id !== "string" || id === "") continue;
    if (await ciGateFailed(vercel, id)) continue;
    const origin = deploymentOrigin(candidate);
    if (!origin) continue;
    const ready = await readDeploymentDigest(origin, { bypass: config.bypass, fetchImpl });
    if (ready.readyStatus === 200 && typeof ready.digest === "string") {
      return { deployment: candidate, digest: ready.digest, source: "listed" };
    }
  }
  throw new RecoveryError("no older READY production deployment is healthy");
}

export async function waitForCanonicalDigest({
  origin,
  expectedDigest,
  bypass,
  timeoutMs,
  pollMs,
  fetchImpl = fetch,
  now = Date.now,
  pause = sleep,
}) {
  const deadline = now() + timeoutMs;
  let last = { healthStatus: null, readyStatus: null, digest: null };
  for (;;) {
    last = await probeReadyOnce({ origin, bypass, fetchImpl, timeoutMs: Math.min(20_000, Math.max(1, deadline - now())) });
    if (last.readyStatus === 200 && last.digest === expectedDigest) return { ok: true, ...last };
    if (now() >= deadline) return { ok: false, ...last };
    await pause(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

async function reenableFuturePublication(vercel, projectId) {
  const path = `/v9/projects/${encodeURIComponent(projectId)}`;
  const project = await vercel.get(path);
  const before = project?.autoAssignCustomDomains;
  const createDeploymentsBefore = project?.gitProviderOptions?.createDeployments ?? null;
  let current = project;
  let patched = false;
  if (before !== true) {
    await vercel.patch(path, { autoAssignCustomDomains: true });
    patched = true;
    current = await vercel.get(path);
  }
  // `createDeployments` is not the deployment permission; it controls the
  // GitHub deployment event that the verification workflow consumes. Keep it
  // enabled if the failed attempt changed it.
  if (createDeploymentsBefore !== "enabled") {
    await vercel.patch(path, { gitProviderOptions: { createDeployments: "enabled" } });
    patched = true;
    current = await vercel.get(path);
  }
  const after = current?.autoAssignCustomDomains;
  const createDeploymentsAfter = current?.gitProviderOptions?.createDeployments ?? null;
  const command = current?.commandForIgnoringBuildStep;
  const commandEmpty = command === null || command === undefined || String(command).trim() === "";
  const blockers = [];
  if (after !== true) blockers.push("autoAssignCustomDomains is not true after recovery");
  if (createDeploymentsAfter !== "enabled") blockers.push("gitProviderOptions.createDeployments is not enabled after recovery");
  if (!commandEmpty) blockers.push(`commandForIgnoringBuildStep is set (${String(command)}); automatic releases are disabled`);
  return {
    before: before ?? null,
    after: after ?? null,
    create_deployments_before: createDeploymentsBefore,
    create_deployments_after: createDeploymentsAfter,
    patched,
    command_for_ignoring_build_step: command ?? null,
    blockers,
    ok: after === true && createDeploymentsAfter === "enabled" && commandEmpty,
  };
}

export async function recoverProduction({ env = process.env, argv = process.argv.slice(2), fetchImpl = fetch, now = Date.now, pause = sleep } = {}) {
  const summary = {
    ok: false,
    exit_code: 1,
    superseded: false,
    failed_deployment: null,
    previous_deployment: null,
    canonical_alias: env.VERCEL_CANONICAL_ALIAS ?? null,
    canonical_alias_target_before: null,
    canonical_alias_target_after: null,
    release_digest: null,
    recovered: false,
    failed_release: { deployment_id: null, reason: "live verification failed after promotion" },
    auto_publication: null,
    blockers: [],
  };
  try {
    const args = parseRecoveryArgs(argv);
    summary.failed_deployment = args.failedDeployment;
    summary.failed_release.deployment_id = args.failedDeployment;
    const config = readRecoveryConfig(env);
    summary.canonical_alias = config.vercel.canonicalAlias;
    const vercel = createVercelClient({
      token: config.vercel.token,
      teamId: config.vercel.teamId,
      baseUrl: config.vercel.baseUrl,
      fetchImpl,
      timeoutMs: Math.min(30_000, config.timeoutMs),
    });

    // Never overwrite a newer canonical deployment.
    const before = await vercel.readAlias(config.vercel.canonicalAlias);
    summary.canonical_alias_target_before = before.deploymentId;
    if (before.deploymentId !== args.failedDeployment) {
      Object.assign(summary, {
        ok: true,
        exit_code: 0,
        superseded: true,
        reason: "canonical alias no longer points at the failed deployment; no write performed",
      });
      writeSummary(summary);
      return 0;
    }

    const previous = await choosePreviousDeployment({
      vercel,
      config,
      failedDeployment: args.failedDeployment,
      previousDeployment: args.previousDeployment,
      fetchImpl,
    });
    summary.previous_deployment = deploymentIdOf(previous.deployment);
    summary.release_digest = previous.digest;

    // Re-read immediately before the only write: a concurrent promotion wins.
    const guard = await vercel.readAlias(config.vercel.canonicalAlias);
    if (guard.deploymentId !== args.failedDeployment) {
      Object.assign(summary, {
        ok: false,
        exit_code: 1,
        aborted: true,
        reason: "canonical alias changed before promotion; refusing to overwrite it",
        canonical_alias_target_after: guard.deploymentId,
      });
      writeSummary(summary);
      return 1;
    }

    await vercel.post(
      `/v10/projects/${encodeURIComponent(config.vercel.projectId)}/promote/${encodeURIComponent(summary.previous_deployment)}`,
    );

    const healthy = await waitForCanonicalDigest({
      origin: config.origin,
      expectedDigest: previous.digest,
      bypass: config.bypass,
      timeoutMs: config.timeoutMs,
      pollMs: config.pollMs,
      fetchImpl,
      now,
      pause,
    });
    const after = await vercel.readAlias(config.vercel.canonicalAlias);
    summary.canonical_alias_target_after = after.deploymentId;
    summary.canonical_ready_status = healthy.readyStatus;
    summary.canonical_digest = healthy.digest;
    if (!healthy.ok) {
      summary.blockers.push("canonical /readyz did not return the previous release digest");
    }

    const autoPublication = await reenableFuturePublication(vercel, config.vercel.projectId);
    summary.auto_publication = autoPublication;
    summary.blockers.push(...autoPublication.blockers);
    const healthyOnPrevious = healthy.ok && after.deploymentId === summary.previous_deployment;
    if (!healthyOnPrevious && healthy.ok) {
      summary.blockers.push("canonical alias does not point at the promoted previous deployment");
    }
    summary.recovered = healthyOnPrevious;
    const ok = healthyOnPrevious && autoPublication.ok;
    Object.assign(summary, {
      ok,
      exit_code: ok ? 0 : 1,
      reason: ok ? "recovered previous production deployment" : "recovery incomplete",
    });
    writeSummary(summary);
    return ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.ok = false;
    summary.exit_code = 1;
    summary.reason = message;
    writeSummary(summary);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const code = await recoverProduction();
  process.exitCode = code;
}
