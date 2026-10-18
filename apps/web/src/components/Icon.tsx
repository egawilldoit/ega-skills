import type { ReactNode } from "react";

/**
 * The console's icon set: one 16px stroke sprite, inlined as path data.
 *
 * The CSP forbids remote assets (`img-src 'self' data:`) and there is no icon
 * dependency in this workspace, so the handful of glyphs the design uses are
 * declared here as path data rather than pulled from a package. Every icon is
 * decoration: it is `aria-hidden`, and the accessible name always comes from
 * the text beside it.
 */
const PATHS = {
  layers: "M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3",
  box: "M8 2l5 2.5v5L8 12 3 9.5v-5zM3 4.5L8 7l5-2.5M8 7v5",
  pulse: "M2 8h4l1.5-3 2 6L11 8h3",
  compare: "M5 3v10M11 3v10M2 6l3-3 3 3M8 10l3 3 3-3",
  folder: "M2 4.5h4l1 1.5h7v6.5H2z",
  grid: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
  users:
    "M6 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM2 13c0-2.2 1.8-4 4-4s4 1.8 4 4M11 3.5a2.5 2.5 0 010 5M14 13c0-1.8-1-3.2-2.5-3.8",
  quota: "M8 2a6 6 0 100 12A6 6 0 008 2zM8 8V2M8 8l4.2 4.2",
  shield: "M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z",
  usage: "M2 13V3M2 13h12M5 10V8M8 10V5M11 10V7",
  audit: "M4 2h6l3 3v9H4zM10 2v3h3M6 8h5M6 11h5",
  cog: "M8 5.8a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-2h-8v8h2",
  chevron: "M6 3l5 5-5 5",
  arrow: "M3 8h10M9 4l4 4-4 4",
  menu: "M2 4h12M2 8h12M2 12h12",
  lock: "M3 7h10v7H3zM5.5 7V5a2.5 2.5 0 015 0v2",
  warn: "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01",
  empty: "M2 9l2-6h8l2 6v4H2zM2 9h3.5l.5 1.5h4l.5-1.5H14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { readonly name: IconName }): ReactNode {
  return (
    <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
