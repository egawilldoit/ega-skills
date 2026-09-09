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
  assert.equal(plane.authorize("hub-a", "user-b", "read_hub"), true);
  plane.deny("hub-a");
  assert.equal(plane.authorize("hub-a", "user-a", "read_hub"), false);
  plane.revokeMembership("ws-a", "user-b");
  assert.equal(plane.authorize("hub-a", "user-b", "read_hub"), false);
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
