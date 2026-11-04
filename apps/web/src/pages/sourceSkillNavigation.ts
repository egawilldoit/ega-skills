/**
 * Exact source-skill navigation.
 *
 * The released catalog and the editable source catalog are different
 * identities. A source editor must only open when the canonical skill id maps
 * to exactly one item in the pinned source index. This module is intentionally
 * free of React and server imports so the same rule is testable in Node and
 * usable in the browser.
 */

export interface SourceIndexItem {
  readonly name: string;
  readonly description: string;
  readonly provenance: 'copied' | 'adapted' | 'original';
}

export interface SourceIndex {
  readonly sha: string;
  readonly total: number;
  readonly items: readonly SourceIndexItem[];
}

export type SourceSkillResolution =
  | { readonly status: 'match'; readonly name: string; readonly item: SourceIndexItem }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'missing'; readonly reason: string }
  | { readonly status: 'stale'; readonly reason: string };

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_NAMESPACE = 'egawilldoit';

export interface ResolveSourceSkillOptions {
  /**
   * The name the released detail declares. When supplied it must match the
   * name inside the canonical skill id; a mismatch means the identity is
   * renamed or inconsistent and no source may be opened.
   */
  readonly declaredName?: string;
  /**
   * The source revision the caller observed. When supplied it must equal the
   * pinned index revision. This keeps detail-page navigation from editing a
   * newer or older source tree.
   */
  readonly expectedSha?: string | null;
}

/**
 * Build the existing source-manager URL for one canonical skill.
 *
 * The sha travels with the skill id so the source page can reject a source
 * index that changed between the detail read and the edit request.
 */
export function sourceSkillHref(skillId: string, sourceSha: string): string {
  return `/source-skills?skill=${encodeURIComponent(skillId)}&sha=${encodeURIComponent(sourceSha)}`;
}

/**
 * Resolve one canonical released skill against the pinned source index.
 *
 * Only an exact namespace, exact name and exact revision produce `match`.
 * Every other outcome is explicit and carries a safe explanation; this function
 * never falls back to a prefix, case-insensitive or nearest-name match.
 */
export function resolveSourceSkill(
  skillId: string,
  index: SourceIndex,
  options: ResolveSourceSkillOptions = {},
): SourceSkillResolution {
  const parts = skillId.split('/');
  if (parts.length !== 2) {
    return {
      status: 'unsupported',
      reason: `Source editing needs one canonical <namespace>/<name> skill id; ${JSON.stringify(skillId)} is not that shape.`,
    };
  }
  const [namespace, name] = parts as [string, string];
  if (namespace !== SOURCE_NAMESPACE) {
    return {
      status: 'unsupported',
      reason: `Source editing supports ${SOURCE_NAMESPACE} skills only; ${JSON.stringify(skillId)} is outside that namespace.`,
    };
  }
  if (!SOURCE_NAME.test(name) || name.length > 64) {
    return {
      status: 'unsupported',
      reason: `Source editing does not support the skill name in ${JSON.stringify(skillId)}.`,
    };
  }
  if (options.declaredName !== undefined && options.declaredName !== name) {
    return {
      status: 'unsupported',
      reason: `The released skill declares ${JSON.stringify(options.declaredName)} but its id names ${JSON.stringify(name)}; the identity is inconsistent, so no source is opened.`,
    };
  }
  if (options.expectedSha !== undefined && options.expectedSha !== null) {
    if (!SOURCE_SHA.test(options.expectedSha)) {
      return {
        status: 'stale',
        reason: 'The source revision in this link is invalid. Return to the skill and open Manage source again.',
      };
    }
    if (index.sha !== options.expectedSha) {
      return {
        status: 'stale',
        reason: 'Source main changed since this skill was opened. Refresh source and compare again.',
      };
    }
  }
  const item = index.items.find(candidate => candidate.name === name);
  if (!item) {
    return {
      status: 'missing',
      reason: `No exact source skill named ${JSON.stringify(name)} exists in the pinned source index.`,
    };
  }
  return { status: 'match', name, item };
}
