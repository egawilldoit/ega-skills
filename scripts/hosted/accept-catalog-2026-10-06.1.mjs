#!/usr/bin/env node
// Production acceptance for catalog-2026-10-06.1.
//
// Implements the hard invariant recorded in the catalog-2026-09-29.2 tag:
//
//   "Verify a deployment with: exact source SHA + physical artifact hash +
//    runtime path invariant (inspect sources[].local_path relative).
//    Do NOT rely on release_digest alone to prove sanitization."
//
// So this asserts FOUR independent identities, and the digest is never the
// only one:
//
//   1. SEMANTIC   served effective_release_digest == the reviewed digest
//   2. PHYSICAL   every one of the 116 served version_hash values equals the
//                 reviewed per-skill hash (this is the strong check; the digest
//                 deliberately does not cover skill_sources provenance rows)
//   3. PATH       every sources[].local_path is host-relative
//   4. MEMBERSHIP the added skills exist, the withdrawn skill is gone
//
// The expected 116 id -> version_hash pairs are read from the MERGED artifact's
// hub-release.json, so the script can never drift from what was reviewed.
//
// Usage:
//   node scripts/hosted/accept-catalog-2026-10-06.1.mjs --base-url <url>
//   add --allow-missing-digest only when running against a stdio (non-hosted)
//   server, which does not wrap tool results with effective_release_digest.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");

const EXPECTED = {
  catalog: "catalog-2026-10-06.1",
  releaseDigest: "sha256:3de9177a9b14794a12a794904dbada4522d76b833d77c9732566981761a1b1a3",
  previousReleaseDigest: "sha256:1efdbc3d6a1153fce8ca30bad0ad10448bd8e7a0e36709b018355d311de31b77",
  hubId: "personal",
  expectedSkillCount: 116,
  mustExist: ["mattpocock/implement-spec", "mattpocock/pr", "mattpocock/retro"],
  mustNotExist: ["mattpocock/resolving-merge-conflicts"],
};

const HUB_RELEASE = join(REPO_ROOT, "packages/mcp/artifact/hub-release.json");

function parseArgs(argv) {
  const out = { baseUrl: null, allowMissingDigest: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base-url") out.baseUrl = argv[i + 1] ?? null;
    if (argv[i] === "--allow-missing-digest") out.allowMissingDigest = true;
  }
  if (!out.baseUrl) {
    console.error("usage: accept-catalog-2026-10-06.1.mjs --base-url <url> [--allow-missing-digest]");
    process.exit(2);
  }
  return { baseUrl: out.baseUrl.replace(/\/+$/, ""), allowMissingDigest: out.allowMissingDigest };
}

const results = [];
function record(name, ok, detail = "", skipped = false) {
  results.push({ name, ok: Boolean(ok), detail, skipped });
  const tag = skipped ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${name}${detail ? `   ${detail}` : ""}`);
  return Boolean(ok);
}
const check = (name, ok, detail = "") => record(name, ok, detail, false);
const skip = (name, why) => record(name, true, why, true);

// ---------------------------------------------------------------- MCP client
async function makeClient(baseUrl) {
  let sessionId = null;
  async function post(body) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
    if (dataLine) return JSON.parse(dataLine.slice(5));
    // Notifications are answered 202 with no body.
    if (!text.trim()) return null;
    return JSON.parse(text);
  }

  let id = 0;
  const raw = async (name, args) => {
    id += 1;
    const res = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  };

  await post({
    jsonrpc: "2.0",
    id: (id += 1),
    method: "initialize",
    params: { capabilities: {}, clientInfo: { name: "catalog-acceptance", version: "1.0.0" }, protocolVersion: "2025-06-18" },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  return {
    raw,
    async toolNames() {
      const res = await post({ jsonrpc: "2.0", id: (id += 1), method: "tools/list", params: {} });
      return (res?.result?.tools ?? []).map((t) => t.name).sort();
    },
  };
}

const HOST_PATH = /\/(home\/ubuntu|Users|var\/task)\//;

async function main() {
  const { baseUrl, allowMissingDigest } = parseArgs(process.argv.slice(2));

  // Expected identity comes from the reviewed artifact, never hardcoded.
  const reviewed = JSON.parse(readFileSync(HUB_RELEASE, "utf8"));
  const expectedVersions = reviewed.payload.skill_versions;
  const expectedIds = Object.keys(expectedVersions).sort();

  console.log(`catalog acceptance: ${EXPECTED.catalog}`);
  console.log(`target:            ${baseUrl}`);
  console.log(`reviewed artifact: ${HUB_RELEASE}`);
  console.log(`reviewed skills:   ${expectedIds.length}\n`);

  if (expectedIds.length !== EXPECTED.expectedSkillCount) {
    check(`reviewed artifact carries ${EXPECTED.expectedSkillCount} skills`, false, `found ${expectedIds.length}`);
    return finish();
  }

  // ---------------------------------------------------------------- readyz
  try {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.text();
    if (!check(`GET /readyz -> ${res.status}`, res.ok && /ready/i.test(body), body.slice(0, 60))) return finish();
  } catch (err) {
    check("GET /readyz reachable", false, String(err?.message ?? err));
    return finish();
  }

  const client = await makeClient(baseUrl);

  // ------------------------------------------------------------- tool surface
  const tools = await client.toolNames();
  check(
    "exactly 4 tools: get_content, inspect, resolve, search",
    tools.length === 4 && ["get_content", "inspect", "resolve", "search"].every((n) => tools.includes(n)),
    tools.join(", "),
  );

  // ------------------------------------------------ 1. semantic release digest
  const resolveText = await client.raw("resolve", { task: "explain how this subsystem works before I modify it" });
  const servedDigest = (resolveText.match(/effective_release_digest:\s*(sha256:[0-9a-f]{64})/i) ?? [])[1] ?? null;
  if (servedDigest) {
    check(`served effective_release_digest == reviewed`, servedDigest === EXPECTED.releaseDigest, servedDigest);
  } else if (allowMissingDigest) {
    skip("served effective_release_digest", "stdio runtime does not wrap results with the digest");
  } else {
    check("served effective_release_digest is disclosed and correct", false,
      "not disclosed — pass --allow-missing-digest only against a non-hosted server");
  }

  // ------------------------------- 2 + 3. physical identity and path invariant
  // The strong check: every reviewed skill must serve its exact reviewed
  // version_hash with a host-relative provenance path.
  const versionMismatch = [];
  const hostLeaks = [];
  const absLocal = [];
  const missing = [];

  for (const id of expectedIds) {
    const t = await client.raw("inspect", { skill_id: id });
    const servedHash = (t.match(/sha256:[0-9a-f]{64}/) ?? [])[0] ?? null;
    if (!servedHash) { missing.push(id); continue; }
    if (servedHash !== expectedVersions[id]) {
      versionMismatch.push(`${id} ${servedHash.slice(0, 14)} != ${expectedVersions[id].slice(0, 14)}`);
    }
    if (HOST_PATH.test(t)) hostLeaks.push(`${id} (inspect)`);
    const lp = (t.match(/source\s+\S+\s+(\S+)\s+observed_at=/) ?? [])[1] ?? null;
    if (lp && /^([A-Za-z]:[\\/]|\/|\\\\)/.test(lp)) absLocal.push(`${id} local_path=${lp}`);
  }

  check(`all ${expectedIds.length} reviewed skills are served`, missing.length === 0, missing.slice(0, 4).join(", "));
  check(
    `every served version_hash matches the reviewed value (${expectedIds.length}/${expectedIds.length})`,
    versionMismatch.length === 0,
    versionMismatch.slice(0, 3).join("; "),
  );
  check(
    `runtime path invariant: no build-host path in inspect (${expectedIds.length} skills)`,
    hostLeaks.length === 0,
    hostLeaks.slice(0, 3).join(", "),
  );
  check(
    `runtime path invariant: every sources[].local_path is host-relative (${expectedIds.length} skills)`,
    absLocal.length === 0,
    absLocal.slice(0, 3).join(", "),
  );

  // ------------------------------------------------------- 4. membership delta
  for (const id of EXPECTED.mustExist) {
    const t = await client.raw("inspect", { skill_id: id });
    const ok = !/E_SKILL_NOT_FOUND|not found/i.test(t) && expectedIds.includes(id);
    check(`must exist: ${id}`, ok, ok ? (t.split("\n")[0] ?? "").slice(0, 60) : "NOT SERVED");
  }
  for (const id of EXPECTED.mustNotExist) {
    const t = await client.raw("inspect", { skill_id: id });
    check(`must NOT exist: ${id}`, /E_SKILL_NOT_FOUND|not found/i.test(t), t.split("\n")[0]?.slice(0, 60) ?? "");
  }
  // The withdrawn skill must also not appear in ranked search results.
  const searchAll = await client.raw("search", { query: "merge conflict", limit: 20 });
  check("withdrawn skill absent from search", !searchAll.includes("mattpocock/resolving-merge-conflicts"));

  // ------------------------------------------- new-skill content really served
  const pr = await client.raw("get_content", {
    skill_id: "mattpocock/pr",
    version_hash: expectedVersions["mattpocock/pr"],
    level: "L2",
    max_tokens: 4000,
  });
  check("get_content serves mattpocock/pr at the reviewed version", pr.length > 400, `${pr.length} bytes`);
  check("pr body retains Summary / Evidence / Merge Danger", /##\s*Summary/i.test(pr) && /Merge Danger/i.test(pr));

  const retro = await client.raw("get_content", {
    skill_id: "mattpocock/retro",
    version_hash: expectedVersions["mattpocock/retro"],
    level: "L2",
    max_tokens: 8000,
  });
  check("retro body retains the Skill-tool invocation contract", /Skill tool/i.test(retro));

  const spec = await client.raw("get_content", {
    skill_id: "mattpocock/implement-spec",
    version_hash: expectedVersions["mattpocock/implement-spec"],
    level: "L2",
    max_tokens: 8000,
  });
  check("implement-spec body retains task-graph semantics", /task graph|task-graph/i.test(spec));

  // ------------------------------------------------- no stale CONTEXT.md refs
  let staleContext = [];
  for (const id of EXPECTED.mustExist.concat(["mattpocock/domain-modeling", "mattpocock/tdd", "mattpocock/triage"])) {
    const t = await client.raw("get_content", { skill_id: id, version_hash: expectedVersions[id], level: "L2", max_tokens: 30000 });
    if (/CONTEXT\.md|CONTEXT-MAP\.md/.test(t)) staleContext.push(id);
  }
  check(`GLOSSARY convention served, no stale CONTEXT.md (${staleContext.length} bad)`, staleContext.length === 0, staleContext.join(", "));

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log("");
  console.log(`checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}  skipped: ${skipped.length}`);
  if (failed.length === 0) {
    console.log("");
    console.log(`PRODUCT_READY  ${EXPECTED.catalog}`);
    console.log(`  release_digest ${EXPECTED.releaseDigest}`);
    console.log(`  rollback target ${EXPECTED.previousReleaseDigest}`);
    process.exit(0);
  }
  console.log("");
  console.log(`NOT ACCEPTED — ${failed.length} check(s) failed:`);
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  [${f.detail}]` : ""}`);
  console.log("");
  console.log(`rollback target: ${EXPECTED.previousReleaseDigest}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`acceptance error: ${err?.stack ?? err}`);
  process.exit(1);
});
