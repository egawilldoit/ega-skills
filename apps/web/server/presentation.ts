/**
 * Human-intent presentation groups for category browsing (EGA-724 repair).
 *
 * This module is a PROJECTION, never a second catalog:
 *
 *     release `skill_versions` + `catalog/presentation.yaml` -> group membership
 *
 * - The release's OWN `skill_id -> version_hash` map is the authority. Every
 *   member listed in the presentation file must exist in that map, or the
 *   catalog refuses with `E_WEB_CATALOG_INCOMPLETE` rather than serving a
 *   partial view. An unknown group filter matches zero rows (recoverable),
 *   never an error.
 * - Presentation metadata is NON-AUTHORITATIVE: this module rejects any
 *   routing key (`triggers`, `domains`, `platforms`, `frameworks`, `aliases`,
 *   `anti_triggers` and separator-insensitive variants) anywhere in the
 *   document, mirroring `packages/cli/src/catalog.ts`. Editing a label can
 *   never change routing or Hub identity.
 * - Membership resolution reuses the existing catalog reader/filter path:
 *   `catalog.ts` filters its own rows by the member set returned here. There
 *   is no parallel enumeration — no second SQLite read, no second registry.
 *
 * The presentation file is located by walking well-known candidates (the
 * artifact directory's repo root, the process working directory). When no
 * file is found the groups facet is empty and the axis hides, exactly like a
 * sparse `domains` facet — the catalog stays servable.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { CatalogError } from "./catalog.ts";
import type { ServerConfig } from "./env.ts";

/** One presentation group: an id plus its released member skill ids. */
export interface PresentationGroup {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly skills: readonly string[];
}

/** Validated group membership for one release. */
export interface PresentationMembership {
  readonly groups: readonly PresentationGroup[];
  /** `group id -> member skill ids` (authored order, frozen). */
  readonly byGroup: ReadonlyMap<string, ReadonlySet<string>>;
  /** `skill id -> group ids containing it` (authored order, frozen). */
  readonly bySkill: ReadonlyMap<string, readonly string[]>;
}

/** Empty membership: no presentation file, so no group axis. */
const EMPTY_MEMBERSHIP: PresentationMembership = Object.freeze({
  groups: Object.freeze([]),
  byGroup: new Map(),
  bySkill: new Map(),
}) as PresentationMembership;

/**
 * Routing keys presentation metadata must never carry, in normalized form.
 *
 * Mirrors `FORBIDDEN_PRESENTATION_KEYS` in `packages/cli/src/catalog.ts`:
 * compared case/separator-insensitively so `antiTriggers` matches
 * `anti_triggers`.
 */
const FORBIDDEN_KEYS = [
  "triggers",
  "antitriggers",
  "domains",
  "platforms",
  "frameworks",
  "aliases",
  "triggerphrases",
  "keywords",
] as const;

const CANONICAL_SKILL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const GROUP_ID_RE = /^[a-z0-9][a-z0-9-]*$/u;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/gu, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject routing authority anywhere in the presentation document. */
function assertNoRoutingKeys(node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertNoRoutingKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(normalizeKey(key))) {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        `The presentation metadata at ${path}.${key} carries routing key "${key}": presentation is not routing authority. Refusing to present a partial catalog.`,
        503,
      );
    }
    assertNoRoutingKeys(value, `${path}.${key}`);
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Candidate locations for `catalog/presentation.yaml`, in priority order.
 *
 * 1. The artifact directory's repo root (`packages/mcp/artifact` -> root).
 * 2. The process working directory's `catalog/presentation.yaml` (tests and
 *    deployments that run from the repo root).
 * 3. Walking up from the working directory (nested invocations).
 */
function candidatePaths(config?: Readonly<ServerConfig>): readonly string[] {
  const candidates: string[] = [];
  if (config?.artifactDir) {
    // `packages/mcp/artifact` is three levels below the root.
    candidates.push(resolve(config.artifactDir, "..", "..", "..", "catalog", "presentation.yaml"));
  }
  const cwd = process.cwd();
  candidates.push(resolve(cwd, "catalog", "presentation.yaml"));
  let dir = cwd;
  for (let depth = 0; depth < 4; depth += 1) {
    dir = dirname(dir);
    candidates.push(resolve(dir, "catalog", "presentation.yaml"));
  }
  return [...new Set(candidates)];
}

/** First existing candidate, or `null` when no presentation file is present. */
export function resolvePresentationPath(config?: Readonly<ServerConfig>): string | null {
  for (const candidate of candidatePaths(config)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load and validate group membership against the release's own skill ids.
 *
 * `knownSkillIds` is the release's authoritative member set (the same map the
 * namespace axis is validated against). Every member of every group must be a
 * canonical id present in that set; a stale reference is a fail-closed
 * `E_WEB_CATALOG_INCOMPLETE`, never a silent drop.
 *
 * A missing presentation file yields empty membership (no group axis) rather
 * than an error, so deployments without the file stay servable.
 */
export function loadPresentationMembership(
  knownSkillIds: ReadonlySet<string>,
  config?: Readonly<ServerConfig>,
): PresentationMembership {
  const path = resolvePresentationPath(config);
  if (path === null) return EMPTY_MEMBERSHIP;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return EMPTY_MEMBERSHIP;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) as unknown;
  } catch (error) {
    throw new CatalogError(
      "E_WEB_CATALOG_INCOMPLETE",
      `The presentation metadata cannot be parsed: ${error instanceof Error ? collapse(error.message) : "invalid YAML"}. Refusing to present a partial catalog.`,
      503,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CatalogError(
      "E_WEB_CATALOG_INCOMPLETE",
      "The presentation metadata is not a YAML mapping. Refusing to present a partial catalog.",
      503,
    );
  }
  if (parsed["catalog_version"] !== 1) {
    throw new CatalogError(
      "E_WEB_CATALOG_INCOMPLETE",
      "The presentation metadata has an unsupported catalog_version. Refusing to present a partial catalog.",
      503,
    );
  }
  assertNoRoutingKeys(parsed);

  const rawGroups = parsed["groups"];
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
    throw new CatalogError(
      "E_WEB_CATALOG_INCOMPLETE",
      "The presentation metadata has no groups. Refusing to present a partial catalog.",
      503,
    );
  }

  const groups: PresentationGroup[] = [];
  const byGroup = new Map<string, ReadonlySet<string>>();
  const bySkill = new Map<string, string[]>();
  const seenGroupIds = new Set<string>();

  for (const entry of rawGroups) {
    if (!isPlainObject(entry)) {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        "A presentation group is not a YAML mapping. Refusing to present a partial catalog.",
        503,
      );
    }
    const { id, title, blurb, skills } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !GROUP_ID_RE.test(id)) {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        "A presentation group id is not a lowercase alphanumeric identifier. Refusing to present a partial catalog.",
        503,
      );
    }
    if (seenGroupIds.has(id)) {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        `The presentation metadata lists group "${id}" twice. Refusing to present a partial catalog.`,
        503,
      );
    }
    seenGroupIds.add(id);
    if (typeof title !== "string" || collapse(title) === "") {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        `Presentation group "${id}" has no title. Refusing to present a partial catalog.`,
        503,
      );
    }
    if (blurb !== undefined && typeof blurb !== "string") {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        `Presentation group "${id}" has a non-string blurb. Refusing to present a partial catalog.`,
        503,
      );
    }
    if (!Array.isArray(skills) || skills.length === 0) {
      throw new CatalogError(
        "E_WEB_CATALOG_INCOMPLETE",
        `Presentation group "${id}" lists no skills. Refusing to present a partial catalog.`,
        503,
      );
    }
    const members = new Set<string>();
    for (const skillId of skills) {
      if (typeof skillId !== "string" || !CANONICAL_SKILL_ID.test(skillId)) {
        throw new CatalogError(
          "E_WEB_CATALOG_INCOMPLETE",
          `Presentation group "${id}" lists "${String(skillId)}", which is not a canonical skill id. Refusing to present a partial catalog.`,
          503,
        );
      }
      if (!knownSkillIds.has(skillId)) {
        throw new CatalogError(
          "E_WEB_CATALOG_INCOMPLETE",
          `The presentation metadata lists ${skillId} in group "${id}", but the verified release does not contain it. Refusing to present a partial catalog.`,
          503,
        );
      }
      if (members.has(skillId)) {
        throw new CatalogError(
          "E_WEB_CATALOG_INCOMPLETE",
          `Presentation group "${id}" lists ${skillId} twice. Refusing to present a partial catalog.`,
          503,
        );
      }
      members.add(skillId);
      const existing = bySkill.get(skillId);
      if (existing === undefined) bySkill.set(skillId, [id]);
      else existing.push(id);
    }
    groups.push(
      Object.freeze({
        id,
        title: collapse(title),
        blurb: typeof blurb === "string" ? collapse(blurb) : "",
        skills: Object.freeze([...members].sort()),
      }),
    );
    byGroup.set(id, Object.freeze(new Set(members)) as ReadonlySet<string>);
  }

  return Object.freeze({
    groups: Object.freeze(groups),
    byGroup,
    bySkill,
  });
}
