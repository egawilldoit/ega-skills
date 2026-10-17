# Evidence sources

Playbook for each source. Run the available ones, record the unavailable ones, and treat a null result as a finding. Use connected tools and MCP servers where present.

## Conversation history

- What it holds: what was said, decided, and attempted, including corrections and abandoned approaches.
- How to search: order candidates by real modification time, not by identifier. Grep the topic first, then read only matching conversations and only their relevant regions.
- Keep raw history in the subagents. The main thread gets findings only.
- Citation: conversation id and turn, or a permalink.
- Strength: strong for intent and decisions, weak for present state. Never the final word on whether something shipped.

## Repository

- What it holds: implementation truth. Branches, commits, the working tree, tags.
- How to check: current branch, HEAD SHA, merge base against the default branch, dirty state, ahead and behind, worktree list, recent commits touching the topic.
- Citation: branch name, commit SHA, `file:line`.
- Strength: authoritative for what the code is, not for what is deployed.

## Pull requests and issues

- What it holds: proposed and merged changes, review discussion, open questions.
- How to check: list pull requests for the branch or author, their base and head SHAs, merge state, and check status. List open issues touching the topic.
- Citation: pull request or issue number.
- Strength: authoritative for review and merge status. A merged pull request beats a chat claim that work is done.

## Project tracker

- What it holds: planned and assigned work, status, and ownership.
- How to check: query the tracker for items on the topic and the people involved.
- Citation: ticket id.
- Strength: authoritative for planning status only after it is reconciled against technical truth. A ticket marked done while the code is absent is a contradiction to report, not to accept.

## Docs

- What it holds: design notes, specs, runbooks, decision records.
- How to check: search the docs workspace for the topic and read the relevant pages.
- Citation: page title and link, or file path.
- Strength: authoritative for stated intent and process, not for current runtime state.

## CI

- What it holds: whether checks passed, on which commit, and what failed.
- How to check: the checks attached to the exact current head SHA. A green check on an older commit proves nothing about the head.
- Citation: run id and head SHA.
- Strength: authoritative for check results on the commit it ran against.

## Deployment state

- What it holds: what is actually running where.
- How to check: the deployment platform's current deployment, its source revision, and its health.
- Citation: deployment id, environment, source revision.
- Strength: authoritative for what is live. Distinct from what is merged.

## Reconciliation priority

When sources disagree, prefer the authoritative source for the claim:

```text
implementation truth   -> repository
review and merge state -> pull request host
CI results             -> the exact associated checks
deployment truth       -> the deployment platform
runtime truth          -> the running environment
planning status        -> the tracker, after reconciling against technical truth
intent and decisions   -> conversation history and docs
```

If the contradiction survives the authoritative check, report both and mark it CONTRADICTED.
