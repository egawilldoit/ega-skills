---
name: verify-ui
description: "Verify web, IDE, desktop, or Electron UI behavior with real browser evidence. Use for UI verification, screenshots, accessibility snapshots, console or network logs, browser traces, performance profiles, visual diffs, or reproducing a UI bug that depends on real focus, input, scrolling, or rendering. Prefer the repository's existing Playwright, Cypress, browser, or Electron harness before creating a temporary one. Use verify-this to prove one falsifiable claim; use verify-cli for terminal behavior; use run-smoke-tests to run an existing end-to-end suite."
---

# Verify UI

Drive the real UI and verify behavior with evidence. Never report UI behavior from reading source alone. A selector that exists in code may not render, and a component that renders may not respond to real input.

## When to use

- Reproducing a UI bug that depends on real browser focus, keyboard input, scrolling, resizing, or rendering.
- Verifying a visual, layout, or accessibility change with screenshots and snapshots.
- Checking local web, IDE, or Electron behavior before shipping.
- Capturing console logs, network logs, CPU profiles, traces, or heap snapshots.
- Producing before and after evidence for a claim.

Do not use this for a claim about non-visual logic; use `verify-this`. Do not use it for terminal behavior; use `verify-cli`.

## 1. Reuse before you build

Start the app locally using the repository's documented dev command. Then discover what already exists before writing any harness:

- Playwright or Cypress specs and their fixtures.
- Storybook or component harnesses.
- Browser scripts or debug launch scripts.
- Electron launch scripts or a configured remote debugging port.
- Snapshot or visual-regression tooling.

Prefer the repository's harness because it already knows the startup, environment, and selectors. Build a temporary harness only when none exists. Do not add Playwright or another browser tool as a project dependency just for a probe unless the user asks. Prefer existing dev dependencies or browser tooling already in the environment.

## 2. Connect and select the surface

- For a web app, connect to the local URL with the existing browser tooling.
- For Electron or Chromium, enable a remote debugging port when supported and connect over CDP.
- Select the correct page by a stable app marker, not by tab order alone.
- Prefer accessibility roles, labels, and stable `data-*` selectors over coordinates.

Recipes for a generic web harness, a CDP harness, page selection, and the CDP capability surface live in `references/recipes.md`.

## 3. Interaction loop

1. Capture a snapshot or screenshot before acting.
2. Choose a target from the latest page structure.
3. Perform exactly one structural action: click, type, keypress, drag, scroll, navigate, or resize.
4. Capture a fresh snapshot or screenshot.
5. Verify the expected state change.
6. Save artifacts for before and after comparison when proof was requested.

One action at a time. A stale element reference after navigation or a structural change is a bug in the harness, not the app.

## 4. Evidence

Capture what proves the claim, and name where it goes. Evidence may include:

- Screenshots, full page and viewport, with the app identity visible.
- Console logs and uncaught exceptions.
- Network request and response logs.
- Accessibility snapshots.
- Browser traces and performance profiles.
- Visual comparison against a baseline.

State the evidence level the run reached using `references/operating-contract.md`: `E2` for a script that ran locally without observing rendered output, `E5` for behavior observed in a running environment, `E6` when observed through the intended client or device.

## Guardrails

- Do not rely on stale element references after navigation or structural changes.
- Avoid coordinate clicks unless a fresh screenshot was captured immediately before the click.
- Keep test data local and disposable.
- Do not store screenshots, traces, or heap snapshots from privacy-sensitive workspaces unless the user explicitly agrees.
- Do not hard-code selectors, ports, or script paths from another repository. Discover this repository's markers.
- Clean up dev servers, debug sessions, and temporary profiles when done. Cleanup never deletes evidence.

## Output

Report the surface and URL or target, the harness used, each action and its observed result, the evidence artifacts and their locations, and one verdict: `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`. Name the evidence level reached. Do not soften a negative result.
