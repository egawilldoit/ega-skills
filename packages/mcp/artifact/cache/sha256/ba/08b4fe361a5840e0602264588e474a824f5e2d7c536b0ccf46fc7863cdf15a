---
name: create-verification-workflow
description: "Generate a project-local verification workflow that drives a real application and captures proof. Use when a repository has no scripted way to verify user-facing behavior, or for requests like 'set up verification for this app', 'make a control harness', or 'prove the app works end to end'. Covers web, CLI, API, mobile, desktop, and library surfaces. The generated workflow must define Launch, Doctor, Drive, Evidence, and Cleanup, and it must be run once before handover. Use verify-ui or verify-cli to verify a specific change now; use maintain-verification-workflow to keep an existing workflow honest."
---

# Create a verification workflow

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill, tailored to the repository. Write it for the next agent, not for a human. That agent reads it cold, mid-task, with no memory of the app.

Do not invent a harness before checking what the repository already has. The strongest generated workflow reuses an existing harness.

## 1. Inspect the repository first

Answer these from the codebase. Ask the user only what cannot be observed.

- Surface: what does a user actually touch? Web UI, CLI/TUI, desktop app, API, mobile app, or library. A repository can have several. Pick the primary one and note the rest.
- Run: how does the app start locally? Prefer the documented dev command (package scripts, Makefile, README quickstart). Note ports, environment variables, seed data, and auth.
- Drive: how can an agent interact with it programmatically? Existing harnesses first: Playwright or Cypress specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then choose a generic recipe: browser or CDP for web and Electron, a tmux or PTY harness for CLI/TUI, plain HTTP for services.
- Observe: what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, database state.
- Isolate: can two instances run side by side (ports, data directories, profiles)? If not, say so in the generated workflow. Refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout does not build or start as-is, fix that first or report it precisely. A workflow written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static directory the API never serves, a sample config), the generated workflow may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## 2. Generate the workflow skill

Write a project-local skill with YAML frontmatter (`name` and a `description` that names the app, the surface, and when to reach for it). Without frontmatter the skill never registers. Ground every section in what the inspection actually found. Leave no placeholders. Required sections:

- **Launch:** the exact command that starts the app for verification, and how to tell it is ready (a log line, a port answering, a prompt). Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary or install dependencies once, then start each drive in its own isolated PTY or tmux session.
- **Doctor:** one read-only check that answers "is this instance worth driving?". Process up, right version or build, port owned by us, auth valid. An agent runs this first whenever anything looks off.
- **Drive:** the harness recipe with real selectors and commands from this repository, not generic examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence:** what to capture for a proof and where it goes. State the proof standard: exercise the real user path, not internal setters or test-only endpoints. Capture the action and the resulting state, not just the final screen. Verify side effects (files written, rows inserted, messages sent) alongside what is visible. Mock only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it actually skips by observing files, network, or refs rather than trusting its name; some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down instances the run created. Never kill by process name; kill what you started. Cleanup removes instances and scratch state, never the evidence. Proof artifacts survive teardown, in a location the skill names.
- **Helpers:** any script the workflow ships is executable and its invocation appears in the workflow body. A helper the reader must reverse-engineer is not a helper.

## 3. Seed the feature map

Create a `features/` directory with a README index plus one file per user-facing feature. Aim for the top three to five to start, drawn from routes, commands, menus, or docs. Follow the contract in `references/feature-map-guide.md`. The map is the repository's maintained verification source. A proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated workflow before handover

Run its own instructions end to end once: launch, doctor, drive one mapped feature, capture evidence, clean up. One feature is enough; the map exists so later runs cover the rest. After cleanup, confirm the evidence still exists at the named location. A cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts do not strand processes and ports. A generated workflow that was never executed is a draft, not a deliverable.

## 5. Offer the maintenance loop

Point the user at `maintain-verification-workflow` for keeping the map honest as the app changes. Suggest a cadence only if they ask.

## Hard rules

- Inspect before asking. Ask only about facts the repository cannot reveal.
- Prefer an existing harness over a new one.
- The generated workflow is self-contained and written for a cold reader.
- Prove the generated workflow at least once. Never hand over an unrun draft.
- Cleanup must not delete evidence.

## Output

Report the surface chosen, the harness reused or created, the path of the generated workflow, the one feature driven during the proof run, the evidence location, and the result as one of `PROVEN`, `PARTIAL`, or `BLOCKED`. Name the evidence level from `references/operating-contract.md` that the proof reached.

Detailed feature-file format and a worked example: `references/feature-map-guide.md`.
