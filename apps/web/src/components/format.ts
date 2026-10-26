/**
 * Formatting shared by the design primitives.
 *
 * Pure and dependency-free: no Intl data beyond what the runtime ships, no
 * locale guessing beyond the console's single reviewed presentation locale
 * (en-US), and no value invented when the input is not a date.
 */

/**
 * Render an ISO timestamp the way the reviewed design does, in UTC.
 *
 * The original string is never lost: callers keep it on the `<time datetime>`
 * attribute, so the exact technical value stays available to assistive
 * technology, to copy/paste, and to a future reader of the DOM. An input that
 * is not a date is returned unchanged rather than shown as `Invalid Date`.
 */
export function formatTimestampUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `${formatted} UTC`;
}

/**
 * Split `algorithm:hex` into its algorithm prefix and 8-character groups.
 *
 * Used for the full-digest field, where grouping is what makes a 64-character
 * digest checkable by eye. The joined groups are the same bytes as the input,
 * so the copy affordance still yields the exact digest.
 */
export function splitDigest(digest: string): { readonly prefix: string; readonly groups: readonly string[] } {
  const separator = digest.indexOf(":");
  const prefix = separator >= 0 ? digest.slice(0, separator + 1) : "";
  const hex = separator >= 0 ? digest.slice(separator + 1) : digest;
  return { prefix, groups: hex.match(/.{1,8}/g) ?? [] };
}
