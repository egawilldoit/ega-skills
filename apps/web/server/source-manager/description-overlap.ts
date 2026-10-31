const COMMON = new Set(['about', 'after', 'before', 'from', 'have', 'into', 'more', 'only', 'other', 'that', 'their', 'them', 'these', 'this', 'those', 'through', 'using', 'when', 'where', 'which', 'with', 'your']);

/** Report shared words as a review hint, not as a semantic classification. */
export function descriptionOverlap(left: string, right: string): string[] {
  const words = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(word => !COMMON.has(word)));
  const a = words(left), b = words(right);
  const shared = [...a].filter(word => b.has(word)).sort();
  return shared.length >= 3 && shared.length * 2 >= Math.min(a.size, b.size) ? shared.slice(0, 8) : [];
}
