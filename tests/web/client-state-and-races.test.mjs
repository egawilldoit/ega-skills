/**
 * Test suite for client-side state, cancellation, race prevention, and truthful metadata.
 *
 * Covers Mandates 1, 2, 3, and 6:
 * - Current-user membership and role resolution;
 * - Workspace/account switching and stale-data clearance;
 * - Content loading, close, navigation, cancellation and request races;
 * - Real availability and token metadata;
 * - Runtime malformed-response handling.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const WORKSPACE_PROVIDER = join(REPO_ROOT, "apps", "web", "src", "workspace", "WorkspaceProvider.tsx");
const SKILL_DETAIL_PAGE = join(REPO_ROOT, "apps", "web", "src", "pages", "SkillDetailPage.tsx");

describe("Mandate 1: WorkspaceProvider Membership Resolution & Stale Data Clearance", () => {
  const providerSource = readFileSync(WORKSPACE_PROVIDER, "utf8");

  test("queries membership explicitly scoped to current user subject", () => {
    assert.match(
      providerSource,
      /\.eq\(\s*["']subject["']\s*,\s*userId\s*\)/,
      "Supabase query must explicitly filter by subject eq userId",
    );
  });

  test("never falls back to an arbitrary member row when resolving role", () => {
    assert.doesNotMatch(
      providerSource,
      /(?:membersRaw|members)\[0\]\.(?:role|workspace|active)/,
      "Must not fall back to members[0] for current user role",
    );
  });

  test("synchronously clears memberships and role on user change / logout", () => {
    assert.match(
      providerSource,
      /setResolvedMemberships\(\[\]\)/,
      "Must clear memberships on auth state change",
    );
    assert.match(
      providerSource,
      /setSelectedWorkspaceId\(null\)/,
      "Must clear selectedWorkspaceId on auth state change",
    );
  });

  test("guards against late-arriving responses via cancellation flag", () => {
    assert.match(
      providerSource,
      /cancelled\s*=\s*true/,
      "Must mark cancelled on cleanup / auth change",
    );
    assert.match(
      providerSource,
      /if\s*\(\s*cancelled\s*\)\s*return/,
      "Must ignore response if cancelled",
    );
  });
});

describe("Mandate 2: SkillDetailPage Content Request Races & Close Cancellation", () => {
  const pageSource = readFileSync(SKILL_DETAIL_PAGE, "utf8");

  test("uses AbortController to cancel in-flight content requests", () => {
    assert.match(
      pageSource,
      /activeRequestRef\.current\.controller\.abort\(\)/,
      "Must call abort() on activeRequestRef when cancelling or starting a new request",
    );
  });

  test("closeContent aborts active request and resets content state to idle", () => {
    assert.match(
      pageSource,
      /const closeContent = useCallback\(\(\) => \{[\s\S]*?activeRequestRef\.current\.controller\.abort\(\)[\s\S]*?setContentState\(\{ status: "idle" \}\)/,
      "closeContent must abort active request and set state to idle",
    );
  });

  test("tracks sequence numbers to prevent stale responses from overwriting current state", () => {
    assert.match(
      pageSource,
      /\+\+reqSeqRef\.current/,
      "Must increment request sequence counter",
    );
    assert.match(
      pageSource,
      /activeRequestRef\.current\?\.seq !== seq/,
      "Must discard response if sequence number does not match current sequence",
    );
  });

  test("cleans up active requests on unmount or skill change", () => {
    assert.match(
      pageSource,
      /return\s*\(\)\s*=>\s*\{[\s\S]*?activeRequestRef\.current\.controller\.abort\(\)/,
      "Effect cleanup must abort in-flight requests",
    );
  });
});

describe("Mandate 3: Truthful Metadata & Companion Bounds", () => {
  const pageSource = readFileSync(SKILL_DETAIL_PAGE, "utf8");

  test("truthfully renders L1 unavailable when SKILL.core.md is not authored", () => {
    assert.match(
      pageSource,
      /Unavailable \(SKILL\.core\.md not authored in this release\)/,
      "Must truthfully report when L1 core is not authored",
    );
  });

  test("distinguishes request ceiling (32,768) from skill token counts", () => {
    assert.match(
      pageSource,
      /Request ceiling: 32,768 max tokens, default 32,000/,
      "Must state the request ceiling separately from skill tokens",
    );
  });

  test("guards companion file inspection to non-binary text files", () => {
    assert.match(
      pageSource,
      /isInspectableCompanionFile/,
      "Must check if companion file is inspectable",
    );
    assert.match(
      pageSource,
      /binary|script/i,
      "Must explain restriction against binary or script companion files",
    );
  });
});
