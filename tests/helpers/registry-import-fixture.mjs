import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openRegistry } from "../../packages/registry/dist/index.js";

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

export async function isolatedImport(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-566-"));
  const home = join(base, "home");
  const src = join(base, "src");
  await mkdir(src, { recursive: true });
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(async () => {
    try {
      registry.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  return { registry, src };
}

export async function writeSkill(dir, name, options = {}) {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name}.\n`;
  await writeFile(join(root, "SKILL.md"), `${frontmatter(name, options.description ?? `${name} skill`)}${body}`);
  if (options.core !== undefined) await writeFile(join(root, "SKILL.core.md"), options.core);
  if (options.egaYaml !== undefined) await writeFile(join(root, "ega.yaml"), options.egaYaml);
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

export function basicYaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n${extra}`;
}
