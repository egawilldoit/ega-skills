/**
 * Tests for SkillDetailPage rendering contract and skill content decoder (R6).
 *
 * Verifies:
 * - On-demand L2 content viewer with explicit L1 availability/missing reason indicator.
 * - Safe text rendering without executing scripts or injecting raw HTML.
 * - Companion files list with content inspection trigger.
 * - Token budgets (L1 vs L2 token comparison).
 * - Structural validation of SkillContentView via decodeSkillContent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import { decodeSkillContent, findResponseDecoder, ResponseContractError } from "../../apps/web/src/api/decode.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_DETAIL_PAGE = join(
  REPO_ROOT,
  "apps",
  "web",
  "src",
  "pages",
  "SkillDetailPage.tsx",
);

describe("SkillDetailPage rendering structure (R6)", () => {
  const pageSource = readFileSync(SKILL_DETAIL_PAGE, "utf8");

  test("contains explicit L1 content status and token budget", () => {
    assert.match(pageSource, /L1 Content Status/);
    assert.match(pageSource, /SKILL\.core\.md was not authored in this release/);
    assert.match(pageSource, /L1 Token Budget/);
    assert.match(pageSource, /Unavailable \(SKILL\.core\.md not authored in this release\)/);
  });

  test("contains explicit L2 content status and token budget bounds", () => {
    assert.match(pageSource, /L2 Content Status/);
    assert.match(pageSource, /Available \(Servable on demand\)/);
    assert.match(pageSource, /L2 Token Budget/);
    assert.match(pageSource, /Request ceiling: 32,768 max tokens, default 32,000/);
  });

  test("provides on-demand content inspection controls for L2 and L1", () => {
    assert.match(pageSource, /Load L2 Skill Content/);
    assert.match(pageSource, /Request L1 Content/);
    assert.match(pageSource, /fetchContent\("L2"\)/);
    assert.match(pageSource, /fetchContent\("L1"\)/);
  });

  test("renders content safely as plain text without dangerous HTML injection", () => {
    assert.doesNotMatch(pageSource, /dangerouslySetInnerHTML/);
    assert.doesNotMatch(pageSource, /<script/i);
    assert.match(
      pageSource,
      /<pre className="content-viewer__code"><code>\{contentState\.data\.content\}<\/code><\/pre>/,
    );
  });

  test("wires companion file inspection from the files table", () => {
    assert.match(pageSource, /Inspection/);
    assert.match(pageSource, /fetchContent\("L2",\s*row\.path\)/);
    assert.match(pageSource, /View content/);
  });

  test("reports clear loading and refusal/error states", () => {
    assert.match(pageSource, /Loading \{contentState\.level\} content/);
    assert.match(pageSource, /Unable to serve \{contentState\.level\} content/);
    assert.match(pageSource, /\{contentState\.message\}/);
  });
});

describe("decodeSkillContent validator", () => {
  const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
  const VALID_CONTENT_PAYLOAD = {
    skill_id: "test/my-skill",
    version_hash: VALID_DIGEST,
    level: "L2",
    token_count: 512,
    content: "## My Skill\nSome markdown text",
    requested_max_tokens: 8192,
    truncated: false,
    file_path: "references/guide.md",
    release: {
      release_digest: VALID_DIGEST,
      hub_id: "hub-1",
      status: "stable",
      skill_count: 116,
      snapshot_rows: 116,
      sqlite_artifact_digest: VALID_DIGEST,
      mismatch_reason: null,
    },
  };

  test("accepts a well-formed SkillContentView payload", () => {
    const decoded = decodeSkillContent(VALID_CONTENT_PAYLOAD);
    assert.equal(decoded.skill_id, "test/my-skill");
    assert.equal(decoded.level, "L2");
    assert.equal(decoded.token_count, 512);
    assert.equal(decoded.content, "## My Skill\nSome markdown text");
    assert.equal(decoded.truncated, false);
    assert.equal(decoded.file_path, "references/guide.md");
  });

  test("rejects invalid levels", () => {
    assert.throws(
      () => decodeSkillContent({ ...VALID_CONTENT_PAYLOAD, level: "L3" }),
      ResponseContractError,
    );
  });

  test("rejects non-false truncated", () => {
    assert.throws(
      () => decodeSkillContent({ ...VALID_CONTENT_PAYLOAD, truncated: true }),
      ResponseContractError,
    );
  });

  test("findResponseDecoder routes /skills/:skillId/content to decodeSkillContent", () => {
    const decoder = findResponseDecoder("/skills/test%2Fmy-skill/content");
    assert.equal(decoder, decodeSkillContent);
  });
});
