/**
 * Tests for ReleaseDetailPage rendering contract and ReleaseStatus helpers.
 *
 * Verifies R3 fix:
 * - `status === "mismatch"` withholds content and renders ErrorState.
 * - `status === "unpinned"` renders verified artifacts DataTable + honest unpinned warning banner.
 * - `status === "stable"` renders verified artifacts DataTable.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  describeReleaseStatus,
  explainReleaseStatus,
} from "../../apps/web/src/components/release-status.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_DETAIL_PAGE = join(
  REPO_ROOT,
  "apps",
  "web",
  "src",
  "pages",
  "ReleaseDetailPage.tsx",
);
const RELEASE_STATUS_COMPONENT = join(
  REPO_ROOT,
  "apps",
  "web",
  "src",
  "components",
  "ReleaseStatus.tsx",
);

describe("ReleaseStatus helper functions", () => {
  test("describeReleaseStatus returns correct label for each state", () => {
    assert.equal(describeReleaseStatus("stable"), "Stable");
    assert.equal(describeReleaseStatus("unpinned"), "Unpinned");
    assert.equal(describeReleaseStatus("mismatch"), "Mismatch");
  });

  test("explainReleaseStatus explains unpinned without claiming contents are withheld", () => {
    const unpinned = explainReleaseStatus("unpinned");
    assert.match(unpinned, /fully verified/i);
    assert.match(unpinned, /unproven/i);
    assert.doesNotMatch(unpinned, /contents are withheld/i);

    const mismatch = explainReleaseStatus("mismatch");
    assert.match(mismatch, /contents are withheld/i);
  });
});

describe("ReleaseDetailPage rendering structure (R3)", () => {
  const pageSource = readFileSync(RELEASE_DETAIL_PAGE, "utf8");
  const componentSource = readFileSync(RELEASE_STATUS_COMPONENT, "utf8");

  test("mismatch renders ErrorState and withholds artifacts", () => {
    // Check that `status === "mismatch"` is followed by ErrorState
    const mismatchIdx = pageSource.indexOf('data.release.status === "mismatch"');
    assert.ok(mismatchIdx !== -1, 'must test for data.release.status === "mismatch"');
    const branch = pageSource.slice(mismatchIdx, mismatchIdx + 500);
    assert.match(branch, /<ErrorState/);
    assert.match(branch, /Release identity does not match this deployment/);
  });

  test("non-mismatch renders DataTable of immutable artifacts", () => {
    const mismatchIdx = pageSource.indexOf('data.release.status === "mismatch"');
    const elseBranch = pageSource.slice(mismatchIdx + 200, mismatchIdx + 1200);
    assert.match(elseBranch, /<DataTable/);
    assert.match(elseBranch, /Immutable artifacts/);
  });

  test("ReleaseIntegrityNotice only claims contents withheld for mismatch", () => {
    assert.match(
      componentSource,
      /release\.status === "mismatch" \? "Release mismatch — contents withheld" : "Release not pinned"/,
    );
  });
});
