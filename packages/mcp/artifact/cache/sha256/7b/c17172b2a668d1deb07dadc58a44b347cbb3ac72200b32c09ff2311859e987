# CLI and TUI harness recipes

Concrete recipes for driving a terminal program when the repository has no harness of its own. Replace `COMMAND`, `ARG`, and `READY_TEXT` with values discovered from the current repository. Never copy paths or commands from another repository.

## Minimal tmux harness

`tmux` gives managed sessions, screen capture, and key injection without a custom script.

```bash
SESSION="cli-harness-$(date +%s)"
tmux new-session -d -s "$SESSION" -- COMMAND ARG
tmux capture-pane -pt "$SESSION"
tmux send-keys -t "$SESSION" "help" Enter
tmux capture-pane -pt "$SESSION"
tmux kill-session -t "$SESSION"
```

For a Node CLI that needs profiling, launch it with an inspector enabled:

```bash
NODE_OPTIONS="--inspect=127.0.0.1:0" tmux new-session -d -s "$SESSION" -- COMMAND
```

Read the terminal output to find the inspector URL, then use Chrome DevTools-compatible tooling if profiling is needed.

Always capture before and after each action, and always kill the session you started. Do not kill by process name; kill the specific session.

## Minimal PTY harness

Use a PTY script when you need deterministic waits and the repository has neither tmux nor a demo harness. Keep it temporary unless the user asks to add a reusable test.

```python
import os
import pty
import select
import subprocess
import time

master_fd, slave_fd = pty.openpty()
proc = subprocess.Popen(
    ["COMMAND", "ARG"],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=True,
)
os.close(slave_fd)

deadline = time.time() + 30
buffer = b""
while time.time() < deadline:
    ready, _, _ = select.select([master_fd], [], [], 0.25)
    if not ready:
        continue
    chunk = os.read(master_fd, 4096)
    buffer += chunk
    if b"READY_TEXT" in buffer:
        os.write(master_fd, b"help\n")
        break

print(buffer.decode(errors="replace"))
proc.terminate()
os.close(master_fd)
```

If the CLI needs richer terminal control, use `pty.fork()` or an existing PTY library.

## Terminal size and signals

- Set the terminal size explicitly before driving a TUI, so layout assertions are reproducible.
- Test interrupts (`Ctrl-C`) and quit paths explicitly; they are where cleanup bugs live.
- After an interrupt, confirm the process exited and no child processes were left behind.

## Profiling recipes

- Startup regression: capture baseline and treatment startup timings under the same machine, environment, and command. Record the command and the number of samples.
- Slow operation: start a CPU profile, perform the operation, stop the profile, and compare top self-time functions.
- Memory leak: force GC if available, take a heap snapshot, perform the operation repeatedly, force GC again, and take another snapshot.
- Hang: capture the screen, active handles and resources, and a stack or CPU sample before interrupting.

## Evidence layout

```text
artifacts/
├── command.txt        the exact command and arguments
├── stdout.txt
├── stderr.txt
├── exit-code.txt
├── transcript.txt     captured screen for interactive flows
└── profile.json       when a profile was taken
```

Keep artifacts in a directory the workflow names, and keep them after cleanup. A transcript without the command that produced it is not evidence.
