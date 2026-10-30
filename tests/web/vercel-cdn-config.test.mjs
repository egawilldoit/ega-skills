import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../apps/web/vercel.json", import.meta.url)), "utf8"),
);

test("Vite fingerprinted assets are explicitly included as Vercel static output", () => {
  assert.ok(
    config.builds.some((build) => build.src === "dist/assets/**" && build.use === "@vercel/static"),
    "custom builds must explicitly publish generated static output",
  );
  const node = config.builds.find((build) => build.src === "server.mts");
  assert.equal(node?.use, "@vercel/node");
  assert.ok(node.config.includeFiles.includes("artifact/**/*"));
  assert.ok(node.config.includeFiles.includes("dist/**/*"), "SPA fallback stays available");
});

test("hashed assets use CDN before the server fallback; no API or readiness route is rewritten", () => {
  assert.deepEqual(config.routes[0], {
    src: "/assets/(.*)",
    methods: ["GET", "HEAD"],
    dest: "/dist/assets/$1",
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
  assert.deepEqual(config.routes[1], { src: "/(.*)", dest: "server.mts" });
  assert.equal(config.routes.length, 2);
});

test("existing secure response headers remain on the CDN-served assets", () => {
  const entries = config.headers.find((entry) => entry.source === "/(.*)")?.headers;
  assert.ok(entries);
  for (const key of ["X-Content-Type-Options", "X-Frame-Options", "Content-Security-Policy"]) {
    assert.ok(entries.some((entry) => entry.key === key), `missing ${key}`);
  }
});
