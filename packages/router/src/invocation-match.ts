// Contract I1 §3: deterministic whole-task matching. This module does not
// validate or authorize a policy; callers must first verify its release binding.
export type InvocationAtom = { readonly literal: string } | { readonly pr_number: true };
export interface InvocationRule {
  readonly id: string;
  readonly alternatives: readonly (readonly InvocationAtom[])[];
}

/** Return the first matching rule ID, or null when the entire task is unconfirmed. */
export function matchInvocationIntent(task: string, rules: readonly InvocationRule[]): string | null {
  // Only ASCII whitespace and ASCII uppercase are normalized by I1.
  const trimmed = task.replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, "");
  if (trimmed.length === 0) return null;
  const tokens = trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase()).split(/[\x09-\x0d\x20]+/);
  const last = tokens.length - 1;
  tokens[last] = (tokens[last] ?? "").replace(/[.!?]$/, "");
  let first: string | null = null;
  for (const rule of rules) {
    const matched = rule.alternatives.some((atoms) => atoms.length === tokens.length && atoms.every((atom, index) => {
      const token = tokens[index] ?? "";
      return "literal" in atom ? token === atom.literal : /^#[0-9]{1,9}$/.test(token);
    }));
    if (matched && (first === null || rule.id < first)) first = rule.id;
  }
  return first;
}
