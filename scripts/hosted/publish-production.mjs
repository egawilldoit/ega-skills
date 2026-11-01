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
 *            to be disabled and every production alias to be the canonical
 *            alias or a narrowly recognized direct Vercel-managed alias on the
 *            same deployment, promote WITHOUT --force, then poll the alias and
 *            the served digest. A mismatch triggers an automatic restore of the recorded
 *            predecessor when, and only when, this promotion is still the
 *            current one.
 *   reconcile record an already-live staged promotion after the process died.
 *   rollback restore a previously recorded deployment and verify its digest.
 *
 * Every completed promotion or rollback writes a write-once final receipt bound
 * to the approval, candidate, predecessor, deployment and publication revision;
 * the fsynced PENDING intent is retained separately and never overwritten.
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
 *     --production-branch main \
 *     --alias ega-skills-mcp.vercel.app \
 *     --expect-release <sha256:...> --expect-deployment <dpl_...> \
 *     --expect-revision <n> --expect-source-commit <sha> \
 *     --staging-out <staging.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs promote \
 *     --staging <staging.json> --candidate <dir> --approval <approval.json> \
 *     ...same target flags... --staged-deployment <dpl_...> \
 *     --expect-source-commit <sha> \
 *     (--previous-receipt <last.json> | --genesis) \
 *     --receipt <receipt.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs reconcile \
 *     --candidate <dir> --approval <approval.json> --staging <staging.json> \
 *     ...same target flags... --staged-deployment <dpl_...> \
 *     --expect-source-commit <sha> \
 *     (--previous-receipt <last.json> | --genesis) \
 *     --receipt <receipt.json> [--apply]
 *
 *   node scripts/hosted/publish-production.mjs rollback \
 *     --chain <newest.json,...> --current <newest.json> --target <older.json> \
 *     ...same target flags... --receipt <new.json> [--apply]
 *   For the first governed release, replace --target with
 *     --predecessor-candidate <verified-retained-original-candidate-dir>.
 *
 *   node scripts/hosted/publish-production.mjs baseline-authorize \
 *     --payload <authorization-payload.json> --out <authorization.json>
 *
 *   node scripts/hosted/publish-production.mjs baseline \
 *     --authorization <authorization.json> \
 *     --predecessor-source <clean-worktree-at-live-deployment-commit> \
 *     --migration-source <clean-worktree-at-reviewed-migration-commit> \
 *     ...target flags... --staging-out <staging.json> \
 *     --receipt <receipt.json> [--readiness <record.json> --apply]
 *
 *   node scripts/hosted/publish-production.mjs baseline-reconcile \
 *     --authorization ... --predecessor-source ... --migration-source ... \
 *     ...target flags... --staging <staging.json> --receipt <new.json> [--apply]
 *
 * Applying commands also require --readiness <externally-certified-record.json>.
 * `--apply` performs the Vercel mutation. Without it the script verifies and
 * prints the plan, contacting only read-only endpoints.
 */

import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";

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
const DEPLOYMENT_ID_RE = /^dpl_[A-Za-z0-9]{8,}$/;

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
 * Tolerant probe used ONLY to classify the legacy readiness shape. It never
 * converts a 200 into predecessor proof: the baseline migration gate requires
 * the exact legacy shape (ready, no digest), the live alias target, the
 * immutable source commit and the retained artifact tree to agree.
 */
export async function probeLegacyReady(url, options = {}) {
  const target = new URL("/readyz", url.endsWith("/") ? url : `${url}/`);
  if (target.protocol !== "https:" && target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
    refuse("E_PROBE_URL", "the legacy readiness probe must use HTTPS");
  }
  const headers = {};
  if (options.bypass) headers["x-vercel-protection-bypass"] = options.bypass;
  let response;
  try {
    response = await (options.fetch ?? fetch)(target, { headers, signal: options.signal });
  } catch {
    return { shape: "unavailable" };
  }
  const body = await response.json().catch(() => undefined);
  if (response.status !== 200 || body?.status !== "ready" || body === null || typeof body !== "object") return { shape: "unavailable" };
  if (!Object.hasOwn(body, "release_digest")) return { shape: "legacy" };
  if (typeof body.release_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.release_digest)) {
    // A present-but-malformed identity is a broken runtime, not a legacy one.
    return { shape: "unavailable" };
  }
  return { shape: "digest", release_digest: body.release_digest };
}

/**
 * Runbook artifact-tree digest, reproduced without a shell:
 *   find <root>/<artifact> -type f -exec sha256sum {} \; | LC_ALL=C sort -k2 | sha256sum
 * Paths are repository-relative, so the digest is stable across worktrees and
 * platforms (the repository's runbook uses this exact form).
 */
export function artifactTreeDigest(rootDirectory, artifactRelativePath) {
  const root = resolve(rootDirectory);
  const artifactRoot = resolve(root, artifactRelativePath);
  if (!artifactRoot.startsWith(`${root}${sep}`)) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "artifact directory escapes the source root");
  }
  if (!existsSync(artifactRoot) || !lstatSync(artifactRoot).isDirectory()) {
    refuse("E_BASELINE_SOURCE_MISMATCH", `artifact directory ${artifactRelativePath} is missing`);
  }
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        refuse("E_BASELINE_SOURCE_MISMATCH", `artifact contains a symlink: ${relative(root, absolute)}`);
      }
      if (info.isDirectory()) walk(absolute);
      else if (info.isFile()) files.push({ absolute, path: relative(root, absolute).split(sep).join("/") });
      else refuse("E_BASELINE_SOURCE_MISMATCH", `artifact contains a non-regular entry: ${relative(root, absolute)}`);
    }
  };
  walk(artifactRoot);
  const lines = files.map(({ absolute, path }) => {
    const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    return `${hash}  ${path}`;
  });
  lines.sort((left, right) => {
    const leftPath = left.slice(66);
    const rightPath = right.slice(66);
    return Buffer.compare(Buffer.from(leftPath, "utf8"), Buffer.from(rightPath, "utf8"));
  });
  return `sha256:${createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex")}`;
}

function gitValue(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) refuse("E_BASELINE_SOURCE_MISMATCH", `git ${args.at(-1)} failed in the baseline source worktree`);
  return result.stdout.trim();
}

/**
 * The normal publisher must also run from the exact tested checkout. A dirty
 * worktree has no source identity and is never a valid stage/promote source.
 */
export function currentSourceCommit(repoRoot = REPO_ROOT) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  if (head.status !== 0) refuse("E_SOURCE_COMMIT", "cannot read the tested source commit");
  const status = spawnSync("git", ["-c", "core.filemode=false", "status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  if (status.status !== 0 || status.stdout.trim() !== "") {
    refuse("E_SOURCE_DIRTY", "the publication source checkout must be clean and at the tested commit");
  }
  return head.stdout.trim();
}

/**
 * The operator must name the owner-approved runtime source commit and run from
 * that exact clean checkout. The commit must be reachable from the release
 * branch; a clean but unmerged local commit is not a release source.
 */
export function verifyApprovedSourceCommit(expectedCommit, releaseRef = process.env.EGA_RELEASE_REF ?? "origin/main", repoRoot = REPO_ROOT) {
  if (typeof expectedCommit !== "string" || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    refuse("E_SOURCE_COMMIT", "--expect-source-commit must be a full lowercase 40-hex commit");
  }
  const head = currentSourceCommit(repoRoot);
  if (head !== expectedCommit) {
    refuse("E_SOURCE_COMMIT", `the checkout HEAD ${head} is not the approved source commit ${expectedCommit}`);
  }
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", expectedCommit, releaseRef], { cwd: repoRoot, encoding: "utf8" });
  if (ancestor.status !== 0) {
    refuse("E_SOURCE_COMMIT", `the approved source commit is not reachable from ${releaseRef}`);
  }
  return head;
}

/**
 * The migration runtime source must be reachable from the configured
 * production branch. This is the main-branch binding: a reviewed local commit
 * that is not merged into `origin/main` is not a release source. The artifact
 * source is bound separately (it is the live predecessor commit) and is
 * therefore intentionally not required to be reachable from `main`.
 */
export function verifyBaselineSourceReachability({ directory, expectedCommit, productionBranch, repoRoot = directory }) {
  if (typeof productionBranch !== "string" || productionBranch.length === 0) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "the production branch must be named to verify runtime-source ancestry");
  }
  // Resolve the branch in the publisher's repository, not in a possibly
  // separate operator-supplied worktree whose remote refs could be rewritten.
  const refRoot = resolve(repoRoot);
  const ref = `origin/${productionBranch}`;
  const tip = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: refRoot, encoding: "utf8" });
  if (tip.status !== 0) {
    refuse("E_BASELINE_SOURCE_MISMATCH", `the publication repository cannot resolve ${ref}`);
  }
  if (gitValue(["rev-parse", "HEAD"], resolve(directory)) !== expectedCommit) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "the migration source worktree is not at the authorized commit");
  }
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", expectedCommit, ref], { cwd: refRoot, encoding: "utf8" });
  if (ancestor.status !== 0) {
    refuse("E_BASELINE_SOURCE_MISMATCH", `the migration runtime source is not reachable from ${ref}`);
  }
  return expectedCommit;
}

/**
 * The deployment has two independent identities: the reviewed runtime tree
 * from the main-reachable migration source, and the exact retained 117 artifact
 * supplied by the live predecessor. Requiring both prevents either substituting
 * the main branch's 126-skill artifact into the migration or publishing a
 * changed 117 artifact behind the reviewed runtime.
 */
export function verifyBaselineArtifactBindings({ predecessorTree, migrationTree, expected }) {
  if (predecessorTree !== expected.baseline_artifact_tree_digest) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "the retained predecessor artifact tree is not the authorized 117 baseline");
  }
  if (migrationTree !== expected.candidate_artifact_tree_digest) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "the migration runtime worktree does not contain the untouched main candidate artifact");
  }
  return {
    baseline_artifact_tree_digest: predecessorTree,
    candidate_artifact_tree_digest: migrationTree,
  };
}

/** Verify that a directory is a clean checkout at the exact reviewed commit. */
export function verifyBaselineWorktree({ directory, expectedCommit, role }) {
  const resolved = resolve(directory);
  if (!existsSync(resolved)) refuse("E_BASELINE_SOURCE_MISMATCH", `${role} worktree is missing`);
  const head = gitValue(["rev-parse", "HEAD"], resolved);
  if (head !== expectedCommit) {
    refuse("E_BASELINE_SOURCE_MISMATCH", `${role} worktree is at ${head}, not the authorized ${expectedCommit}`);
  }
  // Executable-bit noise from a local package install is not a source change;
  // content, additions, deletions and renames are.
  if (gitValue(["-c", "core.filemode=false", "status", "--porcelain"], resolved) !== "") {
    refuse("E_BASELINE_SOURCE_MISMATCH", `${role} worktree is not clean; a migration source must be the reviewed commit`);
  }
  return resolved;
}

function gitShowBytes(repoDir, commit, relativePath) {
  const result = spawnSync("git", ["show", `${commit}:${relativePath}`], { cwd: repoDir });
  if (result.status !== 0) {
    refuse("E_BASELINE_SOURCE_MISMATCH", `git show ${commit}:${relativePath} failed in the baseline source`);
  }
  return result.stdout;
}

const BASELINE_MIGRATION_PATHS = Object.freeze([
  "packages/mcp/server.mts",
  "packages/mcp/src/vercel-adapter.ts",
  "tests/mcp/vercel-adapter.test.mjs",
]);

/**
 * The reviewed readiness implementation is pinned in code, not inferred from
 * the caller's checkout. A future change to either file is itself a reviewed
 * code change and must update these constants.
 */
const BASELINE_READINESS_FILE_DIGESTS = Object.freeze({
  "packages/mcp/server.mts": "sha256:d95f5e4bfe883edb3d3363b672f4b8c8c662278b817f9c79b20c0a8e21e74662",
  "packages/mcp/src/vercel-adapter.ts": "sha256:327879e0e86a56c6dfafda98dd171bd4bd7aed78df3589f79139ce84b3402c97",
});

/**
 * Legacy same-branch predicate: the migration commit descends from the live
 * predecessor and changes only the reviewed readiness paths. It remains
 * exported for the historical regression tests, but the main-bound baseline
 * migration does not use it: `main` cannot descend from the retained
 * `release/2.0` deployment. The replacement is the separate runtime/artifact
 * binding in `verifyBaselineArtifactBindings` plus pinned runtime files.
 */
export function verifyBaselineDelta({ sourceDir, predecessorCommit, migrationCommit }) {
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", predecessorCommit, migrationCommit], { cwd: sourceDir });
  if (ancestor.status !== 0) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "the migration commit does not descend from the live predecessor commit");
  }
  const diff = spawnSync("git", ["diff", "--name-status", predecessorCommit, migrationCommit], { cwd: sourceDir, encoding: "utf8" });
  if (diff.status !== 0) refuse("E_BASELINE_SOURCE_MISMATCH", "cannot read the migration source delta");
  const changed = new Set();
  for (const line of diff.stdout.split("\n").filter(Boolean)) {
    const [status, path, ...rest] = line.split("\t");
    if (rest.length !== 0 || (status !== "M" && status !== "A")) {
      refuse("E_BASELINE_SOURCE_MISMATCH", "the migration delta contains a non-additive change");
    }
    if (!BASELINE_MIGRATION_PATHS.includes(path)) {
      refuse("E_BASELINE_SOURCE_MISMATCH", `the migration delta changes an unreviewed path: ${path}`);
    }
    changed.add(path);
  }
  for (const required of BASELINE_MIGRATION_PATHS) {
    if (!changed.has(required)) refuse("E_BASELINE_SOURCE_MISMATCH", `the migration delta is missing the reviewed path ${required}`);
  }
  return { changed_paths: [...changed].sort() };
}

/**
 * The readiness files in the migration commit must be byte-identical to the
 * reviewed implementation commit, read from Git objects rather than from a
 * mutable working tree. The delta check separately proves no other runtime
 * path changed relative to the live predecessor.
 */
export function verifyBaselineRuntimeFiles({ repoRoot, sourceDir, migrationCommit, reviewedCommit }) {
  for (const [relativePath, expected] of Object.entries(BASELINE_READINESS_FILE_DIGESTS)) {
    const reviewed = gitShowBytes(repoRoot, reviewedCommit, relativePath);
    const reviewedDigest = `sha256:${createHash("sha256").update(reviewed).digest("hex")}`;
    if (reviewedDigest !== expected) {
      refuse("E_BASELINE_SOURCE_MISMATCH", `the authorized reviewed commit does not contain the pinned readiness implementation at ${relativePath}`);
    }
    const migrated = gitShowBytes(sourceDir, migrationCommit, relativePath);
    const migratedDigest = `sha256:${createHash("sha256").update(migrated).digest("hex")}`;
    if (migratedDigest !== expected) {
      refuse("E_BASELINE_SOURCE_MISMATCH", `migration source ${relativePath} is not the pinned readiness implementation`);
    }
  }
}

/**
 * Create a fresh, detached worktree at the exact migration runtime commit, then
 * replace ONLY `packages/mcp/artifact` with the retained 117 artifact from the
 * live predecessor commit. This keeps the Vercel CLI's monorepo detection
 * intact while ensuring the upload tree has no untracked or ignored files
 * outside the explicitly bound artifact substitution. The caller removes it
 * after the deploy; the commit and staged deployment identity are checked again
 * by the migration gate.
 */
export function createBaselineDeployWorktree(sourceDir, commit, options = {}) {
  assertPublicationPlatform();
  const parent = mkdtempSync(join(tmpdir(), "ega-baseline-deploy-"));
  const directory = join(parent, "worktree");
  const add = spawnSync("git", ["-C", sourceDir, "worktree", "add", "--detach", directory, commit], { encoding: "utf8" });
  if (add.status !== 0) {
    rmSync(parent, { recursive: true, force: true });
    refuse("E_BASELINE_SOURCE_MISMATCH", "cannot create a clean worktree at the migration commit");
  }
  try {
    if (gitValue(["rev-parse", "HEAD"], directory) !== commit) {
      refuse("E_BASELINE_SOURCE_MISMATCH", "the deployment worktree is not at the authorized migration commit");
    }
    if (gitValue(["status", "--porcelain", "--ignored"], directory) !== "") {
      refuse("E_BASELINE_SOURCE_MISMATCH", "the deployment worktree contains untracked or ignored files");
    }
    let artifactDigest;
    if (options.artifactSourceDir !== undefined) {
      if (options.artifactSourceCommit !== undefined) {
        verifyBaselineWorktree({
          directory: options.artifactSourceDir,
          expectedCommit: options.artifactSourceCommit,
          role: "deployment artifact source",
        });
      }
      const artifact = join("packages", "mcp", "artifact");
      const target = join(directory, artifact);
      rmSync(target, { recursive: true, force: true });
      cpSync(join(resolve(options.artifactSourceDir), artifact), target, { recursive: true, force: false, errorOnExist: true, dereference: false });
      const digest = artifactTreeDigest(directory, artifact);
      if (digest !== options.expectedArtifactTreeDigest) {
        refuse("E_BASELINE_SOURCE_MISMATCH", "the assembled deployment does not contain the authorized retained artifact");
      }
      artifactDigest = digest;
      const unexpected = gitValue(["status", "--porcelain", "--ignored"], directory)
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.includes(` ${artifact}/`) && !line.endsWith(` ${artifact}`));
      if (unexpected.length !== 0) {
        refuse("E_BASELINE_SOURCE_MISMATCH", "the deployment worktree changed paths outside the retained artifact");
      }
    }
    return { artifact_tree_digest: artifactDigest, directory, parent };
  } catch (error) {
    spawnSync("git", ["-C", sourceDir, "worktree", "remove", "-f", directory], { encoding: "utf8" });
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

export function removeBaselineDeployWorktree({ sourceDir, directory, parent }) {
  spawnSync("git", ["-C", sourceDir, "worktree", "remove", "-f", directory], { encoding: "utf8" });
  rmSync(parent, { recursive: true, force: true });
}

/**
 * Verify the retained baseline candidate and both source worktrees. The
 * predecessor worktree binds the live deployment's immutable source commit to
 * the 117 artifact tree; the migration worktree supplies only the reviewed
 * runtime and must contain the untouched main-branch 126 candidate. The two
 * trees are bound separately on purpose: the deployment is assembled from the
 * reviewed runtime plus the retained 117 artifact, never from the 126 candidate.
 */
export async function readBaselineSources({ repoRoot, predecessorSourceDir, migrationSourceDir, expected }) {
  const predecessor = verifyBaselineWorktree({ directory: predecessorSourceDir, expectedCommit: expected.predecessor_source_commit, role: "predecessor source" });
  const migration = verifyBaselineWorktree({ directory: migrationSourceDir, expectedCommit: expected.migration_source_commit, role: "migration source" });
  const predecessorArtifact = join(predecessor, "packages/mcp/artifact");
  const migrationArtifact = join(migration, "packages/mcp/artifact");
  const predecessorTree = artifactTreeDigest(predecessor, "packages/mcp/artifact");
  const migrationTree = artifactTreeDigest(migration, "packages/mcp/artifact");
  verifyBaselineArtifactBindings({ expected, migrationTree, predecessorTree });
  if (expected.migration_source_commit !== expected.reviewed_runtime_commit) {
    refuse("E_BASELINE_SOURCE_MISMATCH", "the deployed runtime source is not the exact reviewed runtime commit");
  }
  verifyBaselineSourceReachability({
    directory: migration,
    expectedCommit: expected.migration_source_commit,
    productionBranch: expected.production_branch,
    repoRoot,
  });
  const predecessorCandidate = await readCandidate(predecessorArtifact);
  const migrationCandidate = await readCandidate(migrationArtifact);
  if (predecessorCandidate.release_digest !== expected.predecessor_release_digest ||
      predecessorCandidate.candidate_digest !== expected.baseline_candidate_digest ||
      predecessorCandidate.hub_id !== "personal") {
    refuse("E_BASELINE_SOURCE_MISMATCH", "predecessor source artifact is not the authorized retained 117 release and candidate");
  }
  if (migrationCandidate.release_digest !== expected.candidate_release_digest || migrationCandidate.hub_id !== "personal") {
    refuse("E_BASELINE_SOURCE_MISMATCH", "migration runtime artifact is not the approved main candidate release");
  }
  verifyBaselineRuntimeFiles({
    migrationCommit: expected.migration_source_commit,
    repoRoot,
    reviewedCommit: expected.reviewed_runtime_commit,
    sourceDir: migration,
  });
  return {
    artifact_source_commit: expected.predecessor_source_commit,
    artifact_source_dir: predecessor,
    artifact_tree_digest: expected.baseline_artifact_tree_digest,
    candidate_artifact_tree_digest: expected.candidate_artifact_tree_digest,
    candidate_digest: expected.baseline_candidate_digest,
    candidate_release_digest: expected.candidate_release_digest,
    migration_source_commit: expected.migration_source_commit,
    migration_source_dir: migration,
    predecessor_source_commit: expected.predecessor_source_commit,
    predecessor_source_dir: predecessor,
    release_digest: expected.predecessor_release_digest,
    reviewed_runtime_commit: expected.reviewed_runtime_commit,
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
  // Only an actual Git deployment switch is evidence here. In particular,
  // gitProviderOptions.createDeployments controls GitHub deployment_status
  // notifications, not Vercel builds. deploymentPolicy is an allowlist with a
  // different schema, not an enabled/disabled auto-deploy switch. Neither is
  // interpreted as proof that automatic production deployments are disabled.
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
  if (expected.production_branch !== undefined && productionBranch !== expected.production_branch) {
    refuse("E_PLATFORM_GUARD", "the observed Vercel production branch differs from the authorized branch");
  }
  // Vercel permits minimatch branch rules and any matching true rule wins.
  // Accept only the unambiguous subset: global false, or an exact branch false
  // with exclusively false rules. Unknown patterns/values remain blocked.
  const gitDisabled = enabled === false || (enabled !== null && typeof enabled === "object" &&
    !Array.isArray(enabled) && Object.hasOwn(enabled, productionBranch) && enabled[productionBranch] === false &&
    Object.values(enabled).every((value) => value === false));
  const autoDeploy = !gitDisabled;
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
    project_name: typeof project.name === "string" ? project.name : "",
    deployment_source_ref: typeof canonical.meta?.githubCommitRef === "string" ? canonical.meta.githubCommitRef : "",
    served_deployment_id: served.served_deployment_id ?? String(canonical.id),
    served_release_digest: served.release_digest,
    team_id: String(project.accountId ?? project.teamId ?? ""),
  };
}

/* -------------------------------------------------------------------------- */
/* Vercel HTTP API                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every non-canonical production alias back to the exact project and
 * deployment. The inventory endpoint already scopes aliases to the deployment,
 * but project-level aliases are a second view that can name another deployment
 * or a redirect. Combine both views, reject a mismatched project-alias entry,
 * then re-read every name so "same expected project/deployment" is observed.
 */
function verifyProjectAliasEntries(project, deployment) {
  const entries = (project?.alias ?? []).filter((entry) => entry?.target === "PRODUCTION");
  for (const entry of entries) {
    if (typeof entry.domain !== "string" || entry.domain.length === 0 || entry.redirect != null ||
        (entry.deployment != null && entry.deployment?.id !== deployment.id)) {
      refuse("E_ALIAS_DRIFT", "a project production alias is redirected or targets another deployment");
    }
  }
  return entries.map((entry) => entry.domain);
}

async function verifyProductionAliasInventory({ expected, get, project, deployment, names }) {
  const domain = await projectModule();
  const branches = [expected.production_branch, deployment.meta?.githubCommitRef]
    .filter((value) => typeof value === "string" && value.length > 0);
  const context = {
    branches,
    canonical_alias: expected.canonical_alias,
    project_name: typeof project.name === "string" ? project.name : "",
  };
  for (const name of names) {
    if (!domain.isRecognizedProductionAlias(name, context)) {
      refuse("E_PLATFORM_GUARD", "a production alias is not a recognized Vercel-managed alias for this project");
    }
    if (name === expected.canonical_alias) continue;
    const alias = await get(`/v4/aliases/${encodeURIComponent(name)}`);
    if (alias?.alias !== name || alias.projectId !== expected.project_id ||
        alias.deploymentId !== deployment.id || alias.redirect != null) {
      refuse("E_ALIAS_DRIFT", "a generated production alias does not resolve directly to the exact deployment");
    }
  }
}

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
    // The deployment list omits aliases/checks and its newest entry may be an
    // unpromoted --skip-domain build. Resolve the actual canonical alias, then
    // fetch that immutable deployment, rather than searching a recent list.
    const aliasPath = `/v4/aliases/${encodeURIComponent(expected.canonical_alias)}`;
    const readAlias = async () => {
      const alias = await this.get(aliasPath);
      if (alias?.alias !== expected.canonical_alias || alias.projectId !== expected.project_id ||
          typeof alias.deploymentId !== "string" || !alias.deploymentId || alias.redirect != null) {
        refuse("E_ALIAS_DRIFT", "canonical alias is not assigned directly to the approved project");
      }
      return alias;
    };
    const before = await readAlias();
    const deployment = await this.get(`/v13/deployments/${encodeURIComponent(before.deploymentId)}`);
    if (deployment?.id !== before.deploymentId || deployment.projectId !== expected.project_id || deployment.target !== "production") {
      refuse("E_ALIAS_DRIFT", "canonical alias deployment identity or project does not match");
    }
    const aliases = await this.get(`/v2/deployments/${encodeURIComponent(deployment.id)}/aliases`);
    if (!Array.isArray(aliases?.aliases) || aliases.aliases.some((entry) => typeof entry?.alias !== "string" ||
        (entry.deploymentId !== undefined && entry.deploymentId !== deployment.id) || entry.redirect != null) || aliases.pagination?.next != null) {
      refuse("E_PLATFORM_GUARD", "complete deployment alias inventory is unavailable");
    }
    const names = aliases.aliases.map((entry) => entry.alias);
    if (new Set(names).size !== names.length) refuse("E_PLATFORM_GUARD", "duplicate deployment aliases prevent reliable inventory");
    if (!names.includes(expected.canonical_alias)) refuse("E_ALIAS_DRIFT", "canonical alias is absent from deployment alias inventory");
    const projectNames = verifyProjectAliasEntries(project, deployment);
    const allNames = [...new Set([...names, ...projectNames])];
    await verifyProductionAliasInventory({ deployment, expected, get: (path) => this.get(path), names: allNames, project });
    // Recovery may need the authenticated immutable deployment identity while
    // /readyz is unavailable. Do not invent a served release in that case.
    const served = probe ? await probe(expected.canonical_alias) : {};
    const after = await readAlias();
    if (before.deploymentId !== after.deploymentId) refuse("E_ALIAS_DRIFT", "canonical alias moved during the live observation");
    return observationFromVercel({ deployments: [{ ...deployment, alias: names }], expected, project,
      served: { ...served, served_deployment_id: served.served_deployment_id ?? deployment.id }, user: user?.user ?? user });
  }

  /**
   * Baseline-migration observation. It uses the same live alias, immutable
   * deployment, complete alias inventory and publisher identity reads as the
   * normal gate, plus a tolerant `/readyz` classification and the deployment's
   * immutable source commit. The assessment decides whether the legacy shape
   * is acceptable; this method never turns a 200 into a digest.
   */
  async readBaseline(expected, probeLegacy) {
    const user = await this.get("/v2/user");
    const project = await this.get(`/v9/projects/${encodeURIComponent(expected.project_id)}`);
    const aliasPath = `/v4/aliases/${encodeURIComponent(expected.canonical_alias)}`;
    const readAlias = async () => {
      const alias = await this.get(aliasPath);
      if (alias?.alias !== expected.canonical_alias || alias.projectId !== expected.project_id ||
          typeof alias.deploymentId !== "string" || !alias.deploymentId || alias.redirect != null) {
        refuse("E_ALIAS_DRIFT", "canonical alias is not assigned directly to the approved project");
      }
      return alias;
    };
    const before = await readAlias();
    const deployment = await this.get(`/v13/deployments/${encodeURIComponent(before.deploymentId)}`);
    if (deployment?.id !== before.deploymentId || deployment.projectId !== expected.project_id || deployment.target !== "production") {
      refuse("E_ALIAS_DRIFT", "canonical alias deployment identity or project does not match");
    }
    const aliases = await this.get(`/v2/deployments/${encodeURIComponent(deployment.id)}/aliases`);
    if (!Array.isArray(aliases?.aliases) || aliases.aliases.some((entry) => typeof entry?.alias !== "string" ||
        (entry.deploymentId !== undefined && entry.deploymentId !== deployment.id) || entry.redirect != null) || aliases.pagination?.next != null) {
      refuse("E_PLATFORM_GUARD", "complete deployment alias inventory is unavailable");
    }
    const names = aliases.aliases.map((entry) => entry.alias);
    if (new Set(names).size !== names.length) refuse("E_PLATFORM_GUARD", "duplicate deployment aliases prevent reliable inventory");
    if (!names.includes(expected.canonical_alias)) refuse("E_ALIAS_DRIFT", "canonical alias is absent from deployment alias inventory");
    const projectNames = verifyProjectAliasEntries(project, deployment);
    const allNames = [...new Set([...names, ...projectNames])];
    await verifyProductionAliasInventory({ deployment, expected, get: (path) => this.get(path), names: allNames, project });
    const legacy = await probeLegacy(expected.canonical_alias);
    const after = await readAlias();
    if (before.deploymentId !== after.deploymentId) refuse("E_ALIAS_DRIFT", "canonical alias moved during the live observation");
    const base = observationFromVercel({
      deployments: [{ ...deployment, alias: names }],
      expected,
      project,
      served: { served_deployment_id: deployment.id },
      user: user?.user ?? user,
    });
    return {
      ...base,
      deployment_source_commit: typeof deployment.meta?.githubCommitSha === "string" ? deployment.meta.githubCommitSha : "",
      legacy_readyz: legacy.shape,
      ...(legacy.release_digest === undefined ? {} : { served_release_digest: legacy.release_digest }),
    };
  }

  /** Read the immutable identity of a deployment that is not yet at the alias. */
  async readDeploymentIdentity(deploymentId, expected) {
    const deployment = await this.get(`/v13/deployments/${encodeURIComponent(deploymentId)}`);
    if (deployment?.id !== deploymentId || deployment.projectId !== expected.project_id || deployment.target !== "production") {
      refuse("E_BASELINE_SOURCE_MISMATCH", "the staged deployment identity, project or target does not match");
    }
    const conclusion = String(deployment.checksConclusion ?? "");
    const state = String(deployment.checksState ?? "");
    return {
      checks_state: conclusion === "succeeded" ? "succeeded"
        : conclusion === "failed" || conclusion === "canceled" ? "failed"
        : state === "pending" || state === "in_progress" ? "pending"
        : "none",
      deployment_id: String(deployment.id),
      project_id: String(deployment.projectId),
      ready_state: String(deployment.readyState ?? ""),
      source_commit: typeof deployment.meta?.githubCommitSha === "string" ? deployment.meta.githubCommitSha : "",
      target: String(deployment.target ?? ""),
      url: typeof deployment.url === "string" ? deployment.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "",
    };
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

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
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
      !isHttpsUrl(record.review_record) ||
      record.access_controls_reviewed !== true || record.single_writer_controls_reviewed !== true || record.residual_alias_race_accepted !== true) {
    refuse("E_PUBLICATION_READINESS", "fresh external publication-readiness certification for this exact target and shared state directory is required");
  }
}

function checkReadiness(apply, deps, expected) {
  if (apply) verifyPublicationReadiness(deps.readiness, expected, deps.now?.() ?? Date.now(), deps.stateDir);
}

/** Write exactly once and fsync both the file and (on Linux) its directory. */
export function writeDurableExclusive(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform === "linux") {
    const directory = openSync(dirname(file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

/** Reserve and fsync intent before touching the alias; persist the final receipt
 * separately inside the caller's lease. Neither file is ever overwritten. A
 * crash leaves the intent for read-only reconciliation. */
export async function withPublicationReceipt(file, apply, operation) {
  if (!apply) return operation(undefined);
  const finalPath = resolve(file);
  const intentPath = `${finalPath}.pending`;
  if (existsSync(finalPath)) refuse("E_PUBLICATION_RECEIPT", "receipt path already exists; use a new receipt path");
  writeDurableExclusive(intentPath, `${JSON.stringify({ status: "PENDING", created_at: new Date().toISOString() })}\n`);
  return operation(async (receipt) => {
    writeDurableExclusive(finalPath, `${JSON.stringify(receipt, null, 2)}\n`);
    // The PENDING intent is retained as immutable evidence. It is never
    // truncated or rewritten into the final receipt.
  });
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
async function verifyTargetControls(observed, expected, deployment) {
  const domain = await projectModule();
  const branches = [expected.production_branch, observed.deployment_source_ref]
    .filter((value) => typeof value === "string" && value.length > 0);
  if (observed.alias_target_deployment_id !== deployment || observed.served_deployment_id !== deployment) {
    refuse("E_PREDECESSOR_MISMATCH", "live alias deployment differs from the expected publication");
  }
  if (observed.team_id !== expected.team_id || observed.project_id !== expected.project_id ||
      observed.production_branch !== expected.production_branch || observed.canonical_alias !== expected.canonical_alias ||
      observed.git_production_auto_deploy !== false ||
      !domain.productionAliasesAreRecognized(observed.production_aliases, {
        branches,
        canonical_alias: expected.canonical_alias,
        project_name: observed.project_name ?? "",
      }, expected.canonical_alias)) {
    refuse("E_PLATFORM_GUARD", "live publication target or production controls differ from the verified target");
  }
}

async function verifyLiveTarget(observed, expected, deployment, release) {
  await verifyTargetControls(observed, expected, deployment);
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
  await verifyTargetControls(observed, expected, expected.staged_deployment_id);
  checkReadiness(true, deps, expected);
  lease.assertHeld(deps.now?.() ?? Date.now());
  await deps.rollback(expected.predecessor_deployment_id);
  const restored = await deps.probe(expected.canonical_alias);
  if (restored.release_digest !== expected.predecessor_release_digest) {
    refuse("E_ROLLBACK_UNVERIFIED", "automatic restore did not return the predecessor release digest");
  }
  const restoredObservation = await deps.readObservation(expected, restored);
  await verifyLiveTarget(restoredObservation, expected, expected.predecessor_deployment_id, expected.predecessor_release_digest);
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
      if (typeof deps.readDeploymentIdentity !== "function") refuse("E_STAGE", "the staged deployment identity must be verified before promotion");
      const identity = await deps.readDeploymentIdentity(expected.staged_deployment_id, expected);
      if (identity.project_id !== expected.project_id || identity.target !== "production" ||
          identity.source_commit !== expected.source_commit) {
        refuse("E_STAGE", "the staged deployment identity or source commit does not match the tested source");
      }
      promoted = true; // CLI failure can still follow a successful alias move.
      await deps.promote(expected.staged_deployment_id);
      const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
      let attempts = 0;
      for (;;) {
        const served = await deps.probe(expected.canonical_alias);
        observed = await deps.readObservation(expected, served);
        if (observed.alias_target_deployment_id === expected.staged_deployment_id && served.release_digest === candidate.release_digest) {
          await verifyLiveTarget(observed, expected, expected.staged_deployment_id, candidate.release_digest);
          break;
        }
        attempts += 1;
        if (!apply || attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) {
          refuse("E_PROMOTION_UNVERIFIED", "the production alias did not reach the staged deployment and release digest");
        }
        await deps.sleep?.(PROMOTE_POLL_MS);
      }
      // Receipt persistence is inside the recovery boundary: a durable
      // evidence failure must restore the predecessor, not leave production
      // moved with no receipt.
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
    } catch (error) {
      if (promoted) {
        const receipt = await restoreAfterFailure({ approval, candidate, deps, expected, lease });
        if (receipt && typeof error === "object" && error !== null) error.receipt = receipt;
      }
      throw error;
    }
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
    if (typeof deps.readDeploymentIdentity !== "function") refuse("E_STAGE", "the staged deployment identity must be verified");
    const identity = await deps.readDeploymentIdentity(deployed.deployment_id, expected);
    if (identity.project_id !== expected.project_id || identity.target !== "production") {
      refuse("E_STAGE", "the staged deployment is not a production deployment of the approved project");
    }
    if (identity.source_commit !== expected.source_commit) {
      refuse("E_STAGE", "the staged deployment does not report the tested source commit");
    }
    let stagedHost;
    try {
      stagedHost = new URL(deployed.url).hostname;
    } catch {
      refuse("E_STAGE", "the staged deployment URL is malformed");
    }
    if (identity.url !== stagedHost) refuse("E_STAGE", "the staged URL does not belong to the reported deployment");
    const current = await deps.probe(expected.canonical_alias);
    await verifyLiveTarget(await deps.readObservation(expected, current), expected, expected.predecessor_deployment_id, expected.predecessor_release_digest);

    return {
      observation,
      staging: {
        approval_digest: approval.digest,
        candidate_digest: candidate.candidate_digest,
        deployment_id: deployed.deployment_id,
        previous_deployment_id: expected.predecessor_deployment_id,
        previous_release_digest: expected.predecessor_release_digest,
        release_digest: candidate.release_digest,
        source_commit: expected.source_commit,
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
      await verifyTargetControls(observed, expected, deployment);
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
        await verifyLiveTarget(observed, expected, retained.deployment_id, retained.release_digest);
        break;
      }
      if (++attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) refuse("E_ROLLBACK_UNVERIFIED", "alias did not return the retained deployment and release");
      await deps.sleep?.(PROMOTE_POLL_MS);
    }
    try {
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
    } catch (error) {
      // The alias is already on the retained target. Record the durable side
      // evidence for manual reconciliation; never pretend the rollback was
      // receipted.
      if (typeof error === "object" && error !== null) {
        error.receipt = domain.createPublicationReceipt({
          action: "ROLLBACK", actor: current.payload.actor, approval_digest: retained.approval_digest,
          candidate_digest: retained.candidate_digest, canonical_alias: expected.canonical_alias,
          completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(), deployment_id: retained.deployment_id,
          detail: "rollback reached the retained deployment but receipt persistence failed; manual reconciliation required",
          hub_id: retained.hub_id, policy_digest: retained.policy_digest,
          previous_deployment_id: current.payload.deployment_id, previous_release_digest: current.payload.release_digest,
          previous_revision: current.payload.publication_revision, publication_revision: current.payload.publication_revision,
          release_digest: retained.release_digest, status: "FAILED",
        });
      }
      throw error;
    }
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
    if (observation.alias_target_deployment_id !== expected.staged_deployment_id ||
        observation.served_deployment_id !== expected.staged_deployment_id ||
        observation.served_release_digest !== candidate.release_digest) {
      refuse("E_RECONCILE_STATE", "live production alias, deployment and served release are not the exact staged candidate");
    }
    if (typeof deps.readDeploymentIdentity !== "function") refuse("E_RECONCILE_STATE", "the live deployment identity must be verified");
    const identity = await deps.readDeploymentIdentity(expected.staged_deployment_id, expected);
    if (identity.project_id !== expected.project_id || identity.target !== "production" ||
        identity.source_commit !== expected.source_commit) {
      refuse("E_RECONCILE_STATE", "the live deployment identity or source commit does not match the tested source");
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
    const reServed = await deps.probe(expected.canonical_alias);
    const reObservation = await deps.readObservation(expected, reServed);
    if (reServed.release_digest !== candidate.release_digest ||
        reObservation.alias_target_deployment_id !== expected.staged_deployment_id ||
        reObservation.served_deployment_id !== expected.staged_deployment_id ||
        reObservation.served_release_digest !== candidate.release_digest ||
        JSON.stringify(reObservation) !== JSON.stringify(observation)) {
      refuse("E_PUBLICATION_RACE", "live production identity changed before the reconciled receipt was written");
    }
    lease.assertHeld(deps.now?.() ?? Date.now());
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
/* Baseline runtime migration                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Verify the staging record written before the alias moved. Reconciliation uses
 * this record, not an operator-supplied deployment id, so an interrupted
 * migration can only be completed for the exact deployment that was staged.
 */
export function verifyBaselineStaging(staging, expected, authorizationDigest, now = Date.now()) {
  const keys = [
    "artifact_tree_digest", "authorization_digest", "candidate_digest", "deployment_id",
    "migration_source_commit", "predecessor_deployment_id", "predecessor_release_digest",
    "release_digest", "staged_at", "url",
  ].sort();
  if (staging === null || typeof staging !== "object" || Array.isArray(staging) ||
      JSON.stringify(Object.keys(staging).sort()) !== JSON.stringify(keys)) {
    refuse("E_BASELINE_STAGE", "baseline staging record has missing or unknown fields");
  }
  let url;
  try {
    url = new URL(staging.url);
  } catch {
    url = undefined;
  }
  const stagedAt = typeof staging.staged_at === "string" ? Date.parse(staging.staged_at) : Number.NaN;
  const stagedAtShape = typeof staging.staged_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(staging.staged_at);
  if (staging.authorization_digest !== authorizationDigest ||
      staging.artifact_tree_digest !== expected.baseline_artifact_tree_digest ||
      staging.candidate_digest !== expected.baseline_candidate_digest ||
      staging.migration_source_commit !== expected.migration_source_commit ||
      staging.predecessor_deployment_id !== expected.predecessor_deployment_id ||
      staging.predecessor_release_digest !== expected.predecessor_release_digest ||
      staging.release_digest !== expected.predecessor_release_digest ||
      typeof staging.deployment_id !== "string" || !DEPLOYMENT_ID_RE.test(staging.deployment_id) ||
      url === undefined || url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "" ||
      !stagedAtShape || !Number.isFinite(stagedAt) || stagedAt > now + 5 * 60_000) {
    refuse("E_BASELINE_STAGE", "baseline staging record does not bind this authorization, source, predecessor and release");
  }
  return staging;
}

async function waitForExactStagedReady(deps, url, digest) {
  const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
  let attempts = 0;
  for (;;) {
    try {
      const served = await deps.probeReady(url, { bypass: deps.bypass });
      if (served.release_digest === digest) return served;
    } catch {
      // A staged deployment is not ready until the build completes; keep
      // polling rather than treating the first 503 as a release failure.
    }
    if (++attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) {
      refuse("E_BASELINE_STAGE", "the staged deployment did not serve the retained baseline release digest");
    }
    await deps.sleep?.(PROMOTE_POLL_MS);
  }
}

/**
 * A failed baseline migration is restored only while this migration is still
 * the current one. The original runtime has no digest, so recovery is certified
 * by the exact alias target, READY deployment state, successful checks and the
 * re-observed legacy readiness shape — never by a configured digest.
 */
async function restoreBaselineAfterFailure({ expected, deps, lease, stagedDeploymentId, actor, authorizationDigest }) {
  if (typeof deps.rollback !== "function") return undefined;
  const current = await deps.readObservation(expected);
  // The CLI can fail before the alias moves. There is nothing to restore, and
  // the original promotion error must not be masked by a false supersession.
  if (current.alias_target_deployment_id === expected.predecessor_deployment_id) return undefined;
  if (current.alias_target_deployment_id !== stagedDeploymentId) {
    refuse("E_PUBLICATION_SUPERSEDED", "baseline migration was superseded by another publication; refusing to restore over it");
  }
  await verifyTargetControls(current, expected, stagedDeploymentId);
  checkReadiness(true, deps, expected);
  lease.assertHeld(deps.now?.() ?? Date.now());
  // Re-read immediately before the rollback. There is still no CAS: this
  // narrows the alias race and refuses when movement is observed.
  const rechecked = await deps.readObservation(expected);
  if (rechecked.alias_target_deployment_id !== stagedDeploymentId) {
    refuse("E_PUBLICATION_SUPERSEDED", "the alias changed before restore; refusing to clobber another publication");
  }
  await deps.rollback(expected.predecessor_deployment_id);
  const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
  let attempts = 0;
  let restored;
  for (;;) {
    restored = await deps.readObservation(expected);
    if (restored.alias_target_deployment_id === expected.predecessor_deployment_id && restored.legacy_readyz === "legacy") {
      await verifyTargetControls(restored, expected, expected.predecessor_deployment_id);
      if (restored.deployment_ready_state !== "READY") refuse("E_BASELINE_DEPLOYMENT_NOT_READY", "the restored legacy deployment is not READY");
      const restoredChecks = expected.legacy_deployment_checks === "absent-accepted" ? "none" : "succeeded";
      if (restored.deployment_checks_state !== restoredChecks) {
        refuse("E_BASELINE_CHECKS_NOT_PASSED", "the restored legacy deployment does not match the authorized check policy");
      }
      break;
    }
    if (++attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) {
      refuse("E_ROLLBACK_UNVERIFIED", "the restored legacy deployment did not return the legacy readiness shape");
    }
    await deps.sleep?.(PROMOTE_POLL_MS);
  }
  const domain = await projectModule();
  return domain.createBaselineMigrationReceipt({
    action: "BASELINE_RUNTIME_MIGRATION",
    actor,
    artifact_tree_digest: expected.baseline_artifact_tree_digest,
    authorization_digest: authorizationDigest,
    canonical_alias: expected.canonical_alias,
    candidate_digest: expected.baseline_candidate_digest,
    completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    deployment_id: stagedDeploymentId,
    detail: "baseline migration failed verification; predecessor restored with legacy readiness re-observed",
    hub_id: "personal",
    migration_source_commit: expected.migration_source_commit,
    predecessor_deployment_id: expected.predecessor_deployment_id,
    predecessor_source_commit: expected.predecessor_source_commit,
    release_digest: expected.predecessor_release_digest,
    status: "FAILED",
  });
}

/**
 * Stage the reviewed runtime with the retained artifact, prove the exact
 * baseline digest, then promote without --force. The only predecessor evidence
 * accepted here is the combination of the recorded immutable deployment, its
 * live alias target, its immutable source commit, the retained artifact tree,
 * and the legacy readiness shape. Any missing or substituted fact blocks.
 */
export async function executeBaselineMigration({ authorization, expected, source, deps, apply }) {
  const domain = await projectModule();
  const auth = domain.verifyBaselineMigrationAuthorization(authorization);
  checkReadiness(apply, deps, expected);
  if (apply && typeof deps.recordReceipt !== "function") refuse("E_PUBLICATION_RECEIPT", "durable receipt sink is required before mutation");
  const lease = await acquirePublicationLease({
    now: deps.now?.() ?? Date.now(),
    publisher: `baseline:${expected.publisher_vercel_user_id}:${expected.canonical_alias}`,
    stateDir: deps.stateDir,
  });
  try {
    const assess = async () => {
      const observation = await deps.readObservation(expected);
      const result = domain.assessBaselineMigration({
        authorization: auth,
        expected: { ...expected, now: new Date(deps.now?.() ?? Date.now()).toISOString(), max_approval_age_ms: MAX_APPROVAL_AGE_MS },
        observation,
      });
      if (result.status !== "READY") {
        refuse("E_BASELINE_BLOCKED", result.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; "));
      }
      return { observation, result };
    };

    const first = await assess();
    if (!apply) return { assessment: first.result, observation: first.observation, status: "DRY_RUN" };
    const second = await assess();
    if (JSON.stringify(first.observation) !== JSON.stringify(second.observation)) {
      refuse("E_PUBLICATION_RACE", "live production identity changed between verification and migration");
    }

    let staged;
    let promoted = false;
    let observed;
    try {
      staged = await deps.deployStagedProduction(source);
      if (typeof staged?.deployment_id !== "string" || typeof staged?.url !== "string") {
        refuse("E_BASELINE_STAGE", "the baseline staging deployment did not report an id and URL");
      }
      await waitForExactStagedReady(deps, staged.url, expected.predecessor_release_digest);
      if (typeof deps.readDeploymentIdentity !== "function") refuse("E_BASELINE_STAGE", "the staged deployment identity must be verified before promotion");
      const stagedIdentity = await deps.readDeploymentIdentity(staged.deployment_id, expected);
      if (stagedIdentity.project_id !== expected.project_id || stagedIdentity.target !== "production") {
        refuse("E_BASELINE_SOURCE_MISMATCH", "the staged deployment is not a production deployment of the approved project");
      }
      if (stagedIdentity.source_commit !== expected.migration_source_commit) {
        refuse("E_BASELINE_SOURCE_MISMATCH", "the staged deployment does not report the authorized migration source commit");
      }
      let stagedHost;
      try {
        stagedHost = new URL(staged.url).hostname;
      } catch {
        refuse("E_BASELINE_STAGE", "the staged deployment URL is malformed");
      }
      if (stagedIdentity.url !== stagedHost) {
        refuse("E_BASELINE_SOURCE_MISMATCH", "the probed staged URL does not belong to the reported deployment");
      }
      if (stagedIdentity.ready_state !== "READY") refuse("E_BASELINE_DEPLOYMENT_NOT_READY", "the staged deployment is not READY");
      if (stagedIdentity.checks_state !== "succeeded") {
        refuse("E_BASELINE_CHECKS_NOT_PASSED", "the staged baseline deployment checks have not concluded successfully");
      }
      await assess();
      if (typeof deps.writeStaging !== "function") refuse("E_BASELINE_STAGE", "a durable staging record is required before promotion");
      await deps.writeStaging({
        artifact_tree_digest: expected.baseline_artifact_tree_digest,
        authorization_digest: auth.digest,
        candidate_digest: expected.baseline_candidate_digest,
        deployment_id: staged.deployment_id,
        migration_source_commit: expected.migration_source_commit,
        predecessor_deployment_id: expected.predecessor_deployment_id,
        predecessor_release_digest: expected.predecessor_release_digest,
        release_digest: expected.predecessor_release_digest,
        staged_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        url: staged.url,
      });
      checkReadiness(true, deps, expected);
      lease.assertHeld(deps.now?.() ?? Date.now());
      promoted = true; // A CLI failure can still follow a successful alias move.
      await deps.promote(staged.deployment_id);

      const deadline = (deps.now?.() ?? Date.now()) + PROMOTE_TIMEOUT_MS;
      let attempts = 0;
      for (;;) {
        let served;
        try {
          served = await deps.probeReady(expected.canonical_alias, { bypass: deps.bypass });
        } catch {
          served = undefined;
        }
        observed = await deps.readObservation(expected);
        if (observed.alias_target_deployment_id === staged.deployment_id && served?.release_digest === expected.predecessor_release_digest) {
          await verifyLiveTarget(observed, expected, staged.deployment_id, expected.predecessor_release_digest);
          if (observed.deployment_source_commit !== expected.migration_source_commit) {
            refuse("E_BASELINE_SOURCE_MISMATCH", "the promoted deployment does not report the authorized migration source commit");
          }
          break;
        }
        if (++attempts >= (deps.maxAttempts ?? 120) || (deps.now?.() ?? Date.now()) >= deadline) {
          refuse("E_BASELINE_UNVERIFIED", "the production alias did not serve the retained baseline digest from the staged deployment");
        }
        await deps.sleep?.(PROMOTE_POLL_MS);
      }
      // Receipt persistence is inside the recovery boundary: a failure to
      // record durable evidence must restore the predecessor, not leave
      // production moved with no receipt.
      return await finishPublication({
        observation: observed,
        receipt: domain.createBaselineMigrationReceipt({
          action: "BASELINE_RUNTIME_MIGRATION",
          actor: auth.payload.publisher,
          artifact_tree_digest: expected.baseline_artifact_tree_digest,
          authorization_digest: auth.digest,
          canonical_alias: expected.canonical_alias,
          candidate_digest: expected.baseline_candidate_digest,
          completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
          deployment_id: staged.deployment_id,
          detail: "deployed the reviewed readiness runtime with the unchanged retained baseline artifact and verified the exact live release digest",
          hub_id: "personal",
          migration_source_commit: expected.migration_source_commit,
          predecessor_deployment_id: expected.predecessor_deployment_id,
          predecessor_source_commit: expected.predecessor_source_commit,
          release_digest: expected.predecessor_release_digest,
          status: "SUCCEEDED",
        }),
        status: "BASELINE_MIGRATED",
      }, deps, apply);
    } catch (error) {
      if (promoted) {
        const receipt = await restoreBaselineAfterFailure({
          actor: auth.payload.publisher,
          authorizationDigest: auth.digest,
          deps,
          expected,
          lease,
          stagedDeploymentId: staged?.deployment_id,
        });
        if (receipt && typeof error === "object" && error !== null) error.receipt = receipt;
      }
      throw error;
    }
  } finally {
    lease.release();
  }
}

/**
 * Complete an interrupted baseline migration. This never moves the alias: it
 * accepts only the exact staged deployment already serving the exact retained
 * baseline digest, and re-checks every authorization/platform binding.
 */
export async function executeBaselineReconcile({ authorization, expected, staging, deps, apply }) {
  const domain = await projectModule();
  const auth = domain.verifyBaselineMigrationAuthorization(authorization);
  const verifiedStaging = verifyBaselineStaging(staging, expected, auth.digest);
  expected = { ...expected, staged_deployment_id: verifiedStaging.deployment_id };
  checkReadiness(apply, deps, expected);
  if (apply && typeof deps.recordReceipt !== "function") refuse("E_PUBLICATION_RECEIPT", "durable receipt sink is required before mutation");
  const lease = await acquirePublicationLease({
    now: deps.now?.() ?? Date.now(),
    publisher: `baseline-reconcile:${expected.publisher_vercel_user_id}:${expected.canonical_alias}`,
    stateDir: deps.stateDir,
  });
  try {
    const observed = await deps.readObservation(expected);
    if (observed.alias_target_deployment_id !== expected.staged_deployment_id) {
      refuse("E_BASELINE_RECONCILE_STATE", "live production alias does not point at the staged baseline deployment");
    }
    if (observed.legacy_readyz !== "digest" || observed.served_release_digest !== expected.predecessor_release_digest) {
      refuse("E_BASELINE_RECONCILE_STATE", "live production does not serve the exact retained baseline digest");
    }
    if (observed.deployment_source_commit !== expected.migration_source_commit) {
      refuse("E_BASELINE_SOURCE_MISMATCH", "the live migration deployment does not report the authorized migration source commit");
    }
    await verifyTargetControls(observed, expected, expected.staged_deployment_id);
    if (observed.deployment_ready_state !== "READY") refuse("E_BASELINE_DEPLOYMENT_NOT_READY", "the staged baseline deployment is not READY");
    if (observed.deployment_checks_state !== "succeeded") refuse("E_BASELINE_CHECKS_NOT_PASSED", "the staged baseline deployment checks did not succeed");
    const assessment = domain.assessBaselineMigration({
      authorization: auth,
      expected: { ...expected, now: new Date(deps.now?.() ?? Date.now()).toISOString(), max_approval_age_ms: MAX_APPROVAL_AGE_MS },
      // The live facts above were checked directly. Restore the predecessor
      // projection only so the pure authorization/platform binding is re-run.
      observation: {
        ...observed,
        alias_target_deployment_id: expected.predecessor_deployment_id,
        // The live staged deployment was already required to have successful
        // checks. Project the predecessor's authorized check policy only for
        // the authorization/platform re-check; the real staged facts were
        // verified above.
        deployment_checks_state: expected.legacy_deployment_checks === "absent-accepted" ? "none" : "succeeded",
        deployment_source_commit: expected.predecessor_source_commit,
        legacy_readyz: "legacy",
        served_deployment_id: expected.predecessor_deployment_id,
        served_release_digest: undefined,
      },
    });
    if (assessment.status !== "READY") {
      refuse("E_BASELINE_RECONCILE_STATE", assessment.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; "));
    }
    if (!apply) return { observation: observed, status: "DRY_RUN" };
    const rechecked = await deps.readObservation(expected);
    if (JSON.stringify(rechecked) !== JSON.stringify(observed)) {
      refuse("E_PUBLICATION_RACE", "live production identity changed before reconciliation was recorded");
    }
    return await finishPublication({
      receipt: domain.createBaselineMigrationReceipt({
        action: "BASELINE_RUNTIME_MIGRATION",
        actor: auth.payload.publisher,
        artifact_tree_digest: expected.baseline_artifact_tree_digest,
        authorization_digest: auth.digest,
        canonical_alias: expected.canonical_alias,
        candidate_digest: expected.baseline_candidate_digest,
        completed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        deployment_id: expected.staged_deployment_id,
        detail: "reconciled a completed baseline runtime migration after the publishing process was interrupted",
        hub_id: "personal",
        migration_source_commit: expected.migration_source_commit,
        predecessor_deployment_id: expected.predecessor_deployment_id,
        predecessor_source_commit: expected.predecessor_source_commit,
        release_digest: expected.predecessor_release_digest,
        status: "SUCCEEDED",
      }),
      status: "BASELINE_RECONCILED",
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

/**
 * Persist a FAILED side receipt from an operation error without masking the
 * original failure. The final receipt path is never overwritten; the side
 * receipt is separate evidence.
 */
export function persistFailedReceipt(receiptPath, error) {
  if (error === null || typeof error !== "object" || error.receipt === undefined) return false;
  const failedPath = `${resolve(receiptPath)}.failed.json`;
  try {
    writeDurableExclusive(failedPath, `${JSON.stringify(error.receipt, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function runBaselineCli(mode, values) {
  const authorization = (await projectModule()).verifyBaselineMigrationAuthorization(
    JSON.parse(readFileSync(resolve(required(values, "authorization")), "utf8")),
  );
  const teamId = required(values, "team");
  const expected = {
    baseline_artifact_tree_digest: authorization.payload.baseline_artifact_tree_digest,
    baseline_candidate_digest: authorization.payload.baseline_candidate_digest,
    canonical_alias: required(values, "alias"),
    candidate_artifact_tree_digest: authorization.payload.candidate_artifact_tree_digest,
    candidate_release_digest: authorization.payload.candidate_release_digest,
    legacy_deployment_checks: authorization.payload.legacy_deployment_checks,
    migration_source_commit: authorization.payload.migration_source_commit,
    predecessor_deployment_id: required(values, "expect-deployment"),
    predecessor_release_digest: required(values, "expect-release"),
    predecessor_source_commit: authorization.payload.predecessor_source_commit,
    production_branch: required(values, "production-branch"),
    project_id: required(values, "project"),
    publisher_vercel_user_id: required(values, "publisher"),
    reviewed_runtime_commit: authorization.payload.reviewed_runtime_commit,
    staged_deployment_id: values["staged-deployment"],
    team_id: teamId,
  };
  if (authorization.payload.canonical_alias !== expected.canonical_alias ||
      authorization.payload.production_branch !== expected.production_branch ||
      authorization.payload.predecessor_deployment_id !== expected.predecessor_deployment_id ||
      authorization.payload.baseline_release_digest !== expected.predecessor_release_digest ||
      authorization.payload.publisher.team_id !== expected.team_id ||
      authorization.payload.publisher.project_id !== expected.project_id ||
      authorization.payload.publisher.vercel_user_id !== expected.publisher_vercel_user_id) {
    refuse("E_BASELINE_IDENTITY_MISMATCH", "the baseline authorization does not bind the CLI target and predecessor");
  }
  if (mode === "baseline") required(values, "staging-out");
  const staging = mode === "baseline-reconcile"
    ? verifyBaselineStaging(JSON.parse(readFileSync(resolve(required(values, "staging")), "utf8")), expected, authorization.digest, Date.now())
    : undefined;
  if (staging) expected.staged_deployment_id = staging.deployment_id;
  const source = await readBaselineSources({
    expected,
    migrationSourceDir: required(values, "migration-source"),
    predecessorSourceDir: required(values, "predecessor-source"),
    repoRoot: REPO_ROOT,
  });
  const token = vercelToken();
  const api = new VercelApi({ teamId, token });
  const bypass = process.env.EGA_VERCEL_BYPASS_FILE ? readFileSync(process.env.EGA_VERCEL_BYPASS_FILE, "utf8").trim() : undefined;
  const cwd = join(source.migration_source_dir, "packages", "mcp");
  const deps = {
    bypass,
    readiness: values.readiness === undefined ? undefined : JSON.parse(readFileSync(resolve(values.readiness), "utf8")),
    now: () => Date.now(),
    readObservation: (expectation) => api.readBaseline(expectation, (alias) =>
      probeLegacyReady(alias.startsWith("http") ? alias : `https://${alias}`, { bypass })),
    probeReady: (url, options = {}) => probeReady(url.startsWith("http") ? url : `https://${url}`, { ...options, bypass }),
    readDeploymentIdentity: (deploymentId, expectation) => api.readDeploymentIdentity(deploymentId, expectation),
    deployStagedProduction: (source) => {
      const deploy = createBaselineDeployWorktree(source.migration_source_dir, source.migration_source_commit, {
        artifactSourceCommit: source.artifact_source_commit,
        artifactSourceDir: source.artifact_source_dir,
        expectedArtifactTreeDigest: source.artifact_tree_digest,
      });
      try {
        const cwd = join(deploy.directory, "packages", "mcp");
        const output = runVercel([
          "deploy", "--prod", "--skip-domain", "--yes",
          "--project", expected.project_id,
          "--meta", `githubCommitSha=${source.migration_source_commit}`,
          "--meta", `githubCommitRef=${expected.production_branch}`,
        ], { cwd, scope: teamId, token });
        const url = output.stdout.trim().split("\n").filter((line) => /^https:\/\//.test(line.trim())).at(-1)?.trim();
        if (!url) refuse("E_BASELINE_STAGE", "could not read the staged baseline deployment URL");
        const deployment = runVercel(["inspect", url, "--json"], { cwd, scope: teamId, token });
        const parsed = JSON.parse(deployment.stdout);
        if (typeof parsed.id !== "string" || !DEPLOYMENT_ID_RE.test(parsed.id)) {
          refuse("E_BASELINE_STAGE", "the staged deployment did not report a valid deployment id");
        }
        return { deployment_id: parsed.id, url };
      } finally {
        removeBaselineDeployWorktree({ directory: deploy.directory, parent: deploy.parent, sourceDir: source.migration_source_dir });
      }
    },
    promote: (deployment) => runVercel(["promote", deployment, "--yes"], { cwd, scope: teamId, token }),
    rollback: (deployment) => runVercel(["rollback", deployment, "--yes"], { cwd, scope: teamId, token }),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    stateDir: process.env.EGA_PUBLICATION_STATE_DIR,
    writeStaging: mode === "baseline" ? (record) => {
      const path = resolve(required(values, "staging-out"));
      writeDurableExclusive(path, `${JSON.stringify(record, null, 2)}\n`);
    } : undefined,
  };
  const receiptPath = resolve(required(values, "receipt"));
  let result;
  try {
    result = await withPublicationReceipt(receiptPath, values.apply === true, (recordReceipt) =>
      mode === "baseline"
        ? executeBaselineMigration({ apply: values.apply === true, authorization, deps: { ...deps, recordReceipt }, expected, source })
        : executeBaselineReconcile({ apply: values.apply === true, authorization, deps: { ...deps, recordReceipt }, expected, staging }));
  } catch (error) {
    persistFailedReceipt(receiptPath, error);
    throw error;
  }
  print(result);
}

async function main() {
  const { mode, values } = parseArgs(process.argv.slice(2));
  if (values.apply === true) assertPublicationPlatform();
  if (mode === "verify") {
    const alias = required(values, "alias");
    print(await probeReady(alias.startsWith("http") ? alias : `https://${alias}`));
    return;
  }
  if (mode === "baseline-authorize") {
    const domain = await projectModule();
    const payload = JSON.parse(readFileSync(resolve(required(values, "payload")), "utf8"));
    const auth = domain.createBaselineMigrationAuthorization(payload);
    const out = resolve(required(values, "out"));
    writeDurableExclusive(out, `${JSON.stringify(auth, null, 2)}\n`);
    print({ authorization_digest: auth.digest, out });
    return;
  }
  if (mode === "baseline" || mode === "baseline-reconcile") {
    await runBaselineCli(mode, values);
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
  if (mode === "stage" || mode === "promote" || mode === "reconcile") {
    expected.source_commit = verifyApprovedSourceCommit(required(values, "expect-source-commit"), `origin/${expected.production_branch}`);
  }
  const token = vercelToken();
  const api = new VercelApi({ teamId, token });
  const probe = (url, options = {}) => probeReady(url.startsWith("http") ? url : `https://${url}`, options);
  const deps = {
    readiness: values.readiness === undefined ? undefined : JSON.parse(readFileSync(resolve(values.readiness), "utf8")),
    bypass: process.env.EGA_VERCEL_BYPASS_FILE ? readFileSync(process.env.EGA_VERCEL_BYPASS_FILE, "utf8").trim() : undefined,
    deployStagedProduction: () => {
      const deploy = createBaselineDeployWorktree(REPO_ROOT, expected.source_commit);
      try {
        const cwd = join(deploy.directory, "packages", "mcp");
        const output = runVercel([
          "deploy", "--prod", "--skip-domain", "--yes",
          "--project", expected.project_id,
          "--meta", `githubCommitSha=${expected.source_commit}`,
          "--meta", `githubCommitRef=${expected.production_branch}`,
        ], { cwd, scope: teamId, token });
        const url = output.stdout.trim().split("\n").filter((line) => /^https:\/\//.test(line.trim())).at(-1)?.trim();
        if (!url) refuse("E_STAGE", "could not read the staged production deployment URL");
        const deployment = runVercel(["inspect", url, "--json"], { cwd, scope: teamId, token });
        const parsed = JSON.parse(deployment.stdout);
        if (typeof parsed.id !== "string" || !DEPLOYMENT_ID_RE.test(parsed.id)) refuse("E_STAGE", "the staged deployment did not report a valid deployment id");
        return { deployment_id: parsed.id, url };
      } finally {
        removeBaselineDeployWorktree({ directory: deploy.directory, parent: deploy.parent, sourceDir: REPO_ROOT });
      }
    },
    now: () => Date.now(),
    probe,
    readDeploymentIdentity: (deploymentId, expectation) => api.readDeploymentIdentity(deploymentId, expectation),
    promote: (deployment) => {
      // Never pass --force: deployment checks must be allowed to block.
      runVercel(["promote", deployment, "--yes"], { cwd: join(REPO_ROOT, "packages", "mcp"), scope: teamId, token });
    },
    readObservation: (expectation) => api.readProduction(expectation, (alias) => probe(alias)),
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
    const receiptPath = resolve(required(values, "receipt"));
    let result;
    try {
      result = await withPublicationReceipt(receiptPath, values.apply === true,
        (recordReceipt) => executeRollback({ apply: values.apply === true, chain, current, deps: { ...deps, recordReceipt }, expected, previousCandidate, target }));
    } catch (error) {
      persistFailedReceipt(receiptPath, error);
      throw error;
    }
    print(result);
    return;
  }



  if (mode === "stage") {
    const candidate = await readCandidate(required(values, "candidate"));
    const checkoutCandidate = await readCandidate(join(REPO_ROOT, "packages", "mcp", "artifact"));
    if (checkoutCandidate.release_digest !== candidate.release_digest || checkoutCandidate.candidate_digest !== candidate.candidate_digest) {
      refuse("E_STAGE", "the tested checkout artifact is not the requested candidate");
    }
    const approval = (await projectModule()).verifyPublicationApproval(JSON.parse(readFileSync(resolve(required(values, "approval")), "utf8")));
    const staged = await executeStage({ approval, apply: values.apply === true, candidate, deps, expected });
    if (values["staging-out"] !== undefined && staged.staging) {
      writeDurableExclusive(resolve(values["staging-out"]), `${JSON.stringify(staged.staging, null, 2)}\n`);
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
    if (staging.deployment_id !== expected.staged_deployment_id || staging.release_digest !== candidate.release_digest || staging.candidate_digest !== candidate.candidate_digest || staging.approval_digest !== approval.digest || staging.previous_release_digest !== expected.predecessor_release_digest || staging.previous_deployment_id !== expected.predecessor_deployment_id || staging.source_commit !== expected.source_commit) {
      refuse("E_STAGE", "the staging record does not bind this candidate, approval, source and predecessor");
    }
    const receiptPath = resolve(required(values, "receipt"));
    let result;
    try {
      result = await withPublicationReceipt(receiptPath, values.apply === true,
        (recordReceipt) => executePromotion({ approval, apply: values.apply === true, candidate, deps: { ...deps, recordReceipt }, expected }));
    } catch (error) {
      persistFailedReceipt(receiptPath, error);
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
    if (staging.deployment_id !== expected.staged_deployment_id || staging.release_digest !== candidate.release_digest || staging.candidate_digest !== candidate.candidate_digest || staging.approval_digest !== approval.digest || staging.previous_release_digest !== expected.predecessor_release_digest || staging.previous_deployment_id !== expected.predecessor_deployment_id || staging.source_commit !== expected.source_commit) {
      refuse("E_STAGE", "the staging record does not bind this candidate, approval, source and predecessor");
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
