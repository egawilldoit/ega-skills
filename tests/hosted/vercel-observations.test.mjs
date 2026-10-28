import assert from "node:assert/strict";
import test from "node:test";
import { observationFromVercel, VercelApi } from "../../scripts/hosted/publish-production.mjs";

const expected = { canonical_alias: "ega-skills-mcp.vercel.app", project_id: "prj_test", team_id: "team_test", publisher_vercel_user_id: "user_test" };
const deployment = { id: "dpl_current", projectId: expected.project_id, target: "production", readyState: "READY", checksConclusion: "succeeded", alias: [expected.canonical_alias] };
const project = { id: expected.project_id, accountId: expected.team_id, link: { productionBranch: "release/2.0" }, git: { deploymentEnabled: false } };
const observe = (changes) => observationFromVercel({ user: { id: expected.publisher_vercel_user_id }, project: { ...project, ...changes }, deployments: [deployment], expected, served: { release_digest: "sha256:" + "a".repeat(64) } });

test("GitHub deployment notifications and build cancellation are not auto-deploy controls", () => {
  for (const notification of ["disabled", "enabled", false, true, undefined]) {
    assert.equal(observe({ git: {}, gitProviderOptions: { createDeployments: notification }, commandForIgnoringBuildStep: "exit 0" }).git_production_auto_deploy, true);
    assert.equal(observe({ gitProviderOptions: { createDeployments: notification } }).git_production_auto_deploy, false);
  }
});

test("deployment policy allowlists are not misread as auto-deploy switches", () => {
  for (const rule of [
    { enabled: false, environments: ["production"], sources: [] },
    { enabled: false, environments: [{ type: "system", target: "production" }], sources: [] },
    { enabled: true, environments: [{ type: "system", target: "production" }], sources: [{ provider: "github", org: "egawilldoit", repo: "ega-skills" }] },
    { enabled: true, environments: [{ type: "system", target: "production" }], sources: [] },
  ]) assert.equal(observe({ git: {}, deploymentPolicy: { gitSources: [rule] } }).git_production_auto_deploy, true);
});

test("branch patterns and unknown values cannot conceal an enabling rule", () => {
  for (const enabled of [undefined, true, [], { "release/2.0": false, "release/*": true }, { "release/2.0": false, "*": true }, { "release/*": false }, { "release/2.0": false, "*": null }]) {
    assert.equal(observe({ git: { deploymentEnabled: enabled } }).git_production_auto_deploy, true);
  }
  assert.equal(observe({ git: { deploymentEnabled: { "release/2.0": false } } }).git_production_auto_deploy, false);
});

function mockApi({ alias, details, inventory, probe } = {}) {
  const paths = [];
  let aliasReads = 0;
  const api = new VercelApi({ token: "test-only", teamId: expected.team_id, fetch: async (url) => {
    paths.push(url.pathname);
    assert.equal(url.searchParams.get("teamId"), url.pathname === "/v2/user" ? null : expected.team_id);
    let body;
    if (url.pathname === "/v2/user") body = { user: { id: expected.publisher_vercel_user_id } };
    else if (url.pathname.startsWith("/v9/projects/")) body = project;
    else if (url.pathname.startsWith("/v4/aliases/")) body = alias?.(++aliasReads) ?? { alias: expected.canonical_alias, projectId: expected.project_id, deploymentId: deployment.id };
    else if (url.pathname.endsWith("/aliases")) body = inventory ?? { aliases: [{ alias: expected.canonical_alias, deploymentId: deployment.id }] };
    else if (url.pathname.startsWith("/v13/deployments/")) body = details ?? deployment;
    else throw Error(`Unexpected API path ${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200 });
  } });
  return { paths, read: () => api.readProduction(expected, probe) };
}

test("actual alias endpoint and full deployment identify production without a recent-deployment list", async () => {
  const api = mockApi({ probe: async () => ({ release_digest: "live" }) });
  const observed = await api.read();
  assert.equal(observed.alias_target_deployment_id, deployment.id);
  assert.equal(observed.served_release_digest, "live");
  assert.equal(observed.deployment_checks_state, "succeeded");
  assert.equal(api.paths.length, 6);
  assert.equal(api.paths.some((path) => path.startsWith("/v6/deployments")), false);
});

test("alias changes across the probe reject mixed deployment and release observations", async () => {
  const api = mockApi({ alias: (n) => ({ alias: expected.canonical_alias, projectId: expected.project_id, deploymentId: n === 1 ? deployment.id : "dpl_newer" }), probe: async () => ({ release_digest: "live" }) });
  await assert.rejects(api.read(), { code: "E_ALIAS_DRIFT" });
});

test("foreign projects, redirects and deployment target mismatches fail closed", async () => {
  for (const alias of [
    { alias: expected.canonical_alias, projectId: "prj_other", deploymentId: deployment.id },
    { alias: "other.example", projectId: expected.project_id, deploymentId: deployment.id },
    { alias: expected.canonical_alias, projectId: expected.project_id, deploymentId: deployment.id, redirect: "other.example" },
  ]) await assert.rejects(mockApi({ alias: () => alias }).read(), { code: "E_ALIAS_DRIFT" });
  for (const changes of [{ projectId: "prj_other" }, { id: "dpl_other" }, { target: "preview" }]) {
    await assert.rejects(mockApi({ details: { ...deployment, ...changes } }).read(), { code: "E_ALIAS_DRIFT" });
  }
});

test("alias inventory is complete and absent deployment checks never become success", async () => {
  for (const inventory of [{}, { aliases: [], pagination: { next: 1 } }, { aliases: [{ alias: expected.canonical_alias, deploymentId: "dpl_other" }] }]) {
    await assert.rejects(mockApi({ inventory }).read(), { code: "E_PLATFORM_GUARD" });
  }
  await assert.rejects(mockApi({ inventory: { aliases: [] } }).read(), { code: "E_ALIAS_DRIFT" });
  const observed = await mockApi({ details: { ...deployment, checksConclusion: null, checksState: null }, inventory: { aliases: [{ alias: expected.canonical_alias }, { alias: "extra.vercel.app" }] } }).read();
  assert.equal(observed.deployment_checks_state, "none");
  assert.deepEqual(observed.production_aliases, [expected.canonical_alias, "extra.vercel.app"]);
  assert.equal(observed.served_release_digest, undefined);
});
