#!/usr/bin/env node
// Minimal Node adapter for the read-only hosted MCP handler. Authentication is
// intentionally supplied by an external verifier in production; this entry
// point only provides a disposable local smoke adapter.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { loadHostedReleaseSnapshot, createHostedMcpHandler, createJwksBearerVerifier } from "../dist/index.js";
import { InMemoryControlPlane } from "@ega-skills/control-plane";

const artifactDir = process.env.EGA_HOSTED_ARTIFACT_DIR;
const expectedToken = process.env.EGA_HOSTED_BEARER_TOKEN;
const issuer = process.env.EGA_HOSTED_ISSUER;
const audience = process.env.EGA_HOSTED_AUDIENCE;
const jwksUrl = process.env.EGA_HOSTED_JWKS_URL;
const authorizationPath = process.env.EGA_HOSTED_AUTHZ_FILE;
const allowedOrigins = process.env.EGA_HOSTED_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
if (!artifactDir || (!expectedToken && !(issuer && audience && jwksUrl))) {
  throw new Error("EGA_HOSTED_ARTIFACT_DIR and either EGA_HOSTED_BEARER_TOKEN or the hosted issuer/audience/JWKS configuration are required");
}
if (!authorizationPath) throw new Error("EGA_HOSTED_AUTHZ_FILE is required; hosted authorization must fail closed");
if (!allowedOrigins?.length) throw new Error("EGA_HOSTED_ALLOWED_ORIGINS is required; hosted Origin policy must fail closed");

let snapshot;
let startupError;
let controlPlane;
let deniedSkills = new Set();
let deniedSources = new Set();
let deniedReleases = new Set();
try {
  snapshot = loadHostedReleaseSnapshot(artifactDir);
  const policy = JSON.parse(readFileSync(authorizationPath, "utf8"));
  const policyKeys = Object.keys(policy ?? {}).sort();
  const allowedPolicyKeys = ["authorized_subjects", "denied_releases", "denied_skills", "denied_sources", "denies", "memberships", "owner_subject", "visibility", "workspace_id"].sort();
  if (policy === null || typeof policy !== "object" || Array.isArray(policy) ||
      policyKeys.some((key) => !allowedPolicyKeys.includes(key)) ||
      typeof policy.workspace_id !== "string" || typeof policy.visibility !== "string" ||
      !["private", "workspace", "public"].includes(policy.visibility) ||
      typeof policy.owner_subject !== "string" || !Array.isArray(policy.memberships) ||
      !Array.isArray(policy.denies) ||
      ["authorized_subjects", "denied_releases", "denied_skills", "denied_sources"].some((key) =>
        policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].some((value) => typeof value !== "string")))) {
    throw new Error("hosted authorization policy has invalid shape");
  }
  controlPlane = new InMemoryControlPlane();
  const hubId = snapshot.release.payload.hub_id;
  controlPlane.setResource(hubId, {
    workspaceId: policy.workspace_id,
    visibility: policy.visibility,
    ownerSubject: policy.owner_subject,
    authorizedSubjects: policy.authorized_subjects,
  });
  for (const membership of policy.memberships) {
    if (membership === null || typeof membership !== "object" ||
        typeof membership.subject !== "string" || !["owner", "admin", "maintainer", "member", "viewer"].includes(membership.role) ||
        typeof membership.active !== "boolean") throw new Error("hosted authorization membership has invalid shape");
    controlPlane.addMembership(policy.workspace_id, membership);
  }
  for (const denied of policy.denies) {
    if (typeof denied !== "string") throw new Error("hosted authorization deny has invalid shape");
    controlPlane.deny(denied);
  }
  deniedSkills = new Set(policy.denied_skills ?? []);
  deniedSources = new Set(policy.denied_sources ?? []);
  deniedReleases = new Set(policy.denied_releases ?? []);
} catch (error) {
  startupError = error;
}
const handler = snapshot && createHostedMcpHandler(snapshot, {
  allowedOrigins,
  verifyBearer: issuer && audience && jwksUrl
    ? createJwksBearerVerifier({
      issuer,
      audience,
      jwksUrl,
      requiredScope: process.env.EGA_HOSTED_REQUIRED_SCOPE ?? "ega:read",
      jwksMaxAgeMs: process.env.EGA_HOSTED_JWKS_MAX_AGE_MS ? Number(process.env.EGA_HOSTED_JWKS_MAX_AGE_MS) : undefined,
    })
    : async (token) => {
      if (token !== expectedToken) throw new Error("invalid token");
      return { subject: "local-smoke", scopes: ["ega:read"] };
    },
  authorize: async (principal) => {
    if (!controlPlane) return false;
    const hubId = snapshot.release.payload.hub_id;
    if (!controlPlane.authorize(hubId, principal.subject, "read_hub")) return false;
    return true;
  },
  deniedSkills,
  deniedSources,
  deniedReleases,
});

const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/healthz" || incoming.url === "/readyz") {
    const ready = !startupError && handler;
    const status = ready ? 200 : 503;
    outgoing.writeHead(status, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ status: ready ? "ready" : "unavailable" }));
    return;
  }
  if (!handler) {
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: { code: "E_RUNTIME_UNAVAILABLE" } }));
    return;
  }
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  const request = new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers,
    body: body.byteLength ? body : undefined,
    duplex: "half",
  });
  const response = await handler.fetch(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

const port = Number(process.env.PORT ?? 8787);
server.maxConnections = Number(process.env.EGA_HOSTED_MAX_CONNECTIONS ?? 128);
server.listen(port, "127.0.0.1", () => process.stderr.write(`ega-mcp-hosted listening on ${server.address().port}\n`));
