---
name: deslop
description: "Remove AI-generated code slop from a branch's diff and restore local style: stray comments, defensive checks on trusted paths, any-casts, and needless nesting. Use before review or after rapid generation. Resolve the branch's actual base branch rather than assuming main. Keeps behavior unchanged."
---

# Remove AI code slop

Check the diff against the branch's base and remove AI-generated slop introduced in the branch. Resolve the actual base branch (the PR base, or the remote default branch) instead of assuming `main`.

## Focus Areas

- Extra comments that are unnecessary or inconsistent with local style
- Defensive checks or try/catch blocks that are abnormal for trusted code paths
- Casts to `any` used only to bypass type issues
- Deeply nested code that should be simplified with early returns
- Other patterns inconsistent with the file and surrounding codebase

## Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- Keep the final summary concise (1-3 sentences).
