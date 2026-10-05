/**
 * Human pocket catalog (Phases D + E).
 *
 * The catalog is a PROJECTION, never a second registry:
 *
 *     HubRelease + L0 metadata + presentation metadata -> Markdown / terminal
 *
 * It reads L0 rows straight from the local registry — the same rows the router
 * consumes — and groups them with `catalog/presentation.yaml`, which is
 * explicitly NON-AUTHORITATIVE: it carries no triggers, domains, platforms,
 * anti-triggers, or aliases, and therefore can never influence resolver
 * ranking or Hub semantic identity.
 *
 * Determinism is a hard requirement (CONTRIBUTING §Determinism): group order is
 * authored, skill order within a group is sorted by id, and rendering is a pure
 * function of (L0 rows, presentation). Identical inputs produce identical
 * bytes on every platform.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { parse as parseYaml } from "yaml";

import { openRegistry, searchSkills } from "@ega-skills/registry";

/** Presentation metadata schema version understood by this module. */
export const CATALOG_PRESENTATION_SCHEMA_VERSION = 1;

/** Max candidates `catalog --search` reports, mirroring the discovery window. */
export const CATALOG_SEARCH_LIMIT = 5;

/**
 * Routing keys that presentation metadata must never contain. Presentation is
 * not authority: if it could carry these, editing a catalog label would become
 * a routing change, which the product explicitly forbids.
 */
const FORBIDDEN_PRESENTATION_KEYS = [
  "triggers",
  "anti_triggers",
  "domains",
  "platforms",
  "frameworks",
  "aliases",
] as const;

const CANONICAL_SKILL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

function fail(message: string): never {
  throw new CatalogError(message);
}

/** One skill as presented to a human. */
export interface CatalogSkill {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  /** Single-line, whitespace-collapsed description for terminal/Markdown use. */
  readonly summary: string;
}

export interface CatalogGroup {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly skills: readonly CatalogSkill[];
}

export interface CatalogModel {
  readonly favorites: readonly CatalogSkill[];
  readonly groups: readonly CatalogGroup[];
  readonly ungroupedTitle: string;
  readonly ungrouped: readonly CatalogSkill[];
  /** Skills authored into more than one group; reported, never silently deduped. */
  readonly multiGroup: readonly { readonly id: string; readonly groups: readonly string[] }[];
  readonly skillCount: number;
  readonly namespaces: readonly string[];
}

interface PresentationGroup {
  readonly id: string;
  readonly title: string;
  readonly blurb?: string;
  readonly skills: readonly string[];
}

interface Presentation {
  readonly catalog_version?: number;
  readonly favorites?: readonly string[];
  readonly groups: readonly PresentationGroup[];
  readonly ungrouped_title?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace so a description renders identically everywhere. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Condense a full skill description into a one-line pocket summary.
 *
 * Skill descriptions deliberately restate their whole trigger surface ("Use for
 * 'x', 'y'..."), which is right for the resolver and far too long for a human
 * catalog. A pocket catalog wants the leading sentence or two, so this walks
 * whole sentences until the summary is informative enough, then applies a hard
 * cap. The cut is purely textual, so it stays deterministic and never depends on
 * the description's routing content.
 */
export function summarize(description: string, maxLength = 140, minLength = 45): string {
  const text = oneLine(description);
  if (text.length === 0) return "";

  // Collect whole sentences up to the minimum informative length. A sentence
  // boundary is terminator followed by whitespace or end of string.
  const sentences = text.match(/^.*?[.!?](?=\s|$)/u);
  let summary = sentences === null ? text : sentences[0].trim();
  if (summary.length < minLength) {
    const remainder = text.slice(summary.length).trimStart();
    const next = remainder.match(/^.*?[.!?](?=\s|$)/u);
    if (next !== null) summary = `${summary} ${next[0].trim()}`;
  }

  if (summary.length > maxLength) {
    const clipped = summary.slice(0, maxLength);
    const lastSpace = clipped.lastIndexOf(" ");
    summary = `${(lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
  }
  return summary;
}

/**
 * Validate presentation metadata against the set of skills that actually
 * exist. Fails closed on every stale-reference class the product cares about:
 * unknown skill id, malformed group, duplicate id inside a group, duplicate
 * group id, and duplicate favorite.
 */
export function validatePresentation(
  presentation: unknown,
  knownSkillIds: ReadonlySet<string>,
): { favorites: string[]; groups: PresentationGroup[]; placement: Map<string, string[]> } {
  if (!isPlainObject(presentation)) fail("presentation must be a YAML mapping");
  if (presentation.catalog_version !== CATALOG_PRESENTATION_SCHEMA_VERSION) {
    fail(`unsupported catalog_version: ${String(presentation.catalog_version)}`);
  }
  for (const key of FORBIDDEN_PRESENTATION_KEYS) {
    if (key in presentation) {
      fail(`presentation metadata must not contain routing key "${key}": presentation is not routing authority`);
    }
  }

  const requireKnown = (id: unknown, where: string): string => {
    if (typeof id !== "string" || !CANONICAL_SKILL_ID.test(id)) {
      fail(`${where}: "${String(id)}" is not a canonical <namespace>/<name> skill id`);
    }
    if (!knownSkillIds.has(id)) {
      fail(`${where}: unknown skill id "${id}" is not present in this release`);
    }
    return id;
  };

  const rawFavorites = presentation.favorites ?? [];
  if (!Array.isArray(rawFavorites)) fail("favorites must be a sequence");
  const favorites: string[] = [];
  const seenFavorites = new Set<string>();
  for (const entry of rawFavorites) {
    const id = requireKnown(entry, "favorites");
    if (seenFavorites.has(id)) fail(`favorites: duplicate entry "${id}"`);
    seenFavorites.add(id);
    favorites.push(id);
  }

  const rawGroups = presentation.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) fail("groups must be a non-empty sequence");

  const groups: PresentationGroup[] = [];
  const placement = new Map<string, string[]>();
  const seenGroupIds = new Set<string>();

  for (const group of rawGroups) {
    if (!isPlainObject(group)) fail("each group must be a YAML mapping");
    const { id, title, blurb, skills } = group;
    if (typeof id !== "string" || id.length === 0) fail("each group needs a non-empty string id");
    if (typeof title !== "string" || title.length === 0) fail(`group "${id}" needs a non-empty string title`);
    if (blurb !== undefined && typeof blurb !== "string") fail(`group "${id}": blurb must be a string`);
    if (seenGroupIds.has(id)) fail(`duplicate group id: "${id}"`);
    seenGroupIds.add(id);

    if (!Array.isArray(skills) || skills.length === 0) fail(`group "${id}" needs a non-empty skills sequence`);
    const inGroup = new Set<string>();
    for (const entry of skills) {
      const skillId = requireKnown(entry, `group "${id}"`);
      if (inGroup.has(skillId)) fail(`group "${id}": duplicate skill id "${skillId}"`);
      inGroup.add(skillId);
      const existing = placement.get(skillId);
      if (existing === undefined) placement.set(skillId, [id]);
      else existing.push(id);
    }
    groups.push({
      id,
      title,
      blurb: typeof blurb === "string" ? blurb : "",
      skills: skills.map((entry) => entry as string),
    });
  }

  return { favorites, groups, placement };
}

/** Read every skill's L0 metadata from the local registry, keyed by canonical id. */
export function readL0Metadata(env: Record<string, string | undefined>): Map<string, CatalogSkill> {
  const registry = openRegistry({ env, readonly: true });
  try {
    const db = registry.db as unknown as {
      prepare(sql: string): { all(): { id: string; manifest: string }[] };
    };
    const rows = db
      .prepare(
        `SELECT s.skill_id AS id, v.manifest_json AS manifest
           FROM skills s
           JOIN skill_versions v
             ON v.skill_id = s.skill_id
            AND v.version_hash = s.current_version_hash`,
      )
      .all();
    const skills = new Map<string, CatalogSkill>();
    for (const row of rows) {
      const manifest = JSON.parse(row.manifest) as { portable?: { description?: string } };
      const [namespace, name] = row.id.split("/");
      skills.set(row.id, {
        id: row.id,
        name: name ?? row.id,
        namespace: namespace ?? "",
        summary: summarize(manifest?.portable?.description ?? ""),
      });
    }
    return skills;
  } finally {
    registry.close();
  }
}

/**
 * Build the presentation model from L0 metadata + presentation metadata.
 * Pure and deterministic: same inputs always produce the same model.
 */
export function buildCatalogModel(l0: ReadonlyMap<string, CatalogSkill>, presentation: unknown): CatalogModel {
  const knownSkillIds = new Set(l0.keys());
  const { favorites, groups, placement } = validatePresentation(presentation, knownSkillIds);
  const toSkill = (id: string): CatalogSkill => {
    const found = l0.get(id);
    if (found === undefined) fail(`unknown skill id "${id}" is not present in this release`);
    return found;
  };

  const placed = new Set(placement.keys());
  const ungrouped = [...knownSkillIds].filter((id) => !placed.has(id)).sort().map(toSkill);
  const multiGroup = [...placement.entries()]
    .filter(([, groupIds]) => groupIds.length > 1)
    .map(([id, groupIds]) => ({ id, groups: groupIds }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return {
    favorites: favorites.map(toSkill),
    // Group order is authored; skill order inside a group is id-sorted so the
    // rendered output never depends on authoring order.
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
      blurb: group.blurb ?? "",
      skills: [...group.skills].sort().map(toSkill),
    })),
    ungroupedTitle: typeof (presentation as Presentation).ungrouped_title === "string"
      ? (presentation as Presentation).ungrouped_title!
      : "Other",
    ungrouped,
    multiGroup,
    skillCount: knownSkillIds.size,
    namespaces: [...new Set([...knownSkillIds].map((id) => id.split("/")[0] ?? ""))].sort(),
  };
}

export interface BuildCatalogOptions {
  readonly env: Record<string, string | undefined>;
  readonly presentationPath: string;
}

/**
 * Parse presentation metadata from disk. Exposed so callers (the generator
 * script) never need their own `yaml` dependency: this package owns it.
 */
export function loadPresentation(presentationPath: string): unknown {
  return parseYaml(readFileSync(resolvePath(presentationPath), "utf8")) as unknown;
}

/** Load L0 + presentation from disk and build the model. */
export function buildCatalog(options: BuildCatalogOptions): CatalogModel {
  return buildCatalogModel(readL0Metadata(options.env), loadPresentation(options.presentationPath));
}

/** Render the catalog as deterministic Markdown with the exact release identity. */
export function renderCatalogMarkdown(model: CatalogModel, releaseIdentity: { digest: string; hubId: string }): string {
  const lines: string[] = [];
  lines.push("# EGA Skills Pocket Catalog");
  lines.push("");
  lines.push("```");
  lines.push("EGA Skills Pocket Catalog");
  lines.push(`Hub Release: ${releaseIdentity.digest}`);
  lines.push(`Hub id: ${releaseIdentity.hubId}`);
  lines.push("Generated from immutable release metadata");
  lines.push("Do not edit manually");
  lines.push("```");
  lines.push("");
  lines.push(
    "Generated by `pnpm generate:catalog` from the verified Hub release plus",
    "`catalog/presentation.yaml`. This is a human reference, not a registry: it",
    "carries no routing metadata and cannot change how anything is routed.",
    "Regenerate it; never hand-edit it.",
  );
  lines.push("");
  lines.push(`Skills in this release: **${model.skillCount}** across ${model.namespaces.length} namespace(s): ${model.namespaces.join(", ")}`);
  lines.push("");

  lines.push("## START HERE / COMMON TASKS");
  lines.push("");
  lines.push("A short list for recognition. Routing is decided by the resolver, never by this list.");
  lines.push("");
  for (const skill of model.favorites) {
    lines.push(`- \`${skill.id}\` — ${skill.summary || skill.name}`);
  }
  lines.push("");

  const emitSkill = (skill: CatalogSkill): void => {
    lines.push(`### ${skill.name}`);
    lines.push("");
    lines.push(`\`${skill.id}\``);
    lines.push("");
    if (skill.summary) {
      lines.push(skill.summary);
      lines.push("");
    }
  };

  for (const group of model.groups) {
    lines.push(`## ${group.title}`);
    lines.push("");
    if (group.blurb) {
      lines.push(group.blurb);
      lines.push("");
    }
    for (const skill of group.skills) emitSkill(skill);
  }

  if (model.ungrouped.length > 0) {
    lines.push(`## ${model.ungroupedTitle}`);
    lines.push("");
    for (const skill of model.ungrouped) emitSkill(skill);
  }

  if (model.multiGroup.length > 0) {
    lines.push("## Presentation notes");
    lines.push("");
    lines.push("Listed under more than one human-intent group (intentional, not a duplicate):");
    lines.push("");
    for (const entry of model.multiGroup) {
      lines.push(`- \`${entry.id}\` (${entry.groups.join(", ")})`);
    }
    lines.push("");
  }

  // Collapse runs of blank lines, then end with exactly one trailing newline so
  // repeated generation is byte-identical.
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

/** Render the catalog for a terminal: concise, browsable, no Markdown noise. */
export function renderCatalogText(model: CatalogModel, releaseIdentity: { digest: string }): string {
  const lines: string[] = [];
  lines.push("EGA SKILLS");
  lines.push(`release ${releaseIdentity.digest}`);
  lines.push(`${model.skillCount} skills in ${model.namespaces.length} namespaces`);
  lines.push("");
  // Cap the name column so one very long skill id cannot push every summary off
// the right edge of a terminal.
  const width = Math.min(
    Math.max(...[...model.groups.flatMap((g) => g.skills.map((s) => s.name.length)), ...model.ungrouped.map((s) => s.name.length)], 10),
    44,
  );
  for (const group of model.groups) {
    lines.push(group.title);
    for (const skill of group.skills) {
      lines.push(`  ${skill.name.padEnd(width)}  ${skill.summary || ""}`.trimEnd());
    }
    lines.push("");
  }
  if (model.ungrouped.length > 0) {
    lines.push(model.ungroupedTitle);
    for (const skill of model.ungrouped) {
      lines.push(`  ${skill.name.padEnd(width)}  ${skill.summary || ""}`.trimEnd());
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface CatalogCommandOptions {
  readonly env: Record<string, string | undefined>;
  readonly presentationPath: string;
  readonly json?: boolean;
  /** Optional filter. Reuses the registry's FTS `search`; adds no new algorithm. */
  readonly search?: string;
}

export interface CatalogSearchHit {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly summary: string;
  readonly group: string | null;
}

/**
 * `ega-skills catalog` — the human discovery surface.
 *
 * `search` deliberately reuses the existing registry FTS search and existing
 * presentation metadata. It never introduces an independent ranking algorithm.
 */
export function runCatalog(options: CatalogCommandOptions): string {
  // L0 metadata is read exactly once and shared by every output path.
  const l0 = readL0Metadata(options.env);
  const model = buildCatalogModel(l0, loadPresentation(options.presentationPath));

  if (options.search !== undefined && options.search.length > 0) {
    const registry = openRegistry({ env: options.env, readonly: true });
    let hits: readonly { skillId: string }[];
    try {
      // Reuses the registry's deterministic FTS search verbatim. `searchSkills`
      // exposes no limit option, so the window is applied here, exactly as the
      // MCP `search` tool applies its own limit.
      const ftsTable = resolveFtsTable(options.env, registry.db);
      hits = searchSkills(registry.db, options.search, ftsTable === undefined ? {} : { ftsTable }).slice(
        0,
        CATALOG_SEARCH_LIMIT,
      );
    } finally {
      registry.close();
    }
    const byId = new Map<string, string | null>();
    for (const group of model.groups) {
      for (const skill of group.skills) if (!byId.has(skill.id)) byId.set(skill.id, group.title);
    }
    const results: CatalogSearchHit[] = hits.map((hit) => {
      const skill = l0.get(hit.skillId);
      return {
        id: hit.skillId,
        name: skill?.name ?? hit.skillId.split("/")[1] ?? hit.skillId,
        namespace: skill?.namespace ?? hit.skillId.split("/")[0] ?? "",
        summary: skill?.summary ?? "",
        group: byId.get(hit.skillId) ?? null,
      };
    });
    return options.json === true
      ? `${JSON.stringify({ release: releaseIdentityOf(options.env), query: options.search, results }, null, 2)}\n`
      : renderSearchText(options.search, results);
  }

  const identity = releaseIdentityOf(options.env);
  if (options.json === true) {
    return `${JSON.stringify({ release: identity, catalog: model }, null, 2)}\n`;
  }
  return renderCatalogText(model, identity);
}

function renderSearchText(query: string, results: readonly CatalogSearchHit[]): string {
  const lines: string[] = [];
  lines.push(`Matches for "${query}"`);
  lines.push("");
  if (results.length === 0) {
    lines.push("  (no matches)");
    return `${lines.join("\n")}\n`;
  }
  const width = Math.max(...results.map((result) => result.name.length));
  for (const result of results) {
    const where = result.group === null ? "" : `  [${result.group}]`;
    lines.push(`  ${result.name.padEnd(width)}  ${result.summary}${where}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Release identity for the active registry home, when the artifact layout
 * provides one. Returns a stable placeholder when it does not, so catalog
 * output never claims an identity it cannot prove.
 */
function releaseIdentityOf(env: Record<string, string | undefined>): { digest: string; hubId: string } {
  const home = env.EGA_SKILLS_HOME ?? "";
  try {
    const release = JSON.parse(readFileSync(resolvePath(home, "hub-release.json"), "utf8")) as {
      digest?: string;
      payload?: { hub_id?: string };
    };
    return { digest: release.digest ?? "unknown", hubId: release.payload?.hub_id ?? "unknown" };
  } catch {
    return { digest: "unknown", hubId: "unknown" };
  }
}

/**
 * Prefer the release-scoped FTS table for a verified artifact registry, exactly
 * as the hosted MCP runtime does (`release_fts_<digest>`), and fall back to the
 * default table for an ordinary local registry. This keeps `catalog --search`
 * on the same verified projection the runtime searches rather than on a
 * convenience table that release verification does not cover.
 */
function resolveFtsTable(env: Record<string, string | undefined>, db: unknown): string | undefined {
  const { digest } = releaseIdentityOf(env);
  if (digest === "unknown") return undefined;
  const table = `release_fts_${digest.slice("sha256:".length)}`;
  const typed = db as { prepare(sql: string): { get(...params: unknown[]): unknown } };
  const exists = typed
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return exists === undefined ? undefined : table;
}