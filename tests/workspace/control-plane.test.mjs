import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryControlPlane } from "../../packages/control-plane/dist/index.js";

test("multi-user control plane authorizes by membership and deny precedence", () => {
  const plane = new InMemoryControlPlane();
  plane.setResource("hub-a", { workspaceId: "ws-a", visibility: "private", ownerSubject: "user-a" });
  plane.addMembership("ws-a", { subject: "user-a", role: "owner", active: true });
  plane.addMembership("ws-a", { subject: "user-b", role: "viewer", active: true });
  assert.equal(plane.authorize("hub-a", "user-a", "publish_release"), true);
  assert.equal(plane.authorize("hub-a", "user-b", "publish_release"), false);
  assert.equal(plane.authorize("hub-a", "user-b", "read_hub"), false);
  plane.setResource("hub-a", { workspaceId: "ws-a", visibility: "workspace", ownerSubject: "user-a" });
  assert.equal(plane.authorize("hub-a", "user-b", "read_hub"), true);
  plane.deny("hub-a");
  assert.equal(plane.authorize("hub-a", "user-a", "read_hub"), false);
  plane.revokeMembership("ws-a", "user-b");
  assert.equal(plane.authorize("hub-a", "user-b", "read_hub"), false);
});

test("control plane preserves one active owner and requires explicit transfer", () => {
  const plane = new InMemoryControlPlane();
  plane.addMembership("ws", { subject: "owner-a", role: "owner", active: true });
  assert.throws(() => plane.addMembership("ws", { subject: "owner-b", role: "owner", active: true }), /exactly one owner/);
  assert.throws(() => plane.revokeMembership("ws", "owner-a"), /replacement owner/);
  assert.throws(() => plane.addMembership("ws", { subject: "owner-a", role: "admin", active: true }), /replacement-owner/);
});

test("public Hub reads follow public policy without workspace membership", () => {
  const plane = new InMemoryControlPlane();
  plane.setResource("hub-public", { workspaceId: "ws-a", visibility: "public", ownerSubject: "user-a" });
  assert.equal(plane.authorize("hub-public", "authenticated-outsider", "read_hub"), true);
  plane.deny("hub-public");
  assert.equal(plane.authorize("hub-public", "authenticated-outsider", "read_hub"), false);
});

test("project contexts are immutable identities with membership and revocation checks", () => {
  const plane = new InMemoryControlPlane();
  plane.addMembership("workspace-a", { subject: "user-a", role: "owner", active: true });
  plane.addMembership("workspace-a", { subject: "user-b", role: "viewer", active: true });
  plane.publishContext({
    contextId: "context-a",
    workspaceId: "workspace-a",
    projectId: "project-a",
    releaseDigest: "sha256:release",
    ownerSubject: "user-a",
  });
  assert.equal(plane.resolveContext("context-a", "user-a")?.projectId, "project-a");
  assert.equal(plane.resolveContext("context-a", "user-b")?.projectId, "project-a");
  plane.revokeMembership("workspace-a", "user-b");
  assert.equal(plane.resolveContext("context-a", "user-b"), null);
  plane.revokeContext("context-a");
  assert.equal(plane.resolveContext("context-a", "user-a"), null);
  assert.throws(() => plane.publishContext({
    contextId: "context-a",
    workspaceId: "workspace-a",
    projectId: "project-b",
    releaseDigest: "sha256:release",
    ownerSubject: "user-a",
  }));
});

test("control-plane audit, quota and source credentials keep security metadata bounded", () => {
  const plane = new InMemoryControlPlane();
  plane.recordAudit({ actor: "user-a", workspaceId: "workspace-a", operation: "publish_context", targetId: "context-a", result: "allowed" });
  assert.equal(plane.listAuditEvents().length, 1);
  assert.equal(plane.listAuditEvents()[0].oldIdentity, null);
  assert.equal(plane.listAuditEvents()[0].requestId, "local");
  plane.setQuota("workspace-a:requests", 2);
  assert.equal(plane.consumeQuota("workspace-a:requests"), true);
  assert.equal(plane.consumeQuota("workspace-a:requests", 1), true);
  assert.equal(plane.consumeQuota("workspace-a:requests"), false);
  plane.registerSourceCredential({ sourceId: "matt", secretReference: "vault://ega/matt" });
  assert.equal(plane.sourceCredential("matt")?.secretReference, "vault://ega/matt");
  assert.throws(() => plane.registerSourceCredential({ sourceId: "bad", secretReference: "token-value" }));
});
