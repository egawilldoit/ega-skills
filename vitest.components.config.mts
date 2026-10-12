import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * React lives in the `apps/web` workspace member, not at the repository root,
 * so a test file living under `tests/` cannot resolve it by plain name. These
 * aliases point at the member's own copies rather than installing a second
 * React: two copies in one process break `act` and hooks entirely.
 */
const web = (path: string) => fileURLToPath(new URL(`./apps/web/node_modules/${path}`, import.meta.url));

/**
 * Alias to the package DIRECTORY, not to a resolved file inside it. Pointing at
 * `react/index.js` bypasses the package's own export map and yields the CommonJS
 * entry, whose named exports are not statically analysable — `StrictMode` then
 * arrives as `undefined` at runtime while typechecking passes. Letting Vite
 * resolve the directory honours `"exports"` and keeps one React instance shared
 * with `react-dom`, which is what makes `act` and hooks work.
 */

/**
 * Vitest configuration for EXECUTED component tests.
 *
 * Scoped to `tests/web/tsx` and deliberately separate from `pnpm test:ci`, which
 * is the Node test runner used for every other suite. Two reasons:
 *
 *  - React components are `.tsx`, which Node's type stripping does not transform,
 *    so these tests cannot run under `node --test` at all.
 *  - Keeping them separate makes the evidence honest. `pnpm test:ci` counts stay
 *    unchanged, so "N tests pass" in CI means what it meant before, and the
 *    component suite is reported as its own gate rather than silently folded in.
 *
 * The environment is `node`, not `jsdom`: each test builds its own DOM from
 * `jsdom` and installs the globals it needs, so a leak between component trees
 * cannot make one test's mount visible to the next.
 */
export default defineConfig({
  test: {
    include: ["tests/web/tsx/**/*.test.tsx"],
    environment: "node",
    globals: false,
  },
  // Vitest 5 transforms with oxc. `esbuild.jsx` is accepted but IGNORED when an
  // oxc block is also present, so the JSX mode is declared here instead — the
  // warning this replaces said exactly that.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: [
      // Bare specifiers resolve to the package directory so Vite honours the
      // package's own export map. Subpaths point at the concrete file, because
      // `react/jsx-dev-runtime` is an export-map subpath with no directory of
      // that name to resolve against.
      { find: /^react$/, replacement: web("react") },
      { find: /^react-dom$/, replacement: web("react-dom") },
      { find: /^react\/jsx-runtime$/, replacement: web("react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: web("react/jsx-dev-runtime.js") },
      { find: /^react-dom\/client$/, replacement: web("react-dom/client.js") },
      { find: /^react-dom\/server$/, replacement: web("react-dom/server.node.js") },
    ],
  },
});