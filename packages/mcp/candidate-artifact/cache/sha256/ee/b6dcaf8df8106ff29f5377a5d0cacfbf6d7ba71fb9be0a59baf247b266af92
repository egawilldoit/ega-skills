# Exploration guide

Two reusable briefs. Use the exploration brief for each parallel angle when the question is broad. Use the synthesis brief when turning one or more sets of findings into the final explanation.

## Exploration brief

You are tracing a codebase to learn how something works. Gather facts: read implementations, follow call chains, map components. Another pass writes the human-facing explanation, so favor accuracy over prose.

Question: {QUESTION}

Your angle: {ANGLE}

Other angles are being traced in parallel. Do not cover the whole subsystem. Go deep on your assigned angle.

1. Find the entry point. What triggers this behavior: a user action, an API call, a job, a render? Find where it starts.
2. Trace the flow. Follow the call chain and read each function. Note the data that flows and how it transforms, the decision points, and the branch conditions.
3. Map the key abstractions. Read the definitions of the central types, interfaces, and services. Say what each represents and why it exists.
4. Find the boundaries. Where does this slice connect to the rest? What goes in and out?
5. Note ownership and state. What state exists, which component holds it, and who may write it.
6. Note the non-obvious. Anything surprising, historically motivated, or easy to misread.

Use search and file reads to read the code. Do not guess from names. If you cannot trace a connection, say so.

Return findings in this structure:

- Components: name, location, one line on what it does.
- Flow: step, location, what it does, what it calls next, data passed.
- State and ownership: what is held where and mutated by whom.
- Boundaries: inputs and outputs.
- Files read: every file you opened.
- Non-obvious things.
- Open questions: what you could not trace.

## Synthesis brief

Write an explanation a senior engineer new to this area can read and use to start working confidently. The findings may overlap or contradict. Reconcile them, check disputed points against the code, and merge overlapping descriptions. Read the code yourself to fill gaps.

Rules:

- Concrete over abstract. Name the function and the call.
- Reference specific files and symbols so the reader can navigate.
- Use a diagram only when the flow spans components and prose is not enough. A diagram should clarify, not decorate.
- Do not pad a simple flow.
- If an angle could not be traced, keep the gap visible rather than filling it with a guess.
- Do not write a rationale for the design. That is a separate job.

Output: use the sections in the skill body's output contract.
