/**
 * Historical artifact fixture for legacy contract tests.
 *
 * The reset makes the ACTIVE artifact empty. Several pre-existing test suites
 * assert contracts that need a populated release (real skill ids, aliases,
 * content blobs, routing values and presentation groups). They must keep that
 * coverage without reintroducing retired skills into the active catalog.
 *
 * This helper extracts the exact immutable base inputs from Git history into
 * a private temp directory: the artifact, its presentation.yaml and its
 * generated catalog markdown. Nothing is written to the active artifact, no
 * fixture is fabricated, and the bytes are the reviewed release at BASE_SHA.
 * CI jobs that run these tests check out with fetch-depth: 0.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HISTORICAL_BASE = "f76f3a674069fde70e082ff73130b71d33a63c0d";

let cachedRoot = null;
let cachedArtifact = null;

/** Absolute path to an extracted copy of `packages/mcp/artifact` at BASE_SHA. */
export function historicalArtifact() {
  if (cachedArtifact !== null) return cachedArtifact;
  const root = mkdtempSync(join(tmpdir(), "ega-historical-artifact-"));
  execFileSync(
    "bash",
    [
      "-c",
      `git archive ${HISTORICAL_BASE} packages/mcp/artifact catalog/presentation.yaml docs/generated/SKILL-CATALOG.md | tar -x -C "${root}"`,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
  );
  cachedRoot = root;
  cachedArtifact = join(root, "packages", "mcp", "artifact");
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return cachedArtifact;
}

/** Historical presentation.yaml at BASE_SHA, beside the fixture artifact. */
export function historicalPresentation() {
  historicalArtifact();
  return join(cachedRoot, "catalog", "presentation.yaml");
}

/** Historical generated catalog markdown at BASE_SHA. */
export function historicalGeneratedCatalog() {
  historicalArtifact();
  return join(cachedRoot, "docs", "generated", "SKILL-CATALOG.md");
}
