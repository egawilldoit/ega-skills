import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function classify(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 300 || entries.some(e => e.status !== 'M' || typeof e.path !== 'string')) return {mode:'full', reason:'uncertain, added, deleted, renamed, or large diff'};
  if (entries.every(e => e.path === 'README.md')) return {mode:'docs', reason:'README only'};
  if (entries.every(e => e.path === 'README.md' || /^apps\/web\/src\/components\/(?:StatCard|Icon|Disclosure|format)\.(?:ts|tsx)$/.test(e.path))) return {mode:'web', reason:'display component and README only'};
  return {mode:'full', reason:'shared, security, or unclassified changes'};
}

export function gate(mode, results) {
  const required = {docs:['classify','docs'], web:['classify','docs','foundation','web'], full:['classify','docs','foundation','web','isolation','rls']}[mode];
  return Boolean(required && required.every(name => results[name] === 'success'));
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
    const normalized = Object.fromEntries(Object.entries(results).map(([k,v]) => [k,v?.result]));
    if (!gate(process.env.CI_MODE, normalized)) { console.error('ci-gate: required job missing or not successful', normalized); process.exit(1); }
    console.log('ci-gate: selected jobs succeeded');
  } else {
    const selected = select();
    console.log(JSON.stringify(selected));
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT missing');
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${selected.mode}\nreason=${selected.reason}\n`);
  }
}
