// Contract I1 policy validation. This validates policy bytes only; a caller
// must additionally bind the result to a verified release before using it.
import { canonicalizeJson, verifyEnvelope } from "@ega-skills/hashing";
import { parseDocument } from "yaml";
import { isValidRepository } from "./sources-config.js";

export const INVOCATION_PROFILE = "ega-invocation-policy-v1" as const;
export type InvocationPolicyAtom = { readonly literal: string } | { readonly pr_number: true };
export interface InvocationPolicyRule { readonly id: string; readonly alternatives: readonly (readonly InvocationPolicyAtom[])[] }
export interface InvocationPolicySource { readonly source_id: string; readonly repository: string; readonly resolved_commit: string; readonly governed_skill_ids: readonly string[] }
export interface InvocationPolicyBinding { readonly source_id: string; readonly skill_id: string; readonly version_hash: string; readonly rules: readonly InvocationPolicyRule[] }
export interface InvocationPolicy {
  readonly object_type: "ega.invocation-policy";
  readonly schema_version: 1;
  readonly digest: string;
  readonly payload: { readonly profile: typeof INVOCATION_PROFILE; readonly sources: readonly InvocationPolicySource[]; readonly bindings: readonly InvocationPolicyBinding[] };
}

export class InvocationPolicyError extends Error {
  readonly code = "E_INVOCATION_POLICY_INVALID";
  constructor(message: string) { super(message); this.name = "InvocationPolicyError"; }
}
function invalid(message: string): never { throw new InvocationPolicyError(message); }
function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) invalid(`${field} has missing or unknown fields`);
  return result;
}
function list(value: unknown, field: string, nonempty = true): unknown[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid(`${field} must be ${nonempty ? "a nonempty" : "an"} array`);
  return value;
}
function text(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${field} is invalid`);
  return value;
}
const sourceId = /^[a-z0-9][a-z0-9-]*$/;
const skillId = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = /^sha256:[0-9a-f]{64}$/;
const utf8 = new TextDecoder();
function ordered(previous: string, current: string, field: string): string {
  if (previous && current <= previous) invalid(`${field} must be sorted and unique`);
  return current;
}
function checkSkillId(value: unknown): string {
  const id = text(value, skillId, "skill_id");
  if ((id.split("/")[1] ?? "").length > 64) invalid("skill name exceeds 64 characters");
  return id;
}

/** Reject duplicate JSON object names before JSON.parse can erase them. */
export function parseInvocationPolicy(bytes: string): InvocationPolicy {
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
    const document = parseDocument(bytes, { uniqueKeys: true });
    if (document.errors.length !== 0) invalid("policy JSON contains duplicate keys or invalid syntax");
  } catch (error) {
    if (error instanceof InvocationPolicyError) throw error;
    invalid("policy must be valid JSON with unique object keys");
  }
  return validateInvocationPolicy(value);
}

/** Validate the complete I1 schema and its immutable envelope digest. */
export function validateInvocationPolicy(value: unknown): InvocationPolicy {
  const envelope = object(value, ["object_type", "schema_version", "payload", "digest"], "envelope");
  if (envelope["object_type"] !== "ega.invocation-policy" || envelope["schema_version"] !== 1 || !verifyEnvelope(value).ok) invalid("policy envelope or digest is invalid");
  const payload = object(envelope["payload"], ["profile", "sources", "bindings"], "payload");
  if (payload["profile"] !== INVOCATION_PROFILE) invalid("unsupported invocation profile");
  const sources = new Map<string, Set<string>>();
  const governed = new Set<string>();
  let previous = "";
  for (const raw of list(payload["sources"], "sources", false)) {
    const source = object(raw, ["source_id", "repository", "resolved_commit", "governed_skill_ids"], "source");
    const id = text(source["source_id"], sourceId, "source_id");
    previous = ordered(previous, id, "sources");
    if (!isValidRepository(source["repository"])) invalid("invalid source repository");
    text(source["resolved_commit"], /^[0-9a-f]{40}$/, "resolved_commit");
    const ids = new Set<string>();
    let last = "";
    for (const rawId of list(source["governed_skill_ids"], "governed_skill_ids")) {
      const skill = checkSkillId(rawId);
      last = ordered(last, skill, "governed_skill_ids");
      if (governed.has(skill)) invalid("skill is governed by multiple sources");
      governed.add(skill); ids.add(skill);
    }
    sources.set(id, ids);
  }
  previous = "";
  const seen = new Set<string>();
  const allAlternatives = new Map<string, string>();
  for (const raw of list(payload["bindings"], "bindings", false)) {
    const binding = object(raw, ["source_id", "skill_id", "version_hash", "rules"], "binding");
    const skill = checkSkillId(binding["skill_id"]);
    previous = ordered(previous, skill, "bindings");
    const id = text(binding["source_id"], sourceId, "source_id");
    if (!sources.get(id)?.has(skill)) invalid("binding does not belong to its declared source");
    text(binding["version_hash"], hash, "version_hash");
    seen.add(skill);
    const rules = list(binding["rules"], "rules");
    if (rules.length > 128) invalid("too many rules");
    let priorRule = "";
    let alternativeCount = 0;
    const localAlternatives = new Set<string>();
    for (const rawRule of rules) {
      const rule = object(rawRule, ["id", "alternatives"], "rule");
      priorRule = ordered(priorRule, text(rule["id"], /^[a-z0-9][a-z0-9-]{0,63}$/, "rule id"), "rules");
      let priorAlternative = "";
      for (const rawAlternative of list(rule["alternatives"], "alternatives")) {
        alternativeCount++;
        const atoms = list(rawAlternative, "alternative");
        if (atoms.length > 32) invalid("too many atoms");
        for (const rawAtom of atoms) {
          if (rawAtom === null || typeof rawAtom !== "object" || Array.isArray(rawAtom)) invalid("invalid atom");
          const atom = rawAtom as Record<string, unknown>;
          if (Object.keys(atom).length !== 1) invalid("invalid atom fields");
          if ("literal" in atom) text(atom["literal"], /^[a-z0-9-]+$/, "literal");
          else if (!("pr_number" in atom) || atom["pr_number"] !== true) invalid("invalid atom");
        }
        const canonical = utf8.decode(canonicalizeJson(atoms));
        priorAlternative = ordered(priorAlternative, canonical, "alternatives");
        if (localAlternatives.has(canonical)) invalid("duplicate alternative in binding");
        localAlternatives.add(canonical);
        const owner = allAlternatives.get(canonical);
        if (owner !== undefined && owner !== skill) invalid("alternative shared by different skills");
        allAlternatives.set(canonical, skill);
      }
    }
    if (alternativeCount > 256) invalid("too many alternatives");
  }
  if (seen.size !== governed.size) invalid("missing governed binding");
  return value as InvocationPolicy;
}
