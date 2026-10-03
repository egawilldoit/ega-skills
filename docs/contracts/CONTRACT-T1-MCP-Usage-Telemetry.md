# Contract T1 — MCP Usage Telemetry v1

Status: frozen for the web-console implementation candidate.

Contract D §7 (`docs/contracts/CONTRACT-D-Hosted-Runtime.md:95-101`) assigns
audit policy to Contract E/F, and Contract F §5
(`docs/contracts/CONTRACT-F-Multi-User-Authorization.md:56-66`) fixes the audit
vocabulary to control-plane mutations. Neither contract states where a
human-readable analytics projection of read-path MCP executions may be stored,
who may read it, or how long it is retained. This contract governs that gap and
nothing else. It defines storage, field, write-authority, availability, identity,
usage, read, and retention rules for read-path MCP usage telemetry.

## 1. Scope and relationship to existing contracts

1. This contract does **not** amend CONTRACT-D or CONTRACT-F. It narrows nothing
   in them and adds nothing to their normative text. Where this contract is
   stricter than an existing contract, the stricter rule governs telemetry only.
2. This contract inherits CONTRACT-D §5's permitted and forbidden field lists
   **verbatim** (§3 rule 1 and §4 rule 1 quote the source sentences). Any
   future change to CONTRACT-D §5's field lists is a CONTRACT-D amendment and a
   review event for this contract; T1 MUST NOT be edited silently to follow.
3. CONTRACT-F §5 enumerates control-plane mutation operations — membership,
   role, visibility, source, publication, stable-pointer, context, revocation,
   quota, and credential operations. That audit vocabulary is unchanged and
   MUST NOT be reused, extended, or overloaded to carry read-path telemetry.
   Read-path tool executions are not audit events.
4. This contract inherits the read-path surface from CONTRACT-D §2 (exactly
   `search`, `resolve`, `inspect`, `get_content`) and the request-shape rules
   from `docs/specs/SPEC-006-MCP-Runtime-Contract.md` §5.1.5–§5.1.8. Telemetry
   MUST NOT add a tool, and no telemetry field may be derived from a request
   input the protocol marks as free text.
5. Nothing here authorizes a data-plane write, a HubRelease mutation, a
   ProjectContext publication, a stable-pointer change, or a new MCP tool.

## 2. Storage boundary

1. Telemetry MUST live in a dedicated, mutable, append-oriented model owned by
   the control plane. It is not a runtime artifact and is not part of any
   release.
2. Telemetry MUST NOT be written into, and MUST NOT cause a mutation of:
   `registry.sqlite` or any SQLite artifact; any `HubRelease` envelope; any
   release package or release manifest; any content blob or
   content-addressed object; the retained-release manifest; the stable pointer;
   any `ProjectContext` artifact or fingerprint digest.
3. Immutable data-plane artifacts are untouched by telemetry. A release
   published before telemetry existed and a release published after it MUST
   remain byte-identical for identical inputs.
4. Telemetry rows MUST NOT participate in any artifact identity, digest, cache
   identity, or search-ranking input. A telemetry write MUST NOT change the
   result of any CONTRACT D §5 cache-identity computation.
5. Telemetry MUST NOT be reachable through the hosted MCP data-plane
   credentials. The runtime credential set stays read-only on the data plane;
   telemetry writes use a separate, explicitly authorized writer identity.
6. The telemetry store MUST be degradable independently. Disabling, emptying,
   or corrupting telemetry MUST NOT change any MCP tool result.

## 3. Permitted fields

1. Inherited from CONTRACT-D §5 verbatim, and permitted unchanged:

   > Operational records may contain request ID, authenticated subject ID,
   > workspace ID, effective release/context, tool, latency, result/error class,
   > rate-limit result, and authorization decision class.

   Those nine fields are the complete inherited permitted set:
   `request ID`, `authenticated subject ID`, `workspace ID`,
   `effective release/context`, `tool`, `latency`, `result/error class`,
   `rate-limit result`, `authorization decision class`.

2. The following fields are added by this contract. Each addition is justified
   against the prohibition list in §4; none is a proxy for forbidden content:

   - `observed_at` — the server-observed completion instant of the execution.
     Justified: it is a timestamp, not content. It is required for any time
     series and is explicitly a non-identity input, mirroring CONTRACT F §5's
     rule that timestamps are not artifact identity inputs.
   - `execution_id` — a server-assigned monotonic identity for one logical tool
     execution. Justified: it is server-generated, opaque, and carries no
     client-supplied text. It exists for retry de-duplication (§7) and
     correlation only; it is not a capability and grants no access.
   - `idempotency_key` — a bounded digest over the server-derived execution
     identity. Justified: it is a fixed-width digest, so a duplicate submission
     cannot inflate a count, and it carries no readable input.
   - `request_bytes` and `response_bytes` — measured byte counts.
     Justified: a count is not content, and bandwidth accounting already exists
     as an aggregate in `quota_usage` (§10). A count cannot be reversed into a
     body.
   - `result_count` — for a `search` execution, the number of rows returned.
     Justified: §8 requires one `search` event carrying a count rather than
     per-result associations, so no per-result usage association is ever
     stored and none can be reconstructed later.
   - `content_level` — for a `get_content` execution, the requested level
     (`L1` or `L2`) or an explicit companion-file marker.
     Justified: it is a closed enumeration of protocol constants from
     SPEC-006 §5.1.8 rule 0. It names the level, never the body, and it does
     not reveal whether a private skill body exists beyond what the
     authenticated caller was already authorized to fetch.
   - `telemetry_failure_class` — a closed enumeration reason a telemetry write
     failed or was skipped. Justified: §6 requires telemetry failures to be
     independently observable, and a closed class carries no diagnostic
     payload.
   - `schema_version` — the telemetry record version.
     Justified: it is a version constant, not content, and it lets retention
     and migration be versioned without rewriting historical rows.

3. The permitted set is closed. A field not listed in rule 1 or rule 2 MUST NOT
   be persisted, and a new field requires a reviewed amendment to this contract.
4. No permitted field may be filled from a request input that the protocol
   defines as free text. Free-text inputs (`resolve.task`, `search.query`,
   `get_content.file_path`) MUST NOT be read into any permitted field.
5. Field names are `snake_case`, matching SPEC-006 §5.1.3 rule 4, so telemetry
   needs no second naming convention.

## 4. Forbidden fields and forbidden logging

1. Inherited from CONTRACT-D §5 verbatim, and forbidden:

   > They MUST NOT contain tokens, secrets, private skill bodies, or full task
   > prompts by default.

2. The phrase "by default" does not apply to persisted telemetry. Telemetry has
   **no** default-permitted set: nothing may be persisted unless §3 rule 1 or
   §3 rule 2 lists it. This is a narrowing for telemetry only and does not
   change CONTRACT-D §5 for any other operational record.
3. In addition, the following are forbidden in telemetry — persisted, indexed,
   cached, queued, or exported:

   - `resolve` task text, in whole or in part, including any hash or embedding
     of it;
   - `search` query text, in whole or in part, including any hash or embedding
     of it;
   - `get_content` returned body, in whole or in part, including any prefix,
     excerpt, digest of the content, or token-count-derived reconstruction
     beyond the integer token count already permitted as a byte/token measure;
   - the `Authorization` header, any `Cookie` or `Set-Cookie` value, and any
     other request header whose value is or may bear a credential;
   - a JWT, in whole or in part, including a decoded claim set;
   - an OAuth authorization code, a refresh token, a client secret, an id token;
   - a password or passphrase, in any field, including a hashed one;
   - a source credential value; only an opaque secret-manager reference already
     governed by CONTRACT F §5 is ever visible, and it is forbidden in
     telemetry;
   - a Supabase service-role key, anon key, JWT secret, or any other platform
     secret;
   - a full request payload and a full response payload, including a
     reconstructed one assembled from permitted fields;
   - a private skill body, and any L0/L1/L2 text excerpt of one.
4. Forbidden means forbidden **in logs too**. A forbidden value MUST NOT be
   logged, printed, traced, sampled, attached to an error, placed in a metric
   label, or written to a crash report. This restates and does not relax
   CONTRACT D §4, which already requires that access tokens, refresh tokens,
   authorization codes, client secrets, and source credentials are never logged
   or persisted.
5. A telemetry error, a diagnostic, or a failure class MUST be sanitized
   before it leaves the process. A sanitizer failure MUST fail the telemetry
   write closed: the event is dropped, never emitted unredacted.
6. A field name that merely sounds safe is not permission. If a value's
   provenance is a forbidden input, the field is forbidden regardless of name.

## 5. Write authority and trust boundary

1. A telemetry event asserts that **the server** observed an actual MCP
   execution. It is a server assertion, never a client assertion.
2. A browser client MUST NOT be able to submit an arbitrary usage record. There
   is no browser-callable endpoint, no tool, and no RPC that accepts a
   caller-supplied telemetry row. No client-supplied field is trusted, and a
   client-supplied `workspace_id`, `subject`, `tool`, or count is never a
   capability.
3. The authorized writer is the hosted MCP server process acting on its own
   observed execution, using a dedicated writer credential that is distinct from
   the runtime's read-only data-plane credential. Direct table writes from an
   end-user session role MUST be denied, mirroring the existing
   control-plane pattern where mutation stays with a trusted writer and
   `authenticated` receives only `select`
   (`supabase/migrations/202609090004_contract_f_rls.sql:285-306`).
4. Every write MUST be:
   - **workspace-bound** — the writer derives `workspace_id` from the
     authenticated principal and the authorized workspace graph; a
     client-supplied workspace ID is never used;
   - **authenticated** — writes occur only on a path that already completed
     CONTRACT D §4 authentication;
   - **bounded** — row size, field count, and per-request emission count are
     bounded, and a bound violation drops the event instead of truncating it
     into a misleading value;
   - **sanitized** — §4 rules apply before the write, at the writer, not only
     at the read path;
   - **idempotent where practical** — §7's `idempotency_key` makes a repeated
     submission of the same logical execution a no-op rather than a second
     count.
5. An unauthenticated, unauthorized, or rejected request produces at most a
   sanitized denial-class telemetry event carrying no subject identity beyond
   what CONTRACT D §6 permits for a sanitized authentication failure. It never
   produces a successful-usage event.
6. The write path MUST NOT be reachable by anything other than the authorized
   writer. No plugin, tool, skill script, or browser bundle holds the writer
   credential.

## 6. Availability independence

1. Observability MUST NOT become an availability dependency. A successful MCP
   tool call combined with an unavailable, slow, or failing telemetry sink
   **MUST still return the successful tool result**, unchanged and with the
   contract-correct `structuredContent`.
2. Telemetry therefore fails independently. A telemetry failure MUST:
   - not alter the tool result, its status, its headers, or its body;
   - not cause the MCP request to fail, retry, or return a partial response;
   - not corrupt, truncate, or reorder tool output by any interleaving;
   - emit one sanitized operational error carrying only
     `telemetry_failure_class` plus the permitted identifiers of §3;
   - never expose a secret, a forbidden value, or a raw driver or transport
     error string in that error.
3. Telemetry latency MUST be bounded so it cannot hang a request. The writer
   uses a per-event deadline that MUST NOT exceed 250 ms of added latency, and
   a per-request emission budget of one event. A sink that has not acknowledged
   within the deadline is abandoned; the abandoned event is dropped or handed
   to a bounded local buffer, and the tool result is returned without waiting
   further.
4. A bounded local buffer is permitted. It MUST be bounded in depth and in
   bytes, MUST drop oldest-first under pressure, MUST NOT be required to
   survive a crash, and MUST NOT block the request path. Losing buffered
   telemetry is an acceptable outcome; delaying a tool result is not.
5. Telemetry MUST NOT be awaited before the response is committed. Emission is
   fire-and-forget under the §6 rule 3 deadline.
6. Telemetry MUST NOT be a precondition for readiness. A telemetry sink that is
   unavailable at startup MUST NOT make the runtime unhealthy, and MUST NOT
   block Contract D §1 startup verification or readiness.
7. If a deployment cannot satisfy rules 1–6, telemetry is disabled for that
   deployment. Disabling telemetry is always conformant; failing a successful
   tool call because telemetry failed is never conformant.

## 7. Event identity and retry semantics

1. One HTTP request MUST NOT be assumed to equal one logical tool execution,
   and one logical tool execution MUST NOT be assumed to equal one HTTP
   request. This mapping MUST be proven from the protocol before it is relied
   on, never inferred. An implementation that assumes the 1:1 mapping without
   proof is non-conformant.
2. Known non-equivalences that any implementation MUST account for: a single
   HTTP request MAY carry more than one JSON-RPC message; a notification
   carries no id; a client MAY retry a request after a transport timeout and
   receive a second successful response; a streamable-HTTP session MAY reuse a
   request across several tool calls; a proxy MAY retry a request the server
   already executed.
3. `execution_id` is assigned by the server at the point of observed tool
   execution and MUST be drawn from a source that is unique per logical
   execution: a server-side counter, a server-generated unique value, or a
   digest over the authenticated principal, the transport request identity,
   and the tool-execution position within that request.
4. The JSON-RPC message id is client-supplied and therefore MUST NOT be used
   alone as `execution_id`: a client may reuse, omit, or forge it. Where a
   JSON-RPC id is used at all, it is combined with a server-generated
   per-request identity so that client control cannot collapse two executions
   into one or split one execution into two.
5. `idempotency_key` is a bounded digest over `execution_id` plus the tool name.
   A retry that the server cannot distinguish from the original execution MUST
   be recorded once, not twice.
6. Retries MUST NOT be double-counted as two successful logical uses. If a
   deployment chooses to count a retry separately, that is an explicitly
   defined, documented counter semantic — not a default, and not a side effect
   of counting HTTP requests. Any such choice MUST be declared in the
   projection and MUST NOT be mixed with the once-per-execution rule.
7. A partially completed execution — for example a tool that authorizes and
   then fails before producing output — produces exactly one event with its
   actual result class. It does not produce an event per internal phase.
8. A drop due to §6 bounds is recorded as a bounded aggregate counter, never as
   a synthetic event that would inflate a funnel.

## 8. Usage semantics — the funnel

1. The four read-path stages are distinct and MUST NOT be treated as
   equivalent:
   - `searched` — a `search` execution completed. Discovery only.
   - `resolved` — a `resolve` execution returned a resolution.
   - `inspected` — an `inspect` execution returned metadata for a skill.
   - `content_retrieved` — a `get_content` execution returned content.
2. The funnel is `discovered → resolved → inspected → content-retrieved`. Each
   stage is a strict widening of evidence about actual use. The stages MUST NOT
   be summed into a single "usage" number, and one stage MUST NOT be inferred
   from another.
3. A search result MUST NOT be labelled a used skill. Discovery is not use.
   A skill appears in `used` only from a `resolve`, `inspect`, or
   `content_retrieved` execution that actually named it.
4. A `search` execution produces **one** event carrying `result_count`. It MUST
   NOT produce one event per returned row, and MUST NOT store a per-result
   association. Justification: a search returns up to 20 rows
   (SPEC-006 §5.1.6 rule 2); per-result association would multiply write volume
   by up to 20 for zero additional evidence about use, and would create a
   high-volume association store that invites exactly the per-result usage
   inference this contract forbids in rule 3.
5. `content_retrieved` is the strongest evidence of use and is deliberately the
   rarest. It is never inferred from `inspected`.
6. A stage transition MUST NOT be asserted without an observed execution of
   the later stage. A missing later stage is reported as missing, never as
   zero-usage-with-confidence.
7. Funnel counts are derived from observed executions only. An authorization
   denial is a denial, not a funnel step: a denied `resolve` does not advance
   `resolved`.

## 9. Read authorization, aggregation, and retention

1. Telemetry is readable only through an authorized server-side projection.
   The reader is the hosted runtime's read path acting for an authenticated
   principal, subject to the same workspace graph and role model as
   CONTRACT F §1 and §3. Roles are not redefined here.
2. Reading is workspace-scoped. A reader sees only telemetry for workspaces the
   principal is authorized for. Per-subject detail is restricted to the
   principal's own rows and to `owner`/`admin` readers, mirroring the existing
   admin-scoped read policies for control-plane accounting
   (`supabase/migrations/202609090004_contract_f_rls.sql:238-240`).
3. Raw event rows MUST NOT be shipped to a browser wholesale in order to
   compute charts. Aggregation MUST happen server-side or database-side, and the
   browser receives an aggregated, bounded projection.
4. An aggregated projection is bounded: a bounded time window, a bounded number
   of buckets, and a bounded number of series. The projection returns counts and
   classes only; it never returns a forbidden value, a subject ID, or a
   per-row record.
5. Retention: raw event rows are retained for **90 days** and are then deleted.
   The retention period is a maximum, is enforced by a scheduled, idempotent
   purge, and is not extendable by configuration beyond 90 days without a
   reviewed amendment. A purge MUST NOT delete anything outside the telemetry
   model and MUST NOT touch immutable artifacts.
6. Aggregates derived from expired rows MAY be retained longer than the raw
   rows, because an aggregate is a count and not a record. An aggregate MUST
   NOT be retained in a form that reconstructs an individual row.
7. An export of telemetry inherits every §4 prohibition and every §9 read
   restriction. Export is not a weakening of the field lists.
8. Deleting telemetry is always permitted and MUST NOT affect any MCP tool
   result.

## 10. Non-repurposing of existing control-plane accounting

1. `public.audit_events` is control and security history and MUST NOT be
   repurposed as usage telemetry. Schema evidence: its columns are
   `actor_subject`, `operation`, `target_identity`, `old_identity`,
   `new_identity`, `result`, `request_id`, `created_at`
   (`supabase/migrations/202609090001_hosted_control_plane.sql:43-54`), i.e. an
   old/new identity transition log for control-plane mutations — a shape a read
   path has no meaning for. CONTRACT F §5 enumerates its operations as
   control-plane mutations only, and T1 §1 rule 3 forbids reusing that
   vocabulary for telemetry. Its read policy is also admin-scoped
   (`supabase/migrations/202609090004_contract_f_rls.sql:238-240`), which is a
   security-review surface, not a usage surface.
2. `public.quota_usage` is aggregate request and bandwidth accounting and MUST
   NOT be treated as detailed usage analytics. Schema evidence: it is
   `(workspace_id, window_started, request_count, bandwidth_bytes)` keyed on the
   window (`supabase/migrations/202609090003_immutable_data_plane.sql:32-38`).
   It carries no tool, no subject, no release, no latency, and no result class,
   so it cannot express the §8 funnel. T1 §3 rule 2 permits byte counts as
   measurements, and reading them back out of `quota_usage` as if they were
   per-tool analytics is forbidden.
3. `public.security_denies` records persistent deny state, not usage
   (`supabase/migrations/202609090001_hosted_control_plane.sql:33-41`). Denials
   that are reported in telemetry are reported as an authorization decision
   class in the telemetry model, never as mutations of deny state.
4. Extending either `audit_events` or `quota_usage` with telemetry columns is
   forbidden. New telemetry capability is a new model under §2, not a new column
   on a security or accounting table.
5. These rules bind the schema. Any migration that adds telemetry storage to
   `audit_events` or `quota_usage` violates this contract even if it passes
   review as "analytics".

## 11. Boundary

1. This contract authorizes a human-readable analytics projection of read-path
   MCP usage, and nothing else.
2. It grants no mutation authority: no release, Hub, pointer, context, project,
   lock, fingerprint, membership, visibility, quota, or credential mutation.
3. It grants no control-plane write authority. Telemetry writes are the narrow,
   server-observed execution records of §5 and are not audit events.
4. It does not define billing, recommendation ranking, trust inference, or
   cross-workspace analytics.
5. It does not authorize a new MCP tool, a new request field, or any client-
   supplied usage input.