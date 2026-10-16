---
name: certify-mcp-production
description: "Certify a production MCP server end to end: endpoint, protocol negotiation, OAuth, tool discovery, tool schemas, permission and profile mapping, read and write operations, idempotency, denial behavior, auditability, and real client compatibility. Use before declaring an MCP integration production-ready or client-compatible. Do not claim client compatibility from curl or server-local tests alone; compatibility requires evidence from the actual client."
---

# Certify MCP production

A server that answers one request from `curl` is not a certified MCP
integration. Certification covers negotiation, authorization, every tool class,
denial, audit, and the clients users actually run.

## Checks

Cover each item when it applies to the server. Record the evidence level.

| Check | What to prove |
| --- | --- |
| Production endpoint | the exact deployed endpoint, via `certify-production-target` |
| Protocol negotiation | initialize and capability exchange succeed at the endpoint |
| OAuth | the real authorization path issues and accepts credentials |
| Tool discovery | the tool list is complete and matches the implementation |
| Tool schemas | inputs and outputs validate; invalid input is rejected clearly |
| Permission and profile mapping | scopes map to the intended tool access |
| Read operations | reads return correct data through the protocol |
| Write operations | writes apply and are visible on a subsequent read |
| Idempotency | repeating a write does not duplicate side effects |
| Denial behavior | unauthorized scopes and identities are actually denied |
| Auditability | operations are logged with identity and outcome |
| Supported clients | each claimed client is exercised through that client |

## Client compatibility

Compatibility is per client and must be proven per client. `curl`, a
server-local test, or a raw protocol script proves the server works, not that a
named client works with it.

```text
server-local test        E2 or E3, server works
raw protocol or curl     E5, endpoint works
named client             E6, that client works
```

Report each claimed client separately as `PASS`, `FAIL`, or `NOT CHECKED`.
Never report a client as supported based on a lower evidence level. Real client
paths may include ChatGPT, Codex, OpenCode, and MCP Inspector. Use whichever
clients the product actually claims; do not invent clients.

## Workflow

1. Certify the production endpoint with `certify-production-target`. Do not
   continue if it returns `AMBIGUOUS_TARGET` or `WRONG_TARGET`.
2. Exercise protocol negotiation against the production endpoint.
3. Complete the real OAuth path, including credential acquisition and refresh.
4. Discover tools and compare the list and schemas against the implementation.
5. Verify permission and profile mapping: which scope reaches which tool.
6. Run a read, then a write followed by a confirming read.
7. Repeat the write and confirm no duplicate side effect.
8. Attempt a denied operation with a lower scope and confirm refusal, not silent
   success.
9. Confirm the operation appears in the audit log with identity and outcome.
10. Exercise each claimed client through that client. Record per-client results.

## Hard rules

- Do not claim full client compatibility from `curl` or server-local tests.
- A denial that returns success, or that changes state before refusing, is a
  failure, not a pass.
- An idempotency check that only repeats a read is not an idempotency check.
- Tool schemas must be validated with invalid input, not only valid input.
- Writes against production require explicit authority (`L6`). Without it,
  report `AUTHORITY_REQUIRED` for the write and audit steps.
- Certification is not authorization. See `references/operating-contract.md`.

## Verdicts

```text
MCP_CERTIFIED  all applicable checks pass, including each claimed client at E6
MCP_PARTIAL    server checks pass; one or more clients not checked or failing
MCP_FAILED     a server check or a claimed client failed
BLOCKED        target, authority, or evidence is missing
```

## Output contract

```text
VERDICT: MCP_CERTIFIED | MCP_PARTIAL | MCP_FAILED | BLOCKED
Endpoint: <url> (target verdict)
Server: <name or identifier>

Checks:
- protocol negotiation: PASS | FAIL | NOT CHECKED   evidence=E<n>
- OAuth:                PASS | FAIL | NOT CHECKED   evidence=E<n>
- tool discovery:       PASS | FAIL | NOT CHECKED   evidence=E<n>
- tool schemas:         PASS | FAIL | NOT CHECKED   evidence=E<n>
- permission mapping:   PASS | FAIL | NOT CHECKED   evidence=E<n>
- read operations:      PASS | FAIL | NOT CHECKED   evidence=E<n>
- write operations:     PASS | FAIL | NOT CHECKED   evidence=E<n>
- idempotency:          PASS | FAIL | NOT CHECKED   evidence=E<n>
- denial behavior:      PASS | FAIL | NOT CHECKED   evidence=E<n>
- auditability:         PASS | FAIL | NOT CHECKED   evidence=E<n>

Client compatibility:
- <client>: PASS | FAIL | NOT CHECKED   evidence=E<n>

Blockers:
- <check>: <exact fact> (<blocker type>)

Next action: <one exact step>
```

Shared vocabulary is in `references/operating-contract.md`.
