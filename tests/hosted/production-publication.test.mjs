import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assessProductionPublication,
  createPublicationApproval,
  createPublicationReceipt,
  verifyPublicationApproval,
  verifyPublicationReceipt,
} from "../../packages/project/dist/index.js";
import {
  PublicationError,
  acquirePublicationLease,
  executePromotion,
  executeRollback,
  observationFromVercel,
  releasePublicationLease,
} from "../../scripts/hosted/publish-production.mjs";

const DIGEST = (letter) => `sha256:${letter.repeat(64)}`;
const PREV = DIGEST("a");
const NEXT = DIGEST("b");
const POLICY = DIGEST("c");
const SOURCE = DIGEST("d");
const CANDIDATE = DIGEST("e");
const PRED_DEPLOYMENT = "dpl_prev12345678";
const STAGED_DEPLOYMENT = "dpl_next12345678";
const TEAM = "team_test";
const PROJECT = "prj_test";
const PUBLISHER = "user_publisher";
const ALIAS = "ega-skills-mcp.vercel.app";

const versions = { "t3dotgg/babysit-pr": DIGEST("1"), "t3dotgg/council": DIGEST("2") };

function approvalPayload(overrides = {}) {
  return {
    approval_record: "https://github.com/egawilldoit/ega-skills/issues/168#approval",
    approved_at: "2026-10-27T12:00:00.000Z",
    approved_by: "owner",
    candidate_digest: CANDIDATE,
    hub_id: "personal",
    policy_digest: POLICY,
    previous_release_digest: PREV,
    publisher: { owner_subject: "owner", project_id: PROJECT, team_id: TEAM, vercel_user_id: PUBLISHER },
    release_digest: NEXT,
    skill_versions: versions,
    source_snapshot_digest: SOURCE,
    ...overrides,
  };
}

function approval(overrides) {
  return createPublicationApproval(approvalPayload(overrides));
}

const candidate = {
  candidate_digest: CANDIDATE,
  hub_id: "personal",
  policy_digest: POLICY,
  previous_release_digest: PREV,
  release_digest: NEXT,
  skill_versions: versions,
};

const expected = {
  canonical_alias: ALIAS,
  expected_revision: 0,
  max_approval_age_ms: 24 * 60 * 60 * 1000,
  now: "2026-10-27T13:00:00.000Z",
  predecessor_deployment_id: PRED_DEPLOYMENT,
  predecessor_release_digest: PREV,
  production_branch: "release/2.0",
  project_id: PROJECT,
  publisher_vercel_user_id: PUBLISHER,
  staged_deployment_id: STAGED_DEPLOYMENT,
  team_id: TEAM,
};

function observation(overrides = {}) {
  return {
    alias_target_deployment_id: PRED_DEPLOYMENT,
    canonical_alias: ALIAS,
    deployment_checks_state: "succeeded",
    deployment_ready_state: "READY",
    git_production_auto_deploy: false,
    production_aliases: [ALIAS],
    production_branch: "release/2.0",
    project_id: PROJECT,
    served_deployment_id: PRED_DEPLOYMENT,
    served_release_digest: PREV,
    team_id: TEAM,
    ...overrides,
  };
}

function assess({ approval: approvalValue = approval(), obs = observation(), expect = expected } = {}) {
  return assessProductionPublication({ approval: approvalValue, candidate, expected: expect, observation: obs });
}

test("the exact approved candidate is READY", () => {
  const result = assess();
  assert.equal(result.status, "READY");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.release_digest, NEXT);
});

test("stale predecessor release or deployment is refused", () => {
  const result = assess({ obs: observation({ served_release_digest: DIGEST("f") }) });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.some((blocker) => blocker.code === "E_PREDECESSOR_MISMATCH"));

  const reordered = assess({ obs: observation({ alias_target_deployment_id: "dpl_older12345678" }) });
  assert.ok(reordered.blockers.some((blocker) => blocker.code === "E_PREDECESSOR_MISMATCH"));
});

test("a malicious or mismatched candidate identity is refused", () => {
  const wrongRelease = assess({ approval: approval({ release_digest: DIGEST("f") }) });
  assert.ok(wrongRelease.blockers.some((blocker) => blocker.code === "E_CANDIDATE_MISMATCH"));

  const wrongVersion = assess({ approval: approval({ skill_versions: { "t3dotgg/babysit-pr": DIGEST("9"), "t3dotgg/council": DIGEST("2") } }) });
  assert.ok(wrongVersion.blockers.some((blocker) => blocker.code === "E_CANDIDATE_MISMATCH"));

  const wrongPolicy = assess({ approval: approval({ policy_digest: DIGEST("f") }) });
  assert.ok(wrongPolicy.blockers.some((blocker) => blocker.code === "E_CANDIDATE_MISMATCH"));
});

test("an approval from another publisher, owner or time window is refused", () => {
  const otherPublisher = assess({ approval: approval({ publisher: { owner_subject: "owner", project_id: PROJECT, team_id: TEAM, vercel_user_id: "user_other" } }) });
  assert.ok(otherPublisher.blockers.some((blocker) => blocker.code === "E_APPROVAL_IDENTITY_MISMATCH"));

  const otherOwner = assess({ approval: approval({ approved_by: "someone-else" }) });
  assert.ok(otherOwner.blockers.some((blocker) => blocker.code === "E_APPROVAL_IDENTITY_MISMATCH"));

  const expired = assess({ expect: { ...expected, now: "2026-10-29T13:00:00.000Z" } });
  assert.ok(expired.blockers.some((blocker) => blocker.code === "E_APPROVAL_STALE"));
});

test("platform states that allow a bypass are refused", () => {
  const git = assess({ obs: observation({ git_production_auto_deploy: true }) });
  assert.ok(git.blockers.some((blocker) => blocker.code === "E_PLATFORM_GUARD"));

  const extraAlias = assess({ obs: observation({ production_aliases: [ALIAS, "mcp.example.com"] }) });
  assert.ok(extraAlias.blockers.some((blocker) => blocker.code === "E_PLATFORM_GUARD"));

  const checks = assess({ obs: observation({ deployment_checks_state: "failed" }) });
  assert.ok(checks.blockers.some((blocker) => blocker.code === "E_CHECKS_NOT_PASSED"));
  const unchecked = assess({ obs: observation({ deployment_checks_state: "none" }) });
  assert.ok(unchecked.blockers.some((blocker) => blocker.code === "E_CHECKS_NOT_PASSED"));

  const notReady = assess({ obs: observation({ deployment_ready_state: "BUILDING" }) });
  assert.ok(notReady.blockers.some((blocker) => blocker.code === "E_DEPLOYMENT_NOT_READY"));

  const drift = assess({ obs: observation({ canonical_alias: "other.vercel.app" }) });
  assert.ok(drift.blockers.some((blocker) => blocker.code === "E_ALIAS_DRIFT"));
});

test("the Vercel observation pins the publisher, project and alias", () => {
  const project = { accountId: TEAM, git: { deploymentEnabled: { "release/2.0": false }, productionBranch: "release/2.0" }, id: PROJECT };
  const deployments = { deployments: [{ alias: [ALIAS], checksState: "succeeded", id: PRED_DEPLOYMENT, readyState: "READY", target: "production" }] };
  const result = observationFromVercel({ deployments: deployments.deployments, expected, project, served: { publication_revision: 0, release_digest: PREV }, user: { id: PUBLISHER } });
  assert.equal(result.git_production_auto_deploy, false);
  assert.equal(result.alias_target_deployment_id, PRED_DEPLOYMENT);

  assert.throws(() => observationFromVercel({ deployments: deployments.deployments, expected, project, served: { release_digest: PREV }, user: { id: "user_other" } }), /not the approved publisher/);
  const auto = observationFromVercel({ deployments: deployments.deployments, expected, project: { ...project, git: { deploymentEnabled: { "release/2.0": true }, productionBranch: "release/2.0" } }, served: { release_digest: PREV }, user: { id: PUBLISHER } });
  assert.equal(auto.git_production_auto_deploy, true);

  const policyDisabled = observationFromVercel({
    deployments: deployments.deployments,
    expected,
    project: { ...project, git: {}, deploymentPolicy: { gitSources: [{ enabled: false, environments: ["production"], sources: [] }] } },
    served: { release_digest: PREV },
    user: { id: PUBLISHER },
  });
  assert.equal(policyDisabled.git_production_auto_deploy, false);

  const viaProjectAlias = observationFromVercel({
    deployments: [],
    expected,
    project: {
      ...project,
      alias: [{ deployment: { checksConclusion: "succeeded", checksState: "completed", id: PRED_DEPLOYMENT, readyState: "READY" }, domain: ALIAS, target: "PRODUCTION" }],
      git: {},
    },
    served: { release_digest: PREV },
    user: { id: PUBLISHER },
  });
  assert.equal(viaProjectAlias.alias_target_deployment_id, PRED_DEPLOYMENT);
  assert.equal(viaProjectAlias.deployment_checks_state, "succeeded");
});

test("the publication lease has exactly one owner and reclaims only an exact stale owner", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "ega-publication-lease-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const first = await acquirePublicationLease({ now: Date.parse("2026-10-27T12:00:00Z"), publisher: "first", stateDir, ttlMs: 60_000 });
  await assert.rejects(() => acquirePublicationLease({ now: Date.parse("2026-10-27T12:00:01Z"), publisher: "second", stateDir, ttlMs: 60_000 }), (error) => error.code === "E_PUBLICATION_LEASE");
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  const second = await acquirePublicationLease({ now: Date.parse("2026-10-27T12:00:02Z"), publisher: "second", stateDir, ttlMs: 60_000 });
  assert.equal(second.owner.publisher, "second");
  second.release();

  writeFileSync(join(stateDir, "publication.lock"), "", { flag: "w" });
  const leaseDir = join(stateDir, "publication.lock");
  // mkdir fails if a plain file exists: an unreadable lease must never be reclaimed.
  await assert.rejects(() => acquirePublicationLease({ stateDir }), (error) => error.code === "E_PUBLICATION_LEASE" || error?.code === "EEXIST");
  rmSync(leaseDir, { force: true });
});

function promotionDeps({ mutate = (state) => { state.served = NEXT; state.alias = STAGED_DEPLOYMENT; }, now = () => Date.parse("2026-10-27T13:00:00Z") } = {}) {
  const state = { alias: PRED_DEPLOYMENT, calls: 0, rolledBack: 0, served: PREV };
  let clock = now();
  const deps = {
    maxAttempts: 3,
    now: () => { clock += 6_000; return clock; },
    probe: async () => ({ publication_revision: 0, release_digest: state.served }),
    readObservation: async () => observation({ alias_target_deployment_id: state.alias, served_deployment_id: state.alias, served_release_digest: state.served }),
    promote: () => { state.calls += 1; mutate(state); },
    rollback: () => { state.rolledBack += 1; state.alias = PRED_DEPLOYMENT; state.served = PREV; },
    sleep: async () => {},
    stateDir: mkdtempSync(join(tmpdir(), "ega-publication-run-")),
  };
  return { deps, state };
}

test("a promotion re-reads live production and records a verified receipt", async (t) => {
  const { deps, state } = promotionDeps();
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  const result = await executePromotion({ apply: true, approval: approval(), candidate, deps, expected });
  assert.equal(result.status, "PROMOTED");
  assert.equal(state.calls, 1);
  const receipt = verifyPublicationReceipt(result.receipt);
  assert.equal(receipt.payload.release_digest, NEXT);
  assert.equal(receipt.payload.previous_release_digest, PREV);
  assert.equal(receipt.payload.publication_revision, 1);
});

test("a concurrent change between verification and promotion blocks the write", async (t) => {
  const { deps, state } = promotionDeps();
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  let reads = 0;
  const inner = deps.readObservation;
  deps.readObservation = async () => {
    reads += 1;
    if (reads === 2) return observation({ served_release_digest: DIGEST("f") });
    return inner();
  };
  await assert.rejects(() => executePromotion({ apply: true, approval: approval(), candidate, deps, expected }), (error) => ["E_PUBLICATION_RACE", "E_PREDECESSOR_MISMATCH", "E_PUBLICATION_BLOCKED"].includes(error.code));
  assert.equal(state.calls, 0);
});

test("an unverified promotion restores only its own predecessor", async (t) => {
  const { deps, state } = promotionDeps({ mutate: (current) => { current.alias = STAGED_DEPLOYMENT; current.served = DIGEST("f"); } });
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  await assert.rejects(() => executePromotion({ apply: true, approval: approval(), candidate, deps, expected }), (error) => error.code === "E_PROMOTION_UNVERIFIED");
  assert.equal(state.rolledBack, 1);
  assert.equal(state.served, PREV);

  const superseded = promotionDeps({ mutate: (current) => { current.alias = "dpl_other12345678"; current.served = NEXT; } });
  t.after(() => rmSync(superseded.deps.stateDir, { recursive: true, force: true }));
  await assert.rejects(
    () => executePromotion({ apply: true, approval: approval(), candidate, deps: superseded.deps, expected }),
    (error) => error.code === "E_PUBLICATION_SUPERSEDED",
  );
  assert.equal(superseded.state.rolledBack, 0);
});

test("rollback requires a contiguous receipt chain and verifies the retained release", async (t) => {
  const actor = approval().payload.publisher;
  const base = {
    actor,
    approval_digest: approval().digest,
    candidate_digest: CANDIDATE,
    canonical_alias: ALIAS,
    detail: "fixture",
    hub_id: "personal",
    policy_digest: POLICY,
  };
  const first = createPublicationReceipt({
    ...base,
    action: "PROMOTE",
    completed_at: "2026-10-27T12:10:00.000Z",
    deployment_id: "dpl_first12345678",
    previous_deployment_id: "dpl_zero12345678",
    previous_release_digest: DIGEST("9"),
    previous_revision: 0,
    publication_revision: 1,
    release_digest: PREV,
    status: "SUCCEEDED",
  });
  const second = createPublicationReceipt({
    ...base,
    action: "PROMOTE",
    completed_at: "2026-10-27T12:20:00.000Z",
    deployment_id: STAGED_DEPLOYMENT,
    previous_deployment_id: "dpl_first12345678",
    previous_release_digest: PREV,
    previous_revision: 1,
    publication_revision: 2,
    release_digest: NEXT,
    status: "SUCCEEDED",
  });
  verifyPublicationReceipt(second, first);

  const state = { served: NEXT };
  const deps = {
    maxAttempts: 3,
    now: () => Date.parse("2026-10-27T13:00:00Z"),
    probe: async () => ({ publication_revision: 0, release_digest: state.served }),
    promote: (deployment) => { state.served = deployment === "dpl_first12345678" ? PREV : NEXT; },
    sleep: async () => {},
  };
  const result = await executeRollback({ apply: true, chain: [second, first], current: second, deps, target: first });
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(state.served, PREV);
  const receipt = verifyPublicationReceipt(result.receipt, second);
  assert.equal(receipt.payload.publication_revision, 3);
  assert.equal(receipt.payload.previous_release_digest, NEXT);
  assert.equal(receipt.payload.release_digest, PREV);

  const foreign = createPublicationReceipt({ ...base, action: "PROMOTE", completed_at: "2026-10-27T12:30:00.000Z", deployment_id: "dpl_foreign123456", previous_deployment_id: "dpl_first12345678", previous_release_digest: PREV, previous_revision: 1, publication_revision: 2, release_digest: DIGEST("f"), status: "SUCCEEDED" });
  await assert.rejects(() => executeRollback({ apply: false, chain: [second, first], current: second, deps, target: foreign }), (error) => error.code === "E_ROLLBACK_TARGET");
});

test("approval and receipt envelopes reject unknown fields and broken chains", () => {
  assert.throws(() => verifyPublicationApproval({ ...approval(), extra: true }), /invalid|unknown fields/);
  const actor = approval().payload.publisher;
  const base = {
    actor,
    approval_digest: approval().digest,
    candidate_digest: CANDIDATE,
    canonical_alias: ALIAS,
    completed_at: "2026-10-27T12:10:00.000Z",
    detail: "fixture",
    hub_id: "personal",
    policy_digest: POLICY,
  };
  const receipt = createPublicationReceipt({ ...base, action: "PROMOTE", deployment_id: "dpl_first12345678", previous_deployment_id: "dpl_zero12345678", previous_release_digest: PREV, previous_revision: 0, publication_revision: 1, release_digest: NEXT, status: "SUCCEEDED" });
  assert.throws(() => verifyPublicationReceipt(receipt, receipt), /contiguous/);
  assert.throws(() => verifyPublicationReceipt({ ...receipt, payload: { ...receipt.payload, publication_revision: 3 } }), /digest|envelope/i);
});

test("the CLI never imports a token from argv", () => {
  const source = readFileSync(new URL("../../scripts/hosted/publish-production.mjs", import.meta.url), "utf8");
  assert.match(source, /EGA_VERCEL_TOKEN_FILE/);
  assert.doesNotMatch(source, /--token/);
  assert.doesNotMatch(source, /["\']--force["\']/);
  assert.ok(source.includes("x-vercel-protection-bypass"));
});
