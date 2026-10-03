/**
 * CONTRACT-T1 normative and inheritance checks.
 *
 * Contract T1 (MCP usage telemetry) has no artifact schema to validate, so it
 * has no `scripts/contracts/validate-contract-*.mjs` companion. These tests are
 * the mechanical enforcement instead: they assert the contract's normative
 * text, its references into the repository, and — most importantly — that the
 * field lists T1 inherits from CONTRACT-D section 5 are still actually present
 * in CONTRACT-D, so the two documents cannot silently drift apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CONTRACTS = join(REPO, "docs", "contracts");

const T1_PATH = join(CONTRACTS, "CONTRACT-T1-MCP-Usage-Telemetry.md");
const D_PATH = join(CONTRACTS, "CONTRACT-D-Hosted-Runtime.md");
const F_PATH = join(CONTRACTS, "CONTRACT-F-Multi-User-Authorization.md");

const T1 = readFileSync(T1_PATH, "utf8");
const D = readFileSync(D_PATH, "utf8");

/** Lowercase, collapse every non-alphanumeric run to a single space. */
function norm(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Prose view: drop markdown emphasis and backticks so normative sentences can
 * be matched without depending on emphasis or quoting style. Underscores are
 * preserved because field and table names in these contracts are snake_case. */
function plain(value) {
  return value.replace(/[*`]/g, "").replace(/\s+/g, " ");
}

/** Body of `## N.` section, tolerant of heading text and trailing spaces. */
function sectionBody(md, n) {
  const open = new RegExp(`^##\\s*${n}\\.`, "m").exec(md);
  assert.ok(open, `section ${n} not found`);
  const start = open.index + open[0].length;
  const rest = md.slice(start);
  const close = new RegExp(`^##\\s*${n + 1}\\.`, "m").exec(rest);
  const body = close ? rest.slice(0, close.index) : rest;
  assert.ok(body.trim().length > 0, `section ${n} is empty`);
  return body;
}

/** Split a CONTRACT-D style inline enumeration into normalized field names. */
function parseEnumClause(clause) {
  return clause
    .split(",")
    .map((part) => norm(part.replace(/^\s*(?:and|or)\s+/, "")))
    .filter((part) => part.length > 0);
}

/** The nine permitted fields CONTRACT-D section 5 permits, read from CONTRACT-D
 * itself — never hardcoded here, so drift in CONTRACT-D fails this test. */
function inheritedPermittedFields(md = D) {
  const section5 = sectionBody(md, 5);
  const sentence = /Operational records may contain([^.]+)\./i.exec(section5);
  assert.ok(sentence, "CONTRACT-D section 5 no longer states the permitted operational-record fields");
  const fields = parseEnumClause(sentence[1]);
  assert.ok(fields.length > 0, "CONTRACT-D permitted-field enumeration parsed empty");
  return fields;
}

/** The forbidden classes CONTRACT-D section 5 forbids, read from CONTRACT-D. */
function inheritedForbiddenClasses(md = D) {
  const section5 = sectionBody(md, 5);
  const sentence = /They MUST NOT contain([^.]+)\./i.exec(section5);
  assert.ok(sentence, "CONTRACT-D section 5 no longer states the forbidden operational-record classes");
  return parseEnumClause(sentence[1]);
}

const INHERITED_PERMITTED = inheritedPermittedFields();
const INHERITED_FORBIDDEN = inheritedForbiddenClasses();

const T1_S3 = sectionBody(T1, 3);
const T1_S4 = sectionBody(T1, 4);
const T1_S3N = norm(T1_S3);
const T1_S4N = norm(T1_S4);
const T1_PLAIN = plain(T1);

test("CONTRACT-T1 file exists, is non-empty, and is titled as a contract", () => {
  assert.ok(existsSync(T1_PATH), "CONTRACT-T1 file is missing");
  assert.ok(statSync(T1_PATH).size > 1024, "CONTRACT-T1 file is implausibly small");
  assert.match(T1.split("\n")[0], /^#\s+Contract T1\b/);
});

test("CONTRACT-T1 declares an explicit Status", () => {
  const status = /^Status:.*\S.*$/m.exec(T1);
  assert.ok(status, "CONTRACT-T1 has no Status line");
  assert.match(status[0], /\S/);
});

test("CONTRACT-T1 has all eleven required sections", () => {
  const headings = [...T1.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(headings, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("CONTRACT-T1 has no unresolved placeholder tokens", () => {
  assert.doesNotMatch(T1, /\b(TODO|TBD|FIXME|XXX)\b/);
});

test("CONTRACT-T1 does not amend CONTRACT-D or CONTRACT-F", () => {
  assert.match(T1_PLAIN, /does not amend CONTRACT-D or CONTRACT-F/);
  assert.match(T1_PLAIN, /That audit vocabulary is unchanged/);
  assert.match(T1_PLAIN, /MUST NOT be reused, extended, or overloaded to carry read-path telemetry/);
});

test("CONTRACT-T1 inherits every permitted field CONTRACT-D section 5 permits", () => {
  for (const field of INHERITED_PERMITTED) {
    assert.ok(T1_S3N.includes(field), `CONTRACT-T1 section 3 does not inherit permitted field "${field}"`);
  }
});

test("CONTRACT-T1 quotes the CONTRACT-D permitted list verbatim", () => {
  const quoted = /Operational records may contain([^.]+)\./i.exec(T1_S3);
  assert.ok(quoted, "CONTRACT-T1 section 3 does not quote CONTRACT-D's permitted-field sentence");
  assert.deepEqual(parseEnumClause(quoted[1]), INHERITED_PERMITTED);
});

test("CONTRACT-T1 declares the inherited permitted set is exactly CONTRACT-D's set", () => {
  assert.match(T1_S3, /Those nine fields are the complete inherited permitted set:/);
  assert.equal(INHERITED_PERMITTED.length, 9);
  // The nine inherited names must be the only ones in that closing enumeration.
  const enumeration = /complete inherited permitted set:\s*\n([\s\S]*?)\n\s*\n/.exec(T1_S3);
  assert.ok(enumeration, "CONTRACT-T1 section 3 lacks the enumerated inherited field list");
  const listed = parseEnumClause(enumeration[1].replace(/\n/g, " "));
  assert.deepEqual(listed, INHERITED_PERMITTED);
});

test("CONTRACT-T1 justifies every field it adds beyond CONTRACT-D section 5", () => {
  // Bullets wrap across lines; a bullet runs until the next one begins.
  const starts = [...T1_S3.matchAll(/^ {3}- `([a-z_]+)`/gm)];
  assert.ok(starts.length > 0, "CONTRACT-T1 section 3 declares no added fields");
  const bullets = starts.map((m, i) => {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : T1_S3.length;
    return T1_S3.slice(from, to);
  });
  for (const bullet of bullets) {
    const field = /^ {3}- `([a-z_]+)`/.exec(bullet)[1];
    assert.match(bullet, /Justified:/, `added field without a justification: ${field}`);
    assert.match(
      bullet,
      /\b(?:not|no|never|forbidden|prohibition)\b/i,
      `added field not justified against the prohibition list: ${field}`,
    );
  }
});

test("CONTRACT-T1 inherited field list is closed", () => {
  assert.match(T1_PLAIN, /A field not listed in rule 1 or rule 2 MUST NOT be persisted/);
  assert.match(T1_PLAIN, /no default-permitted set/);
});

test("CONTRACT-T1 forbids every class CONTRACT-D section 5 forbids", () => {
  for (const cls of INHERITED_FORBIDDEN) {
    assert.ok(T1_S4N.includes(cls), `CONTRACT-T1 section 4 does not forbid "${cls}"`);
  }
});

test("CONTRACT-T1 extends the forbidden list with the credential and payload classes", () => {
  for (const term of [
    "Authorization header",
    "JWT",
    "OAuth authorization code",
    "refresh token",
    "client secret",
    "password",
    "source credential",
    "Supabase service-role key",
    "full request payload",
    "full response payload",
    "private skill body",
  ]) {
    assert.ok(T1_S4N.includes(norm(term)), `CONTRACT-T1 section 4 does not forbid "${term}"`);
  }
});

test("CONTRACT-T1 forbids storing search query text and resolve task text", () => {
  assert.match(T1_PLAIN, /resolve task text, in whole or in part/);
  assert.match(T1_PLAIN, /search query text, in whole or in part/);
  assert.match(T1_PLAIN, /get_content returned body, in whole or in part/);
  // Free-text request inputs must not be readable into any permitted field.
  assert.match(T1_PLAIN, /MUST NOT be read into any permitted field/);
});

test("CONTRACT-T1 forbids logging forbidden values, not merely persisting them", () => {
  assert.match(T1_PLAIN, /Forbidden means forbidden in logs too/);
  assert.match(T1_PLAIN, /MUST NOT be logged, printed, traced, sampled, attached to an error/);
});

test("CONTRACT-T1 keeps telemetry out of every immutable data-plane artifact", () => {
  const section2 = plain(sectionBody(T1, 2));
  for (const term of [
    "registry.sqlite",
    "HubRelease envelope",
    "release package",
    "content blob",
    "stable pointer",
    "ProjectContext",
  ]) {
    assert.ok(section2.includes(term), `CONTRACT-T1 section 2 does not exclude "${term}"`);
  }
  assert.match(section2, /MUST NOT be written into, and MUST NOT cause a mutation of/);
});

test("CONTRACT-T1 requires telemetry to be non-blocking and time-bounded", () => {
  const section6 = plain(sectionBody(T1, 6));
  assert.match(section6, /MUST still return the successful tool result/);
  assert.match(section6, /Observability MUST NOT become an availability dependency/);
  assert.match(section6, /Telemetry latency MUST be bounded/);
  assert.match(section6, /250 ms/);
  assert.match(section6, /per-request emission budget of one event/);
  assert.match(section6, /MUST NOT be awaited before the response is committed/);
  assert.match(section6, /Disabling telemetry is always conformant/);
});

test("CONTRACT-T1 forbids a browser client from submitting a usage record", () => {
  const section5 = plain(sectionBody(T1, 5));
  assert.match(section5, /A browser client MUST NOT be able to submit an arbitrary usage record/);
  assert.match(section5, /no browser-callable endpoint, no tool, and no RPC that accepts a caller-supplied telemetry row/);
  assert.match(section5, /server assertion, never a client assertion/);
  for (const bound of ["workspace-bound", "authenticated", "bounded", "sanitized", "idempotent where practical"]) {
    assert.ok(section5.includes(bound), `write bounds missing: "${bound}"`);
  }
});

test("CONTRACT-T1 refuses to assume one HTTP request is one logical execution", () => {
  const section7 = plain(sectionBody(T1, 7));
  assert.match(section7, /One HTTP request MUST NOT be assumed to equal one logical tool execution/);
  assert.match(section7, /MUST be proven from the protocol/);
  assert.match(section7, /Retries MUST NOT be double-counted as two successful logical uses/);
  // Mechanical anti-claim check: every "one HTTP request" mention must be negated.
  for (const m of T1_PLAIN.matchAll(/one http request/gi)) {
    const following = T1_PLAIN.slice(m.index, m.index + 120).toLowerCase();
    assert.ok(/must not|never|is not/.test(following), `unnegated "one HTTP request" claim: ${following}`);
  }
});

test("CONTRACT-T1 defines four distinct funnel stages and forbids discovery as use", () => {
  const raw8 = sectionBody(T1, 8);
  const section8 = plain(raw8);
  const stages = ["searched", "resolved", "inspected", "content_retrieved"];
  // Each stage must be *defined* by its own bullet in the funnel list, not
  // merely mentioned somewhere in the section.
  const definitions = [...raw8.matchAll(/^ {3}- `([a-z_]+)` — an? `([a-z_]+)` execution/gm)];
  const defined = definitions.map((m) => m[1]);
  for (const stage of stages) {
    assert.ok(defined.includes(stage), `funnel stage has no defining bullet: "${stage}"`);
  }
  assert.deepEqual(defined, stages, "funnel stage order or membership changed");
  for (const stage of stages) {
    assert.ok(section8.includes(stage), `funnel stage missing: "${stage}"`);
  }
  // Distinctness: no two stages may share a defining execution.
  const executions = definitions.map((m) => m[2]);
  assert.equal(new Set(executions).size, executions.length, "two funnel stages are defined by the same tool");
  assert.match(section8, /discovered . resolved . inspected . content-retrieved/);
  assert.match(section8, /A search result MUST NOT be labelled a used skill/);
  assert.match(section8, /MUST NOT produce one event per returned row/);
  assert.match(section8, /A search execution produces one event carrying result_count/);
});

test("CONTRACT-T1 bounds reads, aggregation, and retention", () => {
  const section9 = plain(sectionBody(T1, 9));
  assert.match(section9, /Raw event rows MUST NOT be shipped to a browser wholesale/);
  assert.match(section9, /Aggregation MUST happen server-side or database-side/);
  assert.match(section9, /retained for 90 days/);
  assert.match(section9, /purge MUST NOT delete anything outside the telemetry model/);
});

test("CONTRACT-T1 forbids repurposing audit_events and quota_usage, with schema evidence", () => {
  const section10 = plain(sectionBody(T1, 10));
  assert.match(section10, /audit_events is control and security history and MUST NOT be repurposed as usage telemetry/);
  assert.match(section10, /quota_usage is aggregate request and bandwidth accounting and MUST NOT be treated as detailed usage analytics/);
  assert.match(section10, /Extending either audit_events or quota_usage with telemetry columns is forbidden/);

  // The cited evidence must still say what the contract claims it says.
  const controlPlane = readFileSync(join(REPO, "supabase", "migrations", "202609090001_hosted_control_plane.sql"), "utf8");
  const audit = /create table if not exists public\.audit_events \(([\s\S]*?)\n\);/.exec(controlPlane);
  assert.ok(audit, "audit_events table definition not found in the cited migration");
  for (const column of ["actor_subject", "operation", "target_identity", "old_identity", "new_identity"]) {
    assert.ok(audit[1].includes(column), `audit_events no longer has column ${column}`);
  }

  const dataPlane = readFileSync(join(REPO, "supabase", "migrations", "202609090003_immutable_data_plane.sql"), "utf8");
  const quota = /create table if not exists public\.quota_usage \(([\s\S]*?)\n\);/.exec(dataPlane);
  assert.ok(quota, "quota_usage table definition not found in the cited migration");
  for (const column of ["window_started", "request_count", "bandwidth_bytes"]) {
    assert.ok(quota[1].includes(column), `quota_usage no longer has column ${column}`);
  }
});

test("CONTRACT-T1 grants no mutation authority", () => {
  const section11 = plain(sectionBody(T1, 11));
  assert.match(section11, /grants no mutation authority/);
  assert.match(section11, /grants no control-plane write authority/);
  assert.match(section11, /does not authorize a new MCP tool/);
});

test("every repository path CONTRACT-T1 references exists", () => {
  const refs = new Set(
    [...T1.matchAll(/`((?:docs|supabase|packages|scripts|tests)\/[A-Za-z0-9._/-]+?)(?::\d+(?:-\d+)?)?`/g)].map((m) => m[1]),
  );
  assert.ok(refs.size >= 5, `expected several repository path references, found ${refs.size}`);
  for (const ref of [...refs].sort()) {
    assert.ok(existsSync(join(REPO, ref)), `CONTRACT-T1 references a missing path: ${ref}`);
  }
  // The three contracts T1 builds on must be present.
  for (const name of ["CONTRACT-D-Hosted-Runtime.md", "CONTRACT-F-Multi-User-Authorization.md"]) {
    assert.ok(refs.has(`docs/contracts/${name}`), `CONTRACT-T1 never references ${name}`);
  }
});

test("CONTRACT-T1's audit-vocabulary rule matches CONTRACT-F section 5's operation list", () => {
  // T1 says F section 5's vocabulary is control-plane mutations. If F's list
  // changes, this contract's claim about it must be re-reviewed.
  const fSection5 = sectionBody(readFileSync(F_PATH, "utf8"), 5);
  for (const operation of [
    "Membership",
    "role",
    "visibility",
    "source",
    "publication",
    "stable-pointer",
    "context",
    "revocation",
    "quota",
    "credential",
  ]) {
    assert.ok(plain(fSection5).includes(operation), `CONTRACT-F section 5 no longer enumerates "${operation}" operations`);
  }
  const vocabularyRule = /CONTRACT-F §5 enumerates control-plane mutation operations[\s\S]*?Read-path tool executions are not audit events\./.exec(plain(T1));
  assert.ok(vocabularyRule, "CONTRACT-T1 lost its CONTRACT-F audit-vocabulary rule");
  assert.match(vocabularyRule[0], /is unchanged/);
  assert.match(vocabularyRule[0], /control-plane mutation operations/);
  assert.match(vocabularyRule[0], /MUST NOT be reused/);
});

test("inheritance parser survives whitespace and quoting rewrites of CONTRACT-D section 5", () => {
  // Guards the cross-check itself: if the extractor only worked on the exact
  // current formatting, it would be a trivia assertion, not a drift guard.
  const mangled = D.replace(
    /Operational records may contain[\s\S]*?authorization decision class\./,
    [
      "Operational records MAY CONTAIN   request ID,",
      "   authenticated subject ID , workspace ID,",
      "effective release/context, tool, latency,",
      "`result/error class`,",
      "rate-limit result, and   authorization decision   class.",
    ].join("\n"),
  );
  assert.notEqual(mangled, D, "whitespace mangling did not change CONTRACT-D");
  assert.deepEqual(inheritedPermittedFields(mangled), INHERITED_PERMITTED);
});

test("inheritance parser fails loudly when CONTRACT-D section 5 loses a field", () => {
  const truncated = D.replace("workspace ID, effective release/context,", "effective release/context,");
  assert.notEqual(truncated, D);
  const fields = inheritedPermittedFields(truncated);
  assert.equal(fields.length, INHERITED_PERMITTED.length - 1);
  assert.ok(!fields.includes("workspace id"), "the removed field must disappear from the parse");
  // The failure mode this guards: a silent CONTRACT-D edit would otherwise
  // leave CONTRACT-T1 claiming to inherit a field that no longer exists.
  assert.match(T1_S3, /Those nine fields are the complete inherited permitted set:/);
});