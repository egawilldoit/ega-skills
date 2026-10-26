# Draft contract: release-bound invocation policy for issue 168

**Status: PROPOSED FOR INDEPENDENT REVIEW.** This document is not a frozen
contract, implementation authorization, skill approval, release, or deployment.
It proposes a new opt-in profile; existing V1 contracts remain normative until
the relevant amendments and tests are reviewed and accepted.

## 1. Authority and scope

Discovery, invocation eligibility, and execution authorization are separate.
EGA's policy may restrict or qualify automatic routing, but cannot grant any
execution capability. Skill text, source owners, the model, `task`, and
`explicit_skills` do not grant permissions. A host must enforce effective
system, user, project, and tool restrictions at every action boundary, including
delegates, shell access and inherited credentials.

The policy is a separately governed EGA release input, not an upstream file,
manifest edit, external-source overlay, or a replacement for project deny,
lock, version or AMEND-09 rules. It does not change SkillVersion content or
hashes. Policy review and approval are distinct from exact-version skill
adoption approval; a digest alone authenticates neither a reviewer nor a user.

Initial rollout applies only to the nine canonical `t3dotgg/*` IDs selected
from Git source `t3dotgg-tstack`, repository
`https://github.com/t3dotgg/tstack`, resolved commit
`7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd`, and the exact nine SkillVersions
from a newly verified canonical intake plan. The plan in REVIEW.md is prior
evidence, not a new approval. No policy entry for an ID means the V1 routing algorithm applies to that ID,
subject to the fail-closed binding rules below. Adding catalog documents may
change search ranks and competing candidates, even for ungoverned IDs.

## 2. Proposed versioned artifacts

Define a new policy object with JCS/SHA-256 envelope semantics per SPEC-002;
the exact object type is `ega.invocation-policy`, schema version 1. Its payload
contains exactly `profile`, `sources`, and `bindings`; unknown fields and
duplicate keys/IDs are invalid. `profile` is the literal
`ega-invocation-policy-v1`. `sources` is a sorted array of objects with exactly
`source_id`, `repository`, `resolved_commit`, and `governed_skill_ids`, the
latter a sorted nonempty array of canonical IDs. `bindings` is a sorted array
of objects with exactly `source_id`, `skill_id`, `version_hash`, and `rules`.
Every governed ID has exactly one binding; every binding belongs to exactly one
declared source and governed ID. Digests are lowercase `sha256:` plus 64 hex
digits; the Git commit is its exact 40-character lowercase object ID. IDs,
source IDs and repositories use their existing canonical contract formats.

The release contains the complete policy object or its immutable content
addressed blob and binds its digest, the invocation-profile identifier and the
router implementation/contract version in its semantic envelope. A new release
and candidate schema must explicitly describe the artifact and verifier checks;
R1 export and both local and hosted consumers verify and retain it. Policy
digest is also included in the release diff and the review/approval packet.
Existing release schema versions and their readers keep their current semantics.
An older runtime must reject a release requiring the new profile, not ignore it.

Before a release is made available, the trusted intake/build and independent
release verification must compare the policy to the selected release skill map
and adopted source provenance, including the normalized source configuration
preimage, repository, selected roots and root-to-skill mapping. The existing
`source_config_digest` commits to that preimage; the release review packet
must retain the preimage and mapping and verify the digest against the release.
The release digest binds the policy digest, source ID, resolved commit, source
configuration digest and selected skill versions. Offline runtime activation
checks those release-bound values and policy bindings, but cannot independently
reconstruct the repository or root mapping from the C1 source record. It relies
on the authenticated, independently reviewed release publication and its
build-time provenance verification; a digest alone does not attest origin or
review. A forged or compromised publisher is outside that guarantee. Missing,
duplicate, malformed, unrecognized or mismatched policy, source, commit,
skill/version binding, digest or profile is a hard error. No use of latest,
unlocked content, ambient files, or network lookup is a fallback. A project lock selecting a governed version different from its
one release binding leaves that governed ID unavailable for automatic routing and causes an
explicit reference to that ID to be rejected with `INVOCATION_POLICY_BINDING`.
It does not fail unrelated explicit references or automatic candidates. It must
never silently use the current version's binding. This profile supports one
selected version per governed ID, not historical-version policy bindings. Search,
inspect and get_content retain their existing project-lock and version rules;
the invocation policy is not content-access authorization.

A source listed in `sources` governs exactly the listed IDs; a release
transition that removes a previously governed ID from this roster while still
selecting it, removes its policy, or changes its source/version must fail
preflight unless an explicit, separately reviewed policy migration authorizes
that change. Forward publication compares against the currently published,
verified release, and the migration decision is a governed, independently
reviewed record binding old and new release/policy identities. The record is
not authorizable by a skill, model or policy payload alone. This transition
check requires a trusted prior release and
governed publication process. Hashes do not prevent an authorized publisher
from intentionally creating a different policy, and cannot by themselves prove
approval. On a fresh initial introduction, governance review must verify the
full nine-ID roster; an empty or omitted policy is not an acceptable way to
introduce the reviewed TStack source.
Serving or repointing to an already verified retained older release is rollback,
not a new forward publication: verify and serve that release under its original
profile and do not apply the new-policy roster check retroactively. An old
runtime still cannot serve a new-profile release.

## 3. Deterministic rules

Each binding has a nonempty `rules` array of unique, sorted rule objects. A rule
has exactly `id` and `alternatives`. `id` is unique within the binding and
matches `[a-z0-9][a-z0-9-]{0,63}`. Each alternative is a nonempty array of
atoms. An atom has exactly one of:

- `literal`: one canonical lower-case ASCII token consisting of letters,
  digits, or hyphens, with no spaces; or
- `pr_number: true`: a token consisting of `#` followed by 1–9 ASCII digits.

An alternative matches only the **entire** normalized task token sequence.
Normalization for this profile is precisely: trim ASCII whitespace U+0009
through U+000D and U+0020, lowercase ASCII A–Z, split on one or more of those
whitespace characters, and discard a
single terminal `.`, `!`, or `?` from the last token. All other characters,
including quotes, punctuation and non-ASCII characters, are retained; they
cannot match an atom unless explicitly allowed above. Empty input never matches.
There is no substring match, regex, stemming, LLM, inference, hidden threshold,
or wild-card. Multiple alternatives represent reviewed phrasing; a policy
validator rejects duplicate alternatives, more than 256 alternatives per
binding, more than 32 atoms per alternative, or more than 128 rules per
binding. The sorted source keys are `source_id`, governed IDs and binding keys
are `skill_id`, and rule keys are `id`, using lexicographic ASCII byte order.
Alternatives are sorted by their JCS UTF-8 bytes and exact duplicates are
invalid; JSON duplicate object keys are invalid before canonicalization. The
matched evidence value is the canonical skill ID, a colon, and the
lexicographically first matching rule ID, even if multiple alternatives match.
An alternative shared by two different governed skill IDs is invalid across
the entire policy. Since the only variable atom is `pr_number`, overlapping
alternatives are identical atom sequences; reject such overlap at validation.
Any matching alternative returns
`WORKFLOW_INTENT`; otherwise it returns `INVOCATION_UNCONFIRMED`.

### Exact proposed nine-version policy

This complete policy is a contract-review candidate, not an adopted policy,
release identity, or skill approval. Its skill hashes are from the prior intake
plan `sha256:beead990accac2318a0aad15dc1058c2cb38947b008f209c621c3b51df9808cc`;
a fresh canonical Git-source intake must reproduce them before adoption. Its
policy digest is `sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6`, computed over JCS UTF-8 of the envelope without
`digest`. The object below is normative for this proposal; any change to it
requires a new digest and independent review.

```json
{
  "object_type": "ega.invocation-policy",
  "schema_version": 1,
  "digest": "sha256:0e5304ee9516bce5c43b34a1f7c0747d0b8ff6f409b64628abe826a8ba9399d6",
  "payload": {
    "profile": "ega-invocation-policy-v1",
    "sources": [{
      "source_id": "t3dotgg-tstack",
      "repository": "https://github.com/t3dotgg/tstack",
      "resolved_commit": "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd",
      "governed_skill_ids": ["t3dotgg/babysit-pr", "t3dotgg/council", "t3dotgg/file-pr", "t3dotgg/full-send", "t3dotgg/full-stop", "t3dotgg/leaving-pr-comments", "t3dotgg/modernize", "t3dotgg/sol-loop", "t3dotgg/takeover"]
    }],
    "bindings": [
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/babysit-pr",
        "version_hash": "sha256:e04074fafff80b5b89d8713d46278f74e310e71d936af7bffffa7b8ed3862370",
        "rules": [{"id": "babysit-pr-intent", "alternatives": [
          [{"literal":"babysit"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"babysit"},{"literal":"this"},{"literal":"pr"}],
          [{"literal":"monitor"},{"literal":"this"},{"literal":"pr"},{"literal":"for"},{"literal":"checks"},{"literal":"and"},{"literal":"review"},{"literal":"feedback"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/council",
        "version_hash": "sha256:3886b94694c14043eb69ae549026fb58c03b2df5f2f02078fb130fffa092424e",
        "rules": [{"id": "council-intent", "alternatives": [
          [{"literal":"have"},{"literal":"three"},{"literal":"different"},{"literal":"ai"},{"literal":"models"},{"literal":"independently"},{"literal":"review"},{"literal":"this"},{"literal":"design"}],
          [{"literal":"run"},{"literal":"council"},{"literal":"review"},{"literal":"on"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"run"},{"literal":"council"},{"literal":"review"},{"literal":"on"},{"literal":"this"},{"literal":"pr"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/file-pr",
        "version_hash": "sha256:f122b9983ba8d71d5904eecdfaec2087b340f5931006cd63892bf1913e3d576c",
        "rules": [{"id": "file-pr-intent", "alternatives": [
          [{"literal":"file"},{"literal":"a"},{"literal":"pr"},{"literal":"after"},{"literal":"implementation"}],
          [{"literal":"file"},{"literal":"a"},{"literal":"pr"},{"literal":"for"},{"literal":"these"},{"literal":"changes"}],
          [{"literal":"open"},{"literal":"a"},{"literal":"pull"},{"literal":"request"},{"literal":"for"},{"literal":"these"},{"literal":"changes"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/full-send",
        "version_hash": "sha256:c665966575ce8896ce9cfe87f9a9962e60b5ae5c3e15f5915d026d97de1796ef",
        "rules": [{"id": "full-send-intent", "alternatives": [
          [{"literal":"full"},{"literal":"send"},{"literal":"pr"},{"pr_number":true},{"literal":"and"},{"literal":"merge"},{"literal":"when"},{"literal":"green"}],
          [{"literal":"full"},{"literal":"send"},{"literal":"this"},{"literal":"pr"},{"literal":"and"},{"literal":"merge"},{"literal":"when"},{"literal":"green"}],
          [{"literal":"full"},{"literal":"send"},{"literal":"this"},{"literal":"pr"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/full-stop",
        "version_hash": "sha256:c1be4648ab8b5bc2e4659174aa6f109d5af27718e901e5e8ef5e1821be59edc5",
        "rules": [{"id": "full-stop-intent", "alternatives": [
          [{"literal":"full"},{"literal":"stop"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"full"},{"literal":"stop"},{"literal":"this"},{"literal":"pr"}],
          [{"literal":"prepare"},{"literal":"this"},{"literal":"pr"},{"literal":"through"},{"literal":"review"},{"literal":"and"},{"literal":"ci"},{"literal":"without"},{"literal":"merging"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/leaving-pr-comments",
        "version_hash": "sha256:cb6bf03e50106ae957670029043649fd87c9a29c529104f2bb03cf0212cb4dbf",
        "rules": [{"id": "leaving-pr-comments-intent", "alternatives": [
          [{"literal":"format"},{"literal":"agent"},{"literal":"authored"},{"literal":"comments"},{"literal":"on"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"format"},{"literal":"these"},{"literal":"pr"},{"literal":"comments"}],
          [{"literal":"standardize"},{"literal":"these"},{"literal":"agent"},{"literal":"authored"},{"literal":"github"},{"literal":"comments"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/modernize",
        "version_hash": "sha256:43f822037b0b0e624274e3dc1127fbb4a269ca920a8ac5e8409f151827ea7958",
        "rules": [{"id": "modernize-intent", "alternatives": [
          [{"literal":"modernize"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"modernize"},{"literal":"this"},{"literal":"pr"}],
          [{"literal":"update"},{"literal":"and"},{"literal":"rebase"},{"literal":"this"},{"literal":"older"},{"literal":"pr"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/sol-loop",
        "version_hash": "sha256:ae8fb31ef38a9e30bdca3381c91017aed680f1e319fe9fb2ae2f1fe23cf30d5b",
        "rules": [{"id": "sol-loop-intent", "alternatives": [
          [{"literal":"run"},{"literal":"an"},{"literal":"independent"},{"literal":"reviewer"},{"literal":"loop"},{"literal":"on"},{"literal":"this"},{"literal":"pr"}],
          [{"literal":"run"},{"literal":"sol-loop"},{"literal":"review"},{"literal":"on"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"run"},{"literal":"sol-loop"},{"literal":"review"},{"literal":"on"},{"literal":"this"},{"literal":"pr"}]
        ]}]
      },
      {
        "source_id": "t3dotgg-tstack",
        "skill_id": "t3dotgg/takeover",
        "version_hash": "sha256:39a467c35ec9dfc3937f53e2d4f1c2d23b6a6ff0c3aafc397fef9d9e307cae40",
        "rules": [{"id": "takeover-intent", "alternatives": [
          [{"literal":"continue"},{"literal":"this"},{"literal":"unfinished"},{"literal":"pr"}],
          [{"literal":"take"},{"literal":"over"},{"literal":"pr"},{"pr_number":true}],
          [{"literal":"take"},{"literal":"over"},{"literal":"this"},{"literal":"pr"}]
        ]}]
      }
    ]
  }
}
```

For each listed alternative the full input must match after normalization.
`pr_number` represents only `#` followed by 1–9 ASCII digits. Examples of
negative or unconfirmed tasks include `Investigate why the network full send
buffer is saturated`, `Design a data model for a city council`, `Schedule a
city council meeting`, `Modernize a city's infrastructure`, `Plan a business
takeover`, `Explain the sol loop`, `Do not babysit this pr`, and quoted examples
of the accepted phrases. None matches the complete input. `Run council review
on this PR` and `Have three different AI models independently review this
design` match Council; `Full send this PR and merge when green` matches Full
Send. These are routing eligibility examples, never execution authorization.

A client receiving `INVOCATION_UNCONFIRMED` may present or inspect the candidate
and can pass the exact canonical ID via `explicit_skills` when the actual user
asks for that workflow. For literal `$council`, the host maps to
`t3dotgg/council` through the existing reference rules; it must not turn a
negated or quoted reference into a positive user request. The host checks
actual authority and capability independently. In particular, `Run council,
but don't use subagents` is not automatically matched by this finite grammar;
the client may explicitly resolve Council if requested but must report the
conflicting restriction and launch no delegates.

These patterns permit only reviewed clear phrases. For example, extra
negation, quotations, instructions, unfamiliar wording or restrictions yield
unconfirmed intent, rather than interpreting the extra text as permission. This
is deliberately incomplete: arbitrary extra clauses such as “but don't use
subagents” do not match an automatic rule, and clients must use the explicit
path when appropriate. Expanding coverage requires reviewed policy changes and
tests. A candidate policy is not ready unless it includes and tests the nine
positive workflows and the user-specified natural Council and PR examples;
the exact candidate above has not yet passed those tests. An explicit
reference continues through the existing
explicit resolution path, including project deny/lock/validity checks and
AMEND-09. If a client presents `$council` syntax, the client must map it to a
valid existing explicit reference; the router does not infer human provenance
from `explicit_skills`.

The existing hosted `resolve` tool does not advertise `explicit_skills`, even
though local resolve accepts it. This profile therefore requires a separately
reviewed hosted MCP contract amendment adding optional `explicit_skills` with
the same reference validation, maximum of ten, deduplication, deny, lock,
budget and error behavior as local resolve. Existing hosted requests without
the field retain their behavior; hosted `project_path` remains unsupported.
Explicit references are caller assertions, never execution permissions. Until
that hosted extension is implemented and tested, hosted explicit resolve parity
is unverified; exact inspect/get_content alone is not equivalent to explicit
resolve.

## 4. Resolve semantics for the new profile

1. Validate request shape and effective project config/lock with existing
   errors, then validate the release policy. Resolve explicit references with
   existing validity, project deny/lock and budget accounting; a governed
   stale lock is a per-skill rejection as specified in §2.
2. Apply automatic project policy/lock and hard filters as in V1.
3. Retain search behavior. Evaluate policy rules for every visible, eligible
   governed binding whose selected version equals its policy binding, including
   when FTS did not return its name. A matching rule supplies evidence to the
   visible L0 row; it cannot reintroduce a
   hard-filtered or explicitly resolved row into automatic routing.
4. Before redundancy, automatic composition, confidence and token budget,
   separate governed candidates with unconfirmed intent, and governed
   AMEND-09 user-invoked-only candidates regardless of rule match, from
   automatic-eligible candidates. They cannot suppress another candidate,
   consume a selection slot or budget, or contribute positive automatic
   selection confidence. They may remain visible as bounded candidates with
   `INVOCATION_UNCONFIRMED` and/or `USER_INVOCATION_ONLY` as applicable. Keep
   ungoverned V1 AMEND-09 behavior unchanged.
5. For a positive policy match, add one `WORKFLOW_INTENT` evidence item whose
   value is the skill ID and first matching rule ID specified above. It is a
   strong task category for tier,
   strong-value tie-break, confidence, equivalent-competitor and exceptional
   third-skill composition purposes. It also participates as its own category
   in redundancy coverage comparison: its values are not covered by different
   categories or different rule IDs. A governed row with `WORKFLOW_INTENT`
   cannot suppress an ungoverned row, even if its V1 coverage would otherwise
   do so; ungoverned-to-ungoverned suppression remains exactly V1. An eligible
   row is Tier A with project
   strength and task strength, otherwise Tier B with task strength, under the
   existing tier definitions. Confidence counts this category exactly as other
   strong task categories; name-free matches can therefore reach MEDIUM. All
   existing hard filters, project compatibility, AMEND-09, token limits and
   composition still apply. A matching rule never overrides a denial or forces
   selection. Preserve the V1 tie-break sequence, adding this category to its
   strong-value calculation. No ungoverned row gets this evidence.
6. Ungoverned candidates use the unchanged V1 scoring, suppression and
   tie-break algorithms. Full-catalog search remains V1: added documents can
   change BM25 corpus statistics and hence ranks and relative ordering, and
   governed candidates can compete for finite selection and candidate budgets.
   Identical rankings or selections for every possible request are not promised.
   The 82-prompt automatic-selection and discovery regression requirements
   below are mandatory acceptance boundaries. Explicit and
   automatic pools remain distinct. Search, inspect and permitted exact-version
   get_content remain available for governed skills independently of the gate.

After the eligible automatic pipeline produces its ordered candidate list,
append separated discovered rows in their V1 rank order, without
duplicates, up to the existing output limit. Eligible rows take precedence for
the bounded list. On LOW confidence, preserve V1's eligible retained rows first
and append separated rows only into remaining slots; an appended row retains
`INVOCATION_UNCONFIRMED` and/or `USER_INVOCATION_ONLY` as applicable, and any
applicable compatibility warnings. If workspace ambiguity causes LOW
confidence, every separated row retained in the result also carries
`WORKSPACE_AMBIGUOUS` in the existing V1 negative-reason order. If the limit is
full, a separated row need not be returned. No new positive confidence derives
from a separated row.
Include the evidence, reason and error schemas below in the contract amendment
and golden vectors. Append the positive
`WORKFLOW_INTENT_MATCH` after the existing V1 positive reason order; append
`INVOCATION_UNCONFIRMED` after all existing negative reasons. Each appears at
most once. Preserve existing warning order.

For this profile, after request and effective-project validation, missing,
malformed, unsupported, unbound or digest-invalid release policy returns
`E_INVOCATION_POLICY_INVALID`, a structured MCP error with `isError`, no partial
resolution result, and the same public code locally and hosted. A project lock
selecting a governed version other than its release binding is a per-skill
negative reason `INVOCATION_POLICY_BINDING` on a resolved explicit reference;
the version is omitted from automatic eligibility. Do not disclose otherwise
project-denied skill identities in diagnostics. Release/candidate verification may fail earlier with its existing
artifact error, and must never activate the invalid release. Project-path and
authentication errors retain their existing precedence at their boundaries.

The V1 schema and frozen pipeline are not silently modified. The proposed
versioned schema changes are exact deltas to the existing contracts:

- SPEC-004 profile `ega-invocation-policy-v1` adds evidence enum
  `WORKFLOW_INTENT` after `LEXICAL`, positive reason `WORKFLOW_INTENT_MATCH`
  after `LOCKED_VERSION`, and negative reasons `INVOCATION_UNCONFIRMED` then
  `INVOCATION_POLICY_BINDING` after `USER_INVOCATION_ONLY`. Evidence remains
  `{category: string, value: string}`; all other V1 result fields, collections,
  limits and warning enums are unchanged. Reason emission follows those orders.
- SPEC-006 and hosted Contract D `resolve` add optional `explicit_skills`:
  JSON array of 0–10 strings, each nonempty after trim; resolve and deduplicate
  per SPEC-004. Hosted input remains `{task, max_skills?, max_tokens?,
  release_digest?, context_id?, explicit_skills?}`, with `task` required and
  `project_path` forbidden. Inputs and output fields otherwise stay unchanged.
  Add the above evidence/reason enum members to `RESOLVE_OUTPUT_SCHEMA` for
  the new profile; text fallback preserves selected IDs, version hashes and
  effective release digest. Add `E_INVOCATION_POLICY_INVALID` to the existing
  structured MCP error `code` enum, preserving its existing shape.
- `ega.hub-release` schema version 2 retains exactly the C1 payload keys and
  adds required `invocation_policy_digest` and `invocation_profile`; the
  latter is exactly `ega-invocation-policy-v1`. `contracts.router` is `2`,
  `contracts.build_contract` is `C2`; all other contract fields retain their
  C1 values. The digest binds the `ega.invocation-policy` envelope above. V1
  envelopes remain governed by C1 and are never reinterpreted as V2.
- `ega.release-candidate` schema version 3 has the R1 v2 payload shape and
  publication object, plus one required `files.invocation_policy` value,
  exactly `invocation-policy.json`. That file contains the complete policy
  envelope including its digest. Its digest must equal the HubRelease v2
  `invocation_policy_digest`; verify the artifact digest and release-bound
  source ID, resolved commit and skill/version bindings before candidate
  exposure, export, runtime readiness and every snapshot activation. Repository
  and root-to-skill origin verification is the trusted build/review step above,
  not an offline runtime proof.
  R1 v1/v2 retained-candidate behavior remains as documented. Release diff
  must include old and new policy digest/profile as immutable semantics.
- Compatibility vectors must include both schema versions, unknown-field
  rejection, old-runtime refusal of new profiles, retained V1 rollback,
  hosted request field parity and error/enum validation. These schema changes
  require amendments or explicit successors to SPEC-004, SPEC-006, C, D, R1
  and R2 before implementation; this proposal is not itself a frozen amendment. A
missing or invalid required policy is an error, not a LOW-confidence fallback.
Local and hosted runtimes must use the same profile, policy bytes and tests.

## 5. Security and delivery boundary

An explicit skill or a matched rule indicates only client-supplied routing
intent. It does not authenticate a human instruction. The host must enforce no
subagents, no unauthorized merge or deployment, and read-only constraints,
including across descendant agents and alternate shell/credential paths. A
Council request with no-subagents or unavailable required providers must report
that the specified workflow cannot run; it must not fabricate completion.
Full Stop's sibling reference must resolve to its pinned release version and
must not expand permissions. Cancelling an existing auto-merge or queue is a
hosted mutation requiring its own authorization.

Hosted `get_content` does not deliver `babysit-pr/scripts/pr-wait` as an
executable companion. A supported native monitoring path, or an authorized
client retrieval from the exact Git commit with independently verified script
checksum and prerequisites, is required for that workflow. Importing the skill
does not install or execute the script. Clients without either capability must
report that limitation.

## 6. Acceptance before requesting exact-version approval

- Independently review and accept the amended contract and profile; a contract
  acceptance is not adoption or publication authorization.
- Test exact, negative, ambiguous, quoted and negated examples for all nine,
  including full-send buffer, city-council data model and council scheduling,
  business takeover and infrastructure modernization. Test explicit Council
  and Full Send, and the two exact natural Council examples above.
- Test policy-matched candidate discovery without a name match, gate order,
  AMEND-09, hard filters, conflicts, budgets, pinned sibling references, and
  same semantics in local and hosted runtimes.
- Test a higher-ranked governed workflow match against a lower-ranked
  ungoverned row with empty V1 coverage: the governed row cannot suppress it.
  Test unchanged ungoverned-to-ungoverned suppression and locked-version error
  per-skill stale-lock rejection while an unrelated valid existing skill resolves.
- Test a governed user-invoked-only row that matches a workflow rule against a
  second governed row: it cannot suppress, add confidence or consume budget,
  and it retains `USER_INVOCATION_ONLY` when returned.
- Test that a separated row retained when workspace ambiguity causes LOW
  confidence carries `WORKSPACE_AMBIGUOUS` in V1 reason order.
- Verify the hosted tool schema and authenticated explicit resolution of all
  nine IDs, including `$council` client mapping, deny/lock handling, error and
  budget parity, and release-digest binding.
- Test real supported host enforcement of no delegation, unauthorized merge,
  deployment and writes, including alternate tools and missing capabilities;
  router tests alone are not enforcement evidence.
- Reject overlapping alternatives across skills, including equal `pr_number`
  patterns; test that malformed overlap cannot produce HIGH confidence.
- Reject malformed, omitted, tampered, stale and downgraded policy artifacts;
  test old-runtime rejection and unchanged retained V1 release behavior. Test
  source-config preimage substitution, repository and root mapping tampering
  in build/review, and policy, source-ID, commit and version substitution at
  offline activation; demonstrate that offline activation does not claim to
  re-derive repository identity from the source-config digest.
- Verify the 117 original version hashes, unchanged 82-corpus automatic
  selections, all ten changed suggestion rankings, and no additional
  discovery-quality regressions. Track the 22 baseline failures separately.
- Regenerate the pinned source plan, nine exact hashes and policy digest; review
  source bytes, provenance, license and release candidate independently. Present
  the owner with those exact identities only after blockers are resolved. No
  self-approval, adoption, release, or deployment is authorized by this draft.
