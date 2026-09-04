// SPEC-004 §5.1.11 deterministic task matching primitives (EGA-573).
//
// Task lexical terms use the SAME Unicode letter/number extraction +
// lowercase normalization as V1 search (SPEC-003 §5.1.5). Identifier phrases
// (DOMAIN, name/alias matching) normalize -/./_ to a single separator,
// collapse runs, and PRESERVE + and # (§5.1.11.2). Shared by explicit
// anti-trigger warnings (EGA-573), tiers (EGA-575) and redundancy (EGA-576).

const TASK_TERM_RE = /[\p{L}\p{N}]+/gu;

/** Normalized task term sequence for a raw task string. */
export function normalizeTaskTerms(task: string): string[] {
  return task.match(TASK_TERM_RE)?.map((term) => term.toLowerCase()) ?? [];
}

/**
 * Identifier-phrase normalization: lowercase; map -, _, . to a space
 * separator; collapse separator/whitespace runs; preserve + and #.
 */
export function normalizeIdentifierPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when pattern occurs contiguously inside sequence. Empty never matches. */
export function isContiguousSubsequence(
  sequence: readonly string[],
  pattern: readonly string[],
): boolean {
  if (pattern.length === 0 || pattern.length > sequence.length) return false;
  outer: for (let start = 0; start + pattern.length <= sequence.length; start += 1) {
    for (let i = 0; i < pattern.length; i += 1) {
      if (sequence[start + i] !== pattern[i]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Strong anti-trigger (§5.1.11.3): the anti-trigger's lexical term sequence
 * occurs contiguously in the normalized task terms.
 */
export function matchesStrongAntiTrigger(antiTrigger: string, taskTerms: readonly string[]): boolean {
  const pattern = antiTrigger.match(TASK_TERM_RE)?.map((term) => term.toLowerCase()) ?? [];
  return isContiguousSubsequence(taskTerms, pattern);
}

/**
 * Strong platform mismatch (§5.1.12.3): exists ONLY when ALL hold — the
 * project has explicit platform evidence, the skill declares at least one
 * platform, and the intersection is empty. Missing evidence is NEUTRAL,
 * never a mismatch. Shared by explicit warnings (EGA-573) and automatic hard
 * filters (EGA-574).
 */
export function hasStrongPlatformMismatch(
  projectPlatforms: readonly string[],
  skillPlatforms: readonly string[],
): boolean {
  if (projectPlatforms.length === 0 || skillPlatforms.length === 0) return false;
  return !skillPlatforms.some((platform) => projectPlatforms.includes(platform));
}
