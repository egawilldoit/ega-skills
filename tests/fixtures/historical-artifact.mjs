/**
 * Historical artifact fixture for legacy contract tests.
 *
 * The reset makes the ACTIVE artifact empty. Several pre-existing test suites
 * assert contracts that need a populated release (real skill ids, aliases,
 * content blobs, routing values). They must keep that coverage without
 * reintroducing retired skills into the active catalog.
 *
 * This helper extracts the exact immutable base artifact from Git history into
 * a private temp directory. Nothing is written to the active artifact, no
 * fixture is fabricated, and the bytes are the reviewed release at BASE_SHA.
 * CI checks out with fetch-depth: 0, so the commit is available there too.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HISTORICAL_BASE = "f76f3a674069fde70e082ff73130b71d33a63c0d";

let cached = null;

/** Absolute path to an extracted copy of `packages/mcp/artifact` at BASE_SHA. */
export function historicalArtifact() {
  if (cached !== null) return cached;
  const root = mkdtempSync(join(tmpdir(), "ega-historical-artifact-"));
  execFileSync(
    "bash",
    ["-c", `git archive ${HISTORICAL_BASE} packages/mcp/artifact | tar -x -C "${root}"`],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
  );
  cached = join(root, "packages", "mcp", "artifact");
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return cached;
}

/** Historical presentation.yaml at BASE_SHA (legacy presentation groups). */
export function historicalPresentation() {
  const root = join(tmpdir(), `ega-historical-presentation-${HISTORICAL_BASE}`);
  const path = join(root, "catalog", "presentation.yaml");
  try {
    execFileSync("mkdir", ["-p", root], { stdio: "ignore" });
    execFileSync("bash", ["-c", `git archive ${HISTORICAL_BASE} catalog/presentation.yaml | tar -x -C "${root}"`], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Already extracted or a parallel process created it; the file is immutable.
  }
  return path;
}

/** Historical generated catalog markdown at BASE_SHA. */
export function historicalGeneratedCatalog() {
  const root = join(tmpdir(), `ega-historical-catalog-${HISTORICAL_BASE}`);
  const path = join(root, "docs", "generated", "SKILL-CATALOG.md");
  try {
    execFileSync("mkdir", ["-p", root], { stdio: "ignore" });
    execFileSync("bash", ["-c", `git archive ${HISTORICAL_BASE} docs/generated/SKILL-CATALOG.md | tar -x -C "${root}"`], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Already extracted; the file is immutable.
  }
  return path;
}
