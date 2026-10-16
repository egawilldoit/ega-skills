---
name: verify-cli
description: "Verify CLI or TUI behavior with real command execution and terminal evidence. Use for CLI UX checks, prompt and keyboard flows, interrupts, resize behavior, startup regressions, hangs, memory growth, or recording a terminal demo. Prefer the repository's existing test or CLI harness; otherwise use a PTY, tmux, or expect harness. Capture stdout, stderr, exit codes, terminal transcripts, and timing where relevant. Use verify-ui for browser behavior; use verify-this to prove one falsifiable claim; use run-smoke-tests to run an existing suite."
---

# Verify CLI

Exercise an interactive CLI or TUI through a repeatable harness instead of poking at it by hand. A terminal program's behavior depends on TTY detection, buffering, signals, and terminal size. Piping output is not the same as running it in a terminal.

## When to use

- Reproducing a CLI or TUI bug with deterministic input.
- Verifying keyboard flows, prompts, interrupts, resize behavior, and terminal layout.
- Capturing before and after transcripts for a bug fix.
- Profiling startup time, slow operations, hangs, or memory growth.
- Recording a short terminal demo when output is easier to show than explain.

Do not use this for browser behavior; use `verify-ui`. Do not use it for a single non-terminal claim; use `verify-this`.

## 1. Reuse before you build

Identify the command under test and the smallest reproducible workspace. Then discover what already exists:

- Package scripts and e2e tests.
- Demo recorders.
- Expect scripts.
- PTY helpers.

Prefer the repository's harness because it already knows the app's startup, environment, and prompts.

## 2. Choose a harness

- Repo-native harness: prefer checked-in scripts.
- `tmux`: managed sessions with `capture-pane` and `send-keys`.
- PTY probe: a short Python, Node, or Expect script when tmux is unavailable.
- Runtime inspector: a Node or Bun inspector for CPU profiles, heap snapshots, and live evaluation.
- Terminal recorder: a repository-local demo tool or an asciinema-compatible tool when the user asks for a demo.

Concrete tmux, PTY, and profiling recipes live in `references/harness-recipes.md`. Keep a temporary harness in a scratch directory unless the repository already has a testing or demo harness.

## 3. Harness loop

1. Identify the command under test and the smallest reproducible workspace.
2. Launch it in an isolated terminal session with deterministic environment variables.
3. Capture the current screen before interacting.
4. Send one action at a time: text, Enter, arrows, Escape, Ctrl-C, or a resize.
5. Wait for a concrete screen pattern or prompt before the next action.
6. Save the transcript and any profile artifacts.
7. Kill the session cleanly.

Prefer deterministic waits over sleeps. If you must sleep, say why. Send one action at a time and confirm the resulting screen; blind key sequences produce evidence that cannot be trusted.

## 4. Evidence

Capture what proves the claim:

- The exact command and arguments.
- stdout and stderr, kept separate when the distinction matters.
- The exit code.
- A terminal transcript or screen capture for interactive flows.
- Timing, for startup or latency claims.
- Profile artifacts, for CPU, memory, or hang claims.

State the evidence level the run reached using `references/operating-contract.md`: `E2` for a command that ran locally, `E5` for behavior observed in a running environment, `E6` when observed through the intended terminal or hardware.

## Profiling recipes

- Startup regression: capture baseline and treatment startup timings under the same machine, environment, and command.
- Slow operation: start a CPU profile, perform the operation, stop the profile, compare top self-time functions.
- Memory leak: force GC if available, take a heap snapshot, perform the operation repeatedly, force GC again, take another snapshot.
- Hang: capture the screen, active handles and resources, and a stack or CPU sample before interrupting.

## Guardrails

- Do not send credentials or destructive commands into a controlled session.
- Keep test data local and disposable.
- Do not hard-code paths from another repository. Adapt commands to this repository's scripts and runtime.
- Clean up tmux sessions, temporary directories, inspector processes, and demo artifacts unless the user asks to keep them. Cleanup never deletes evidence.

## Output

Report the command under test, the harness used, each action and its observed screen or output, the exit code, the evidence artifacts and their locations, and one verdict: `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`. Name the evidence level reached.
