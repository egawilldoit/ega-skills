import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assessProductionPublication,
  createPublicationApproval,
  createPublicationReceipt,
  verifyPublicationApproval,
  verifyPublicationReceipt,
} from "../../packages/project/dist/index.js";
import {
  acquirePublicationLease,
  assertPublicationPlatform,
  executePromotion,
  executeStage,
  executeReconcile,
  executeRollback,
  observationFromVercel,
  readCandidate,
  verifyPublicationReadiness,
  withPublicationReceipt,
  VercelApi,
  probeReady,
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
  source_snapshot_digest: SOURCE,
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
  const project = { accountId: TEAM, git: { deploymentEnabled: { "release/2.0": false }, productionBranch: "release/2.0" }, id: PROJECT, link: { org: "egawilldoit", productionBranch: "release/2.0", repo: "ega-skills" } };
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
  assert.equal(policyDisabled.git_production_auto_deploy, true);

  const contradictory = observationFromVercel({
    deployments: deployments.deployments,
    expected,
    project: { ...project, deploymentPolicy: { gitSources: [{ enabled: false, environments: ["production"], sources: [] }] }, git: { deploymentEnabled: { "release/2.0": true }, productionBranch: "release/2.0" } },
    served: { release_digest: PREV },
    user: { id: PUBLISHER },
  });
  assert.equal(contradictory.git_production_auto_deploy, true);

  const viaProjectAlias = observationFromVercel({
    deployments: [],
    expected,
    project: {
      ...project,
      alias: [{ deployment: { checksConclusion: "succeeded", checksState: "completed", id: PRED_DEPLOYMENT, readyState: "READY" }, domain: ALIAS, target: "PRODUCTION" }],
      git: {},
      link: { org: "egawilldoit", productionBranch: "release/2.0", repo: "ega-skills" },
    },
    served: { release_digest: PREV },
    user: { id: PUBLISHER },
  });
  assert.equal(viaProjectAlias.alias_target_deployment_id, PRED_DEPLOYMENT);
  assert.equal(viaProjectAlias.deployment_checks_state, "succeeded");
});

test("the publication lease has exactly one owner and never reclaims an unreadable owner", async (t) => {
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

function readiness(stateDir, overrides = {}) {
  return { schema_version: 1, verified_at: "2026-10-27T12:00:00Z", expires_at: "2026-10-28T12:00:00Z",
    publisher_vercel_user_id: PUBLISHER, team_id: TEAM, project_id: PROJECT, canonical_alias: ALIAS,
    production_branch: "release/2.0", state_dir: stateDir, certified_by: "owner",
    review_record: "https://github.com/egawilldoit/ega-skills/issues/168#readiness",
    access_controls_reviewed: true, single_writer_controls_reviewed: true, residual_alias_race_accepted: true, ...overrides };
}

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
  deps.readiness = readiness(deps.stateDir);
  deps.recordReceipt = async () => {};
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
  await assert.rejects(() => executePromotion({ apply: true, approval: approval(), candidate, deps, expected }), (error) => error.code === "E_PROMOTION_UNVERIFIED" && error.receipt?.payload?.status === "FAILED");
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

test("a matching release with unhealthy deployment checks is restored, not certified", async t => {
  const { deps, state } = promotionDeps();
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  const read = deps.readObservation;
  deps.readObservation = async () => ({ ...await read(), deployment_checks_state: state.alias === STAGED_DEPLOYMENT ? "failed" : "succeeded" });
  await assert.rejects(() => executePromotion({ apply: true, approval: approval(), candidate, deps, expected }), error => error.code === "E_CHECKS_NOT_PASSED" && error.receipt?.payload.status === "FAILED");
  assert.equal(state.rolledBack, 1);
  assert.equal(state.alias, PRED_DEPLOYMENT);
});

test("a promotion with unavailable readiness restores its own healthy predecessor", async t => {
  const { deps, state } = promotionDeps();
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  const probe = deps.probe;
  deps.probe = async url => state.alias === STAGED_DEPLOYMENT
    ? probeReady(`https://${url}`, { fetch: async () => new Response("{}", { status: 503 }) }) : probe(url);
  deps.readRecoveryObservation = async () => observation({ alias_target_deployment_id: state.alias, served_deployment_id: state.alias,
    served_release_digest: undefined, deployment_ready_state: "ERROR", deployment_checks_state: "failed" });
  await assert.rejects(() => executePromotion({ apply: true, approval: approval(), candidate, deps, expected }), error => error.code === "E_PROBE_UNAVAILABLE" && error.receipt?.payload.status === "FAILED");
  assert.equal(state.rolledBack, 1);
  assert.equal(state.alias, PRED_DEPLOYMENT);
});

test("legacy readiness without a release identity cannot authorize publication", async () => {
  await assert.rejects(probeReady(`https://${ALIAS}`, {
    fetch: async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
  }), { code: "E_PROBE_UNAVAILABLE" });
});

test("authenticated recovery observation does not require a healthy application", async () => {
  const calls = [];
  const api = new VercelApi({ token: "test-only", teamId: TEAM, fetch: async url => {
    calls.push(url.pathname);
    const body = url.pathname === "/v2/user" ? { user: { id: PUBLISHER } }
      : url.pathname.startsWith("/v9/projects/") ? { id: PROJECT, accountId: TEAM, git: { productionBranch: "release/2.0", deploymentEnabled: false } }
      : url.pathname.startsWith("/v4/aliases/") ? { alias: ALIAS, deploymentId: STAGED_DEPLOYMENT, projectId: PROJECT }
      : url.pathname.endsWith("/aliases") ? { aliases: [{ alias: ALIAS, deploymentId: STAGED_DEPLOYMENT }] }
      : { id: STAGED_DEPLOYMENT, projectId: PROJECT, target: "production", readyState: "ERROR", checksConclusion: "failed" };
    return new Response(JSON.stringify(body), { status: 200 });
  } });
  const observed = await api.readProduction(expected);
  assert.equal(observed.alias_target_deployment_id, STAGED_DEPLOYMENT);
  assert.equal(observed.served_release_digest, undefined);
  assert.equal(observed.deployment_ready_state, "ERROR");
  assert.equal(calls.length, 6);
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

  const state = { served: NEXT, alias: STAGED_DEPLOYMENT, calls: 0 };
  const stateDir = mkdtempSync(join(tmpdir(), "ega-publication-rollback-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-27T13:00:00Z");
  const deps = {
    maxAttempts: 3,
    now: () => { clock += 6_000; return clock; },
    probe: async () => ({ publication_revision: 0, release_digest: state.served }),
    readObservation: async () => observation({ alias_target_deployment_id: state.alias, served_deployment_id: state.alias, served_release_digest: state.served }),
    promote: () => { throw new Error("retained deployment must use rollback"); },
    rollback: (deployment) => { state.calls++; state.alias = deployment; state.served = deployment === "dpl_first12345678" ? PREV : NEXT; },
    readiness: readiness(stateDir), recordReceipt: async () => {},
    sleep: async () => {},
    stateDir,
  };
  const rollbackExpected = { ...expected, expected_revision: 2, predecessor_deployment_id: STAGED_DEPLOYMENT, predecessor_release_digest: NEXT };
  const result = await executeRollback({ apply: true, chain: [second, first], current: second, deps, expected: rollbackExpected, target: first });
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(state.served, PREV);
  const receipt = verifyPublicationReceipt(result.receipt, second);
  assert.equal(receipt.payload.publication_revision, 3);
  assert.equal(receipt.payload.previous_release_digest, NEXT);
  assert.equal(receipt.payload.release_digest, PREV);

  // A matching semantic digest on a different deployment is not the predecessor.
  state.served = NEXT; state.alias = "dpl_outside123456";
  await assert.rejects(() => executeRollback({ apply: true, chain: [second, first], current: second, target: first, deps, expected: rollbackExpected }), error => error.code === "E_PREDECESSOR_MISMATCH");
  assert.equal(state.calls, 1);
  state.alias = STAGED_DEPLOYMENT;
  const originalObservation = deps.readObservation;
  for (const drift of [{ git_production_auto_deploy: true }, { project_id: "prj_foreign" }, { team_id: "team_foreign" }]) {
    deps.readObservation = async () => ({ ...await originalObservation(), ...drift });
    await assert.rejects(() => executeRollback({ apply: true, chain: [second, first], current: second, target: first, deps, expected: rollbackExpected }), error => error.code === "E_PLATFORM_GUARD");
    assert.equal(state.calls, 1);
  }
  for (const drift of [{ deployment_ready_state: "ERROR" }, { deployment_checks_state: "failed" }, { deployment_checks_state: "pending" }]) {
    state.alias = STAGED_DEPLOYMENT; state.served = NEXT;
    deps.readObservation = async () => ({ ...await originalObservation(), ...(state.alias === STAGED_DEPLOYMENT ? drift : {}) });
    assert.equal((await executeRollback({ apply: true, chain: [second, first], current: second, target: first, deps, expected: rollbackExpected })).status, "ROLLED_BACK");
  }
  deps.readObservation = originalObservation;
  // During an outage, the trusted receipt and authenticated API bind the exact
  // current deployment without claiming /readyz succeeded.
  state.alias = STAGED_DEPLOYMENT; state.served = NEXT;
  const originalProbe = deps.probe;
  deps.probe = async () => state.alias === STAGED_DEPLOYMENT ? probeReady(`https://${ALIAS}`, { fetch: async () => new Response("{}", { status: 503 }) }) : originalProbe();
  deps.readRecoveryObservation = async () => ({ ...await originalObservation(), served_release_digest: undefined, deployment_ready_state: "ERROR" });
  assert.equal((await executeRollback({ apply: true, chain: [second, first], current: second, target: first, deps, expected: rollbackExpected })).status, "ROLLED_BACK");
  state.alias = "dpl_foreign12345678"; state.served = NEXT;
  const recoveredCalls = state.calls;
  await assert.rejects(() => executeRollback({ apply: true, chain: [second, first], current: second, target: first, deps, expected: rollbackExpected }), error => error.code === "E_PREDECESSOR_MISMATCH");
  assert.equal(state.calls, recoveredCalls);
  delete deps.readRecoveryObservation; deps.probe = originalProbe;
  state.alias = STAGED_DEPLOYMENT; state.served = NEXT;
  // An unhealthy retained TARGET is never certified after the mutation.
  deps.readObservation = async () => ({ ...await originalObservation(), ...(state.alias === "dpl_first12345678" ? { deployment_checks_state: "failed" } : {}) });
  await assert.rejects(() => executeRollback({ apply: true, chain: [second, first], current: second, target: first, deps, expected: rollbackExpected }), error => error.code === "E_CHECKS_NOT_PASSED");
  deps.readObservation = originalObservation;
  state.alias = STAGED_DEPLOYMENT; state.served = NEXT;
  const callsBeforeBoundaryTests = state.calls;
  for (const changes of [{ hub_id: "foreign" }, { canonical_alias: "foreign.vercel.app" }, { actor: { ...actor, project_id: "prj_foreign" } }]) {
    const crossed = createPublicationReceipt({ ...first.payload, ...changes });
    await assert.rejects(() => executeRollback({ apply: true, chain: [second, crossed], current: second, target: crossed, deps, expected: rollbackExpected }), /boundary|crosses/);
    assert.equal(state.calls, callsBeforeBoundaryTests);
  }

  // The first promotion can restore the original retained 117-skill candidate,
  // without fabricating a historical publication receipt.
  const genesis = createPublicationReceipt({ ...second.payload, previous_revision: 0, publication_revision: 1 });
  const original = { ...candidate, hub_id: "personal", release_digest: PREV, policy_digest: "", candidate_digest: DIGEST("7") };
  const genesisExpected = { ...rollbackExpected, expected_revision: 1 };
  await assert.rejects(() => executeRollback({ apply: true, chain: [genesis], current: genesis, previousCandidate: { ...original, release_digest: DIGEST("f") }, deps, expected: genesisExpected }), /exact retained/);
  const recovered = await executeRollback({ apply: true, chain: [genesis], current: genesis, previousCandidate: original, deps, expected: genesisExpected });
  assert.equal(recovered.receipt.payload.release_digest, PREV);
  assert.equal(recovered.receipt.payload.candidate_digest, original.candidate_digest);
  assert.equal(recovered.receipt.payload.policy_digest, "");
  assert.equal(state.alias, "dpl_first12345678");

  const foreign = createPublicationReceipt({ ...base, action: "PROMOTE", completed_at: "2026-10-27T12:30:00.000Z", deployment_id: "dpl_foreign123456", previous_deployment_id: "dpl_first12345678", previous_release_digest: PREV, previous_revision: 1, publication_revision: 2, release_digest: DIGEST("f"), status: "SUCCEEDED" });
  await assert.rejects(() => executeRollback({ apply: false, chain: [second, first], current: second, deps, expected: rollbackExpected, target: foreign }), (error) => error.code === "E_ROLLBACK_TARGET");
  const failed = createPublicationReceipt({ ...base, action: "PROMOTE", completed_at: "2026-10-27T12:40:00.000Z", deployment_id: "dpl_failed1234567", previous_deployment_id: "dpl_first12345678", previous_release_digest: PREV, previous_revision: 1, publication_revision: 1, release_digest: DIGEST("8"), status: "FAILED" });
  await assert.rejects(() => executeRollback({ apply: false, chain: [second, failed], current: second, deps, expected: rollbackExpected, target: failed }), (error) => error.code === "E_ROLLBACK_TARGET");
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

  // A FAILED side receipt records the attempt at the same revision and never
  // advances the successful chain.
  const failed = createPublicationReceipt({ ...base, action: "PROMOTE", deployment_id: "dpl_first12345678", previous_deployment_id: "dpl_zero12345678", previous_release_digest: PREV, previous_revision: 0, publication_revision: 0, release_digest: NEXT, status: "FAILED" });
  assert.equal(verifyPublicationReceipt(failed).payload.publication_revision, 0);
  const invalidFailed = createPublicationReceipt({ ...base, action: "PROMOTE", deployment_id: "dpl_first12345678", previous_deployment_id: "dpl_zero12345678", previous_release_digest: PREV, previous_revision: 0, publication_revision: 1, release_digest: NEXT, status: "FAILED" });
  assert.throws(() => verifyPublicationReceipt(invalidFailed), /failed receipt/i);
});

test("the CLI never imports a token from argv", () => {
  const source = readFileSync(new URL("../../scripts/hosted/publish-production.mjs", import.meta.url), "utf8");
  assert.match(source, /EGA_VERCEL_TOKEN_FILE/);
  assert.doesNotMatch(source, /--token/);
  assert.doesNotMatch(source, /["\']--force["\']/);
  assert.ok(source.includes("x-vercel-protection-bypass"));
});

test("the real candidate reader feeds the gate with a defined candidate digest", async () => {
  const directory = fileURLToPath(new URL("../../packages/mcp/artifact/", import.meta.url));
  const read = await readCandidate(directory);
  const raw = JSON.parse(readFileSync(join(directory, "candidate.json"), "utf8"));
  assert.equal(read.candidate_digest, raw.digest);
  const sourceSnapshot = "sha256:baee615c166889a7a6743cbff0eb4cf24e9f37cbe621d1fd69723de4ce599360";
  assert.equal(raw.schema_version, 3);
  assert.equal(read.source_snapshot_digest, sourceSnapshot);
  assert.equal(read.policy_digest, "sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6");
  const payload = createPublicationApprovalPayload(read, sourceSnapshot);
  const approvalValue = createPublicationApproval(payload);
  const result = assessProductionPublication({
    approval: approvalValue,
    candidate: read,
    expected: {
      ...expected,
      predecessor_deployment_id: PRED_DEPLOYMENT,
      predecessor_release_digest: read.previous_release_digest,
    },
    observation: observation({
      alias_target_deployment_id: PRED_DEPLOYMENT,
      served_deployment_id: PRED_DEPLOYMENT,
      served_release_digest: read.previous_release_digest,
    }),
  });
  assert.equal(result.status, "READY", JSON.stringify(result.blockers));
  const mismatchedSource = assessProductionPublication({
    approval: createPublicationApproval({ ...payload, source_snapshot_digest: "" }),
    candidate: read,
    expected: { ...expected, predecessor_release_digest: read.previous_release_digest },
    observation: observation({ served_release_digest: read.previous_release_digest }),
  });
  assert.equal(mismatchedSource.status, "BLOCKED");
  assert.ok(mismatchedSource.blockers.some((blocker) => blocker.code === "E_CANDIDATE_MISMATCH" && blocker.message.includes("source snapshot")));
});

function createPublicationApprovalPayload(read, snapshot) {
  return {
    approval_record: "https://github.com/egawilldoit/ega-skills/issues/168#approval",
    approved_at: "2026-10-27T12:00:00.000Z",
    approved_by: "owner",
    candidate_digest: read.candidate_digest,
    hub_id: read.hub_id,
    policy_digest: read.policy_digest,
    previous_release_digest: read.previous_release_digest,
    publisher: { owner_subject: "owner", project_id: PROJECT, team_id: TEAM, vercel_user_id: PUBLISHER },
    release_digest: read.release_digest,
    skill_versions: read.skill_versions,
    source_snapshot_digest: snapshot,
  };
}

test("an interrupted promotion can be reconciled only from the exact live candidate", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "ega-publication-reconcile-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const live = { alias: STAGED_DEPLOYMENT, served: NEXT };
  const deps = {
    maxAttempts: 3,
    now: () => Date.parse("2026-10-27T13:00:00Z"),
    probe: async () => ({ publication_revision: 0, release_digest: live.served }),
    readObservation: async () => observation({ alias_target_deployment_id: live.alias, served_deployment_id: live.alias, served_release_digest: live.served }),
    sleep: async () => {},
    stateDir, readiness: readiness(stateDir), recordReceipt: async () => {},
  };
  const result = await executeReconcile({ apply: true, approval: approval(), candidate, deps, expected });
  assert.equal(result.status, "RECONCILED");
  const receipt = verifyPublicationReceipt(result.receipt);
  assert.equal(receipt.payload.publication_revision, 1);
  assert.equal(receipt.payload.release_digest, NEXT);

  live.alias = PRED_DEPLOYMENT;
  await assert.rejects(() => executeReconcile({ apply: true, approval: approval(), candidate, deps, expected }), (error) => error.code === "E_RECONCILE_STATE");
});


test("expired active lease cannot be stolen and cannot authorize a later mutation", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "ega-publication-expiry-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const lease = await acquirePublicationLease({ now: 1000, ttlMs: 100, stateDir });
  await assert.rejects(() => acquirePublicationLease({ now: 1101, stateDir }), error => error.code === "E_PUBLICATION_LEASE");
  assert.throws(() => lease.assertHeld(1101), error => error.code === "E_PUBLICATION_LEASE");
  assert.equal(lease.release(), true);
});

test("readiness certification is required, target-bound and time-bounded", () => {
  const dir = join(tmpdir(), "ega-publication-readiness");
  const now = Date.parse(expected.now);
  verifyPublicationReadiness(readiness(dir), expected, now, dir);
  for (const record of [undefined, readiness(dir, { project_id: "other" }), readiness(dir, { state_dir: "/other" }), readiness(dir, { expires_at: expected.now }), readiness(dir, { residual_alias_race_accepted: false })]) {
    assert.throws(() => verifyPublicationReadiness(record, expected, now, dir), error => error.code === "E_PUBLICATION_READINESS");
  }
});

test("receipt reservation precedes mutation and durable recording retains the lease", async t => {
  const { deps, state } = promotionDeps();
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  const path = join(deps.stateDir, "receipt.json");
  writeFileSync(path, "existing");
  await assert.rejects(() => withPublicationReceipt(path, true, recordReceipt => executePromotion({ apply: true, approval: approval(), candidate, deps: { ...deps, recordReceipt }, expected })), error => error.code === "EEXIST");
  assert.equal(state.calls, 0);
  rmSync(path);
  const result = await withPublicationReceipt(path, true, recordReceipt => executePromotion({ apply: true, approval: approval(), candidate, deps: { ...deps, recordReceipt: async receipt => {
    await assert.rejects(() => acquirePublicationLease({ stateDir: deps.stateDir, now: Date.parse(expected.now) }), error => error.code === "E_PUBLICATION_LEASE");
    await recordReceipt(receipt);
  } }, expected }));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).digest, result.receipt.digest);
  assert.equal(state.calls, 1);
});


test("publication CLI fails clearly on unreviewed operating systems", () => {
  assertPublicationPlatform("linux");
  for (const platform of ["win32", "darwin"]) assert.throws(() => assertPublicationPlatform(platform), error => error.code === "E_PUBLICATION_PLATFORM");
});


test("staging verifies the candidate while retaining the live predecessor", async t => {
  const { deps, state } = promotionDeps();
  t.after(() => rmSync(deps.stateDir, { recursive: true, force: true }));
  deps.deployStagedProduction = async () => ({ deployment_id: STAGED_DEPLOYMENT, url: "https://staged.example.com" });
  const probe = deps.probe;
  deps.probe = async url => url === "https://staged.example.com" ? { release_digest: NEXT } : probe(url);
  const result = await executeStage({ apply: true, approval: approval(), candidate, deps, expected });
  assert.equal(result.status, "STAGED");
  assert.equal(state.alias, PRED_DEPLOYMENT);
  assert.equal(state.calls, 0);
  deps.deployStagedProduction = async () => { state.alias = STAGED_DEPLOYMENT; state.served = NEXT; return { deployment_id: STAGED_DEPLOYMENT, url: "https://staged.example.com" }; };
  await assert.rejects(() => executeStage({ apply: true, approval: approval(), candidate, deps, expected }), error => error.code === "E_PREDECESSOR_MISMATCH");
});
