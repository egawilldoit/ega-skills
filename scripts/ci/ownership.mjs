import { globSync, readFileSync } from 'node:fs';

// Node 24's default test-runner glob (including its default type stripping).
const pattern = '**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}';
export const manifest = JSON.parse(readFileSync(new URL('./test-ownership.json', import.meta.url), 'utf8'));
export function discover() {
  return globSync(pattern, { exclude: ['node_modules', '**/node_modules/**'] }).map(p => p.replaceAll('\\', '/')).sort();
}
export function validateOwnership(discovered, groups) {
  if (!groups || Object.keys(groups).sort().join(',') !== 'core,web') throw new Error('Expected core and web ownership groups');
  const owners = new Map();
  for (const [group, files] of Object.entries(groups)) {
    if (!Array.isArray(files) || files.length === 0) throw new Error(`Empty or invalid ${group} ownership`);
    for (const file of files) {
      if (typeof file !== 'string' || owners.has(file)) throw new Error(`Duplicate or invalid test owner: ${file}`);
      owners.set(file, group);
    }
  }
  const actual = new Set(discovered);
  const missing = discovered.filter(file => !owners.has(file));
  const stale = [...owners.keys()].filter(file => !actual.has(file));
  if (missing.length || stale.length) throw new Error(`Update test ownership: unowned=${missing.join(', ')}; missing=${stale.join(', ')}`);
}
export function ownedFiles(group) {
  validateOwnership(discover(), manifest);
  if (!Object.hasOwn(manifest, group)) throw new Error(`Unknown test group: ${group}`);
  return manifest[group];
}
