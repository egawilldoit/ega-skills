import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Paths that can change what gets deployed or how it is gated. They always run
// the full suite, even if a future allowlist would otherwise match them.
const RELEASE_SENSITIVE = [
  /^\.github\/workflows\//,
  /^scripts\/release\//,
  /^scripts\/ci\//,
  /^scripts\/hosted\//,
  /^packages\/mcp\/artifact\//,
  /^packages\/mcp\/vercel\.json$/,
  /^packages\/mcp\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^supabase\//,
];

export function isReleaseSensitive(path) {
  return typeof path === 'string' && RELEASE_SENSITIVE.some(pattern => pattern.test(path.replace(/^\.\//, '')));
}

export function classify(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 300 || entries.some(e => e.status !== 'M' || typeof e.path !== 'string')) return {mode:'full', reason:'uncertain, added, deleted, renamed, or large diff'};
  const paths = entries.map(e => e.path.replace(/^\.\//, ''));
  if (paths.some(isReleaseSensitive)) return {mode:'full', reason:'release-sensitive path'};
  if (paths.every(path => path === 'README.md')) return {mode:'docs', reason:'README only'};
  if (paths.every(path => path === 'README.md' || /^apps\/web\/src\/components\/(?:StatCard|Icon|Disclosure|format)\.(?:ts|tsx)$/.test(path))) return {mode:'web', reason:'display component and README only'};
  return {mode:'full', reason:'shared, security, or unclassified changes'};
}

// The full job set is fixed. Requiring every key to be present (even when a mode
// does not gate on it) means adding a `needs:` entry without teaching the gate
// about it fails closed instead of silently passing.
export const MODES = Object.freeze({
  docs: ['classify', 'docs'],
  web: ['classify', 'docs', 'foundation', 'web'],
  full: ['classify', 'docs', 'foundation', 'web', 'isolation', 'rls'],
});
export const REQUIRED_JOBS = MODES.full;

export function gate(mode, results) {
  if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) return false;
  if (!results || typeof results !== 'object' || Array.isArray(results)) return false;
  const keys = Object.keys(results);
  if (keys.length !== REQUIRED_JOBS.length || !REQUIRED_JOBS.every(name => Object.hasOwn(results, name))) return false;
  return MODES[mode].every(name => results[name] === 'success');
}

function git(...args) { return execFileSync('git', args, {encoding:'utf8', maxBuffer:10_000_000}).trim(); }
function select() {
  if (process.env.CI_EVENT !== 'pull_request' || process.env.CI_BASE_REF === 'release/2.0') return {mode:'full', reason:'release, push, or manual verification'};
  try {
    if (git('rev-parse','--is-shallow-repository') !== 'false') throw new Error('shallow repository');
    const base = process.env.CI_BASE_SHA ?? '';
    const head = process.env.CI_HEAD_SHA ?? '';
    if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) throw new Error('invalid refs');
    const mergeBase = git('merge-base', base, head);
    const raw = execFileSync('git',['diff','--name-status','--no-renames','-z',mergeBase,head],{encoding:'utf8',maxBuffer:10_000_000});
    const parts = raw.split('\0');
    if (parts.pop() !== '' || parts.length % 2) throw new Error('incomplete diff');
    const entries = [];
    for (let i=0; i<parts.length; i+=2) entries.push({status:parts[i],path:parts[i+1]});
    return classify(entries);
  } catch { return {mode:'full', reason:'git history or diff unavailable'}; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'gate') {
    const results = JSON.parse(process.env.CI_NEEDS ?? '{}');
    const normalized = Object.fromEntries(Object.entries(results).map(([k,v]) => [k === 'web-isolation' ? 'isolation' : k, v?.result]));
    if (!gate(process.env.CI_MODE, normalized)) { console.error('ci-gate: required job missing or not successful', normalized); process.exit(1); }
    console.log('ci-gate: selected jobs succeeded');
  } else {
    const selected = select();
    console.log(JSON.stringify(selected));
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT missing');
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${selected.mode}\nreason=${selected.reason}\n`);
  }
}
