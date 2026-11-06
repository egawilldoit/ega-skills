/**
 * Model-visible usage guidance for the four-tool MCP surface (EGA-827).
 *
 * Delivered through the standard MCP `initialize` `instructions` field, which
 * is separate from the per-tool descriptions and their frozen metadata budget.
 * It only describes existing metadata, handoffs, and limits: no new tool, no
 * schema field, and no runtime behavior.
 */
export const MCP_USAGE_INSTRUCTIONS = [
  "EGA Skills is a read-only skill catalog. Use search for keyword discovery when you have terms; triggers are positive use signals and anti_triggers are reasons not to select a skill.",
  "Use resolve for task-based selection; it returns selected or candidate skills with version_hash. Neither search nor resolve executes a skill or returns L2 content.",
  "Use inspect to read one discovered version's metadata, manifest, trust, token sizes, and sources without L1/L2 bodies.",
  "Use get_content only after deciding to use a skill. Pass the exact skill_id, version_hash, level, and max_tokens; hosted calls also need the exact effective_release_digest or an authorized context_id. Content is version-pinned and never falls back to another version.",
  "These are recommendations. Clients may ignore or hide them, so never assume discovery executed a skill or that content was loaded unless get_content returned it.",
].join(" ");
