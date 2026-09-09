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
