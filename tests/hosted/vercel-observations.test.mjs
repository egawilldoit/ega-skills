import assert from "node:assert/strict";
import test from "node:test";
import { observationFromVercel, VercelApi } from "../../scripts/hosted/publish-production.mjs";

const expected = { canonical_alias: "ega-skills-mcp.vercel.app", production_branch: "main", project_id: "prj_test", team_id: "team_test", publisher_vercel_user_id: "user_test" };
const deployment = { id: "dpl_current", projectId: expected.project_id, target: "production", readyState: "READY", checksConclusion: "succeeded", alias: [expected.canonical_alias], meta: { githubCommitRef: "main" } };
const project = { id: expected.project_id, name: "ega-skills-mcp", accountId: expected.team_id, link: { productionBranch: "main" }, git: { deploymentEnabled: false } };
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
  for (const enabled of [undefined, true, [], { main: false, "release/*": true }, { main: false, "*": true }, { "release/*": false }, { main: false, "*": null }]) {
    assert.equal(observe({ git: { deploymentEnabled: enabled } }).git_production_auto_deploy, true);
  }
  assert.equal(observe({ git: { deploymentEnabled: { main: false } } }).git_production_auto_deploy, false);
});

function mockApi({ alias, details, inventory, probe, projectDetails = project } = {}) {
  const paths = [];
  let aliasReads = 0;
  const api = new VercelApi({ token: "test-only", teamId: expected.team_id, fetch: async (url) => {
    paths.push(url.pathname);
    assert.equal(url.searchParams.get("teamId"), url.pathname === "/v2/user" ? null : expected.team_id);
    let body;
    if (url.pathname === "/v2/user") body = { user: { id: expected.publisher_vercel_user_id } };
    else if (url.pathname.startsWith("/v9/projects/")) body = projectDetails;
    else if (url.pathname.startsWith("/v4/aliases/")) {
      const name = decodeURIComponent(url.pathname.slice("/v4/aliases/".length));
      body = alias?.(++aliasReads, name) ?? { alias: name, projectId: expected.project_id, deploymentId: deployment.id };
    }
    else if (url.pathname.endsWith("/aliases")) body = inventory ?? { aliases: [{ alias: expected.canonical_alias, deploymentId: deployment.id }] };
    else if (url.pathname.startsWith("/v13/deployments/")) body = details ?? deployment;
    else throw Error(`Unexpected API path ${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200 });
  } });
  return { paths, read: (expectation = expected) => api.readProduction(expectation, probe) };
}

test("explicit project auto-deploy values remain authoritative", () => {
  for (const enabled of [true, { main: true }, "unknown", []]) {
    const observed = observe({ git: { deploymentEnabled: enabled } });
    assert.equal(observed.git_deployment_enabled_present, true, JSON.stringify(enabled));
    assert.equal(observed.git_production_auto_deploy, true, JSON.stringify(enabled));
  }
  assert.equal(observe({ git: {} }).git_deployment_enabled_present, false);
  assert.equal(observe({ git: { deploymentEnabled: null } }).git_deployment_enabled_present, false);
  assert.equal(observe({ git: { deploymentEnabled: false } }).git_deployment_enabled_present, true);
});

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
  await assert.rejects(mockApi({ inventory: { aliases: [{ alias: expected.canonical_alias }, { alias: "extra.vercel.app" }] } }).read(), { code: "E_PLATFORM_GUARD" });
  const observed = await mockApi({ details: { ...deployment, checksConclusion: null, checksState: null } }).read();
  assert.equal(observed.deployment_checks_state, "none");
  assert.deepEqual(observed.production_aliases, [expected.canonical_alias]);
  assert.equal(observed.served_release_digest, undefined);
});


test("main production cutover requires the observed branch and a disabled Git deployment switch", async () => {
  const mainExpected = { ...expected, production_branch: "main" };
  const onMain = mockApi({ projectDetails: { ...project, link: { productionBranch: "main" } } });
  assert.equal((await onMain.read(mainExpected)).production_branch, "main");
  await assert.rejects(mockApi({ projectDetails: { ...project, link: { productionBranch: "release/2.0" } } }).read(mainExpected), { code: "E_PLATFORM_GUARD" });
  const enabled = mockApi({ projectDetails: { ...project, link: { productionBranch: "main" }, git: { deploymentEnabled: true } } });
  assert.equal((await enabled.read(mainExpected)).git_production_auto_deploy, true);
});

test("alias inventory refuses duplicates and redirects, including empty redirect targets", async () => {
  for (const inventory of [
    { aliases: [{ alias: expected.canonical_alias }, { alias: expected.canonical_alias }] },
    { aliases: [{ alias: expected.canonical_alias, redirect: "other.example" }] },
    { aliases: [{ alias: expected.canonical_alias, redirect: "" }] },
  ]) await assert.rejects(mockApi({ inventory }).read(), { code: "E_PLATFORM_GUARD" });
  await assert.rejects(mockApi({ alias: () => ({ alias: expected.canonical_alias, projectId: expected.project_id, deploymentId: deployment.id, redirect: "" }) }).read(), { code: "E_ALIAS_DRIFT" });
});

test("direct Vercel-managed aliases are accepted while unknown or redirected ones are refused", async () => {
  const generated = "ega-skills-mcp-git-main-egas-projects-4fb87621.vercel.app";
  const projectAlias = "ega-skills-mcp-egas-projects-4fb87621.vercel.app";
  const inventory = { aliases: [expected.canonical_alias, generated, projectAlias].map((alias) => ({ alias, deploymentId: deployment.id })) };
  const observed = await mockApi({ inventory }).read();
  assert.deepEqual(observed.production_aliases, [expected.canonical_alias, generated, projectAlias].sort());
  assert.equal(observed.project_name, project.name);

  for (const inventory of [
    { aliases: [expected.canonical_alias, "ega-skills-mcp-unknown.vercel.app"].map((alias) => ({ alias, deploymentId: deployment.id })) },
    { aliases: [expected.canonical_alias, "ega-skills-mcp-git-release-2-0-egas-projects-4fb87621.vercel.app"].map((alias) => ({ alias, deploymentId: deployment.id })) },
    { aliases: [expected.canonical_alias, generated].map((alias) => ({ alias, deploymentId: deployment.id })), pagination: { next: 1 } },
  ]) await assert.rejects(mockApi({ inventory }).read(), { code: "E_PLATFORM_GUARD" });

  for (const alias of [
    { alias: generated, deploymentId: "dpl_other" },
    { alias: projectAlias, redirect: "other.example" },
  ]) {
    await assert.rejects(
      mockApi({
        alias: (read, name) => name === expected.canonical_alias ? undefined : { ...alias, alias: name },
        inventory: { aliases: [expected.canonical_alias, alias.alias].map((name) => ({ alias: name, deploymentId: deployment.id })) },
      }).read(),
      { code: "E_ALIAS_DRIFT" },
    );
  }

  for (const entry of [
    { domain: projectAlias, target: "PRODUCTION", deployment: { id: "dpl_other" } },
    { domain: projectAlias, target: "PRODUCTION", redirect: "other.example" },
    { domain: projectAlias, target: "production", deployment: { id: "dpl_other" } },
  ]) {
    await assert.rejects(
      mockApi({ projectDetails: { ...project, alias: [entry] } }).read(),
      { code: "E_ALIAS_DRIFT" },
    );
  }
  await assert.rejects(
    mockApi({ projectDetails: { ...project, alias: [{ domain: "ega-skills-mcp-unknown.vercel.app", target: "PRODUCTION" }] } }).read(),
    { code: "E_PLATFORM_GUARD" },
  );
  await assert.rejects(
    mockApi({
      alias: (read, name) => name === expected.canonical_alias ? undefined : { alias: name, projectId: expected.project_id, deploymentId: "dpl_other" },
      projectDetails: { ...project, alias: [{ domain: projectAlias, target: "PRODUCTION" }] },
    }).read(),
    { code: "E_ALIAS_DRIFT" },
  );
  const projectView = await mockApi({
    projectDetails: { ...project, alias: [{ domain: projectAlias, target: "PRODUCTION", deployment: { id: deployment.id } }] },
  }).read();
  assert.deepEqual(projectView.production_aliases, [expected.canonical_alias, projectAlias].sort());
});

test("completed check state without a successful conclusion cannot authorize promotion", async () => {
  for (const details of [
    { ...deployment, checksConclusion: null, checksState: "completed" },
    { ...deployment, checksConclusion: "skipped", checksState: "completed" },
    { ...deployment, checksConclusion: "neutral", checksState: "completed" },
  ]) assert.equal((await mockApi({ details }).read()).deployment_checks_state, "none");
});
