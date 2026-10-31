/** Derive editable interface suggestions without introducing generator-unsafe characters. */
export function sourceInterfaceDefaults(name: string, description: string) {
  const safe = (value: string) => value.replace(/["\\\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  const displayName = safe(name.replace(/-/g, ' ')).replace(/\b[a-z]/g, letter => letter.toUpperCase()).slice(0, 128);
  let shortDescription = safe(description).slice(0, 64).trim();
  if (shortDescription.length < 25) shortDescription = safe(`Guidance and practical steps for ${name.replace(/-/g, ' ')}`).slice(0, 64).trim();
  const prompt = `Use $${name} to help with this task.`;
  return { displayName, shortDescription, prompt };
}

/** Match the source catalog's slug and plugin identity length limits. */
export function sourceSkillSlug(label: string): string {
  return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 53).replace(/-+$/g, '');
}
