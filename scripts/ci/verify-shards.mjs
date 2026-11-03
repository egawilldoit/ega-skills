import { pathToFileURL } from 'node:url';
import { discover, manifest, validateOwnership } from './ownership.mjs';
import { assertPartitionComplete, buildShardPartitions, describeShard } from './sharding.mjs';

// Proves the shard jobs that actually ran together cover the repository's discovery
// exactly once. It re-derives the partition from the checked-in inventory and
// compares it with the metadata each shard published, so a missing, duplicated,
// failed, cancelled, skipped or drifted shard fails closed. `needs` is not
// transitive, which is why `ci-gate` also lists the shard jobs directly.

export function verifyShards({ needs, jobs, count, scope, inventory }) {
  const fail = (message, detail) => ({ ok: false, message, detail });

  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) return fail('CI_NEEDS is not an object');
  if (!Array.isArray(jobs) || jobs.length === 0) return fail('shard job list must be a non-empty array');
  if (!Number.isInteger(count) || count < 2) return fail('shard count must be an integer >= 2');
  if (jobs.length !== count) return fail(`expected ${count} shard jobs, got ${jobs.length}`, jobs);
  if (!Array.isArray(inventory) || inventory.length === 0) return fail(`no test files for scope ${JSON.stringify(scope)}`);

  const fullInventory = inventory.slice().sort();
  const partitions = buildShardPartitions(fullInventory, count);
  try {
    assertPartitionComplete(fullInventory, partitions);
  } catch (error) {
    return fail(error.message);
  }
  const expected = partitions.map((files, position) =>
    describeShard({ index: position + 1, count, files, fullFiles: fullInventory }),
  );

  const seen = new Set();
  const summary = [];
  for (const job of jobs) {
    const entry = needs[job];
    if (!entry || typeof entry !== 'object') return fail(`${job} is missing from the gate's needs`);
    if (entry.result !== 'success') return fail(`${job} did not succeed`, { result: entry.result });
    const outputs = entry.outputs ?? {};
    const index = Number(outputs.shard_index);
    if (!Number.isInteger(index) || index < 1 || index > count) {
      return fail(`${job} reported an invalid shard index`, outputs.shard_index);
    }
    if (seen.has(index)) return fail(`shard ${index} reported more than once`, { job });
    seen.add(index);
    const want = expected[index - 1];
    const reported = {
      count: Number(outputs.shard_count),
      files: Number(outputs.shard_files),
      fullFiles: Number(outputs.shard_full_files),
      selectionDigest: outputs.shard_selection_digest,
      fullDigest: outputs.shard_full_digest,
      scope: outputs.shard_scope,
    };
    for (const key of ['count', 'files', 'fullFiles', 'selectionDigest', 'fullDigest']) {
      if (reported[key] !== want[key]) {
        return fail(`${job} shard ${index} ${key} does not match the repository partition`, {
          expected: want[key],
          reported: reported[key],
        });
      }
    }
    if (String(reported.scope) !== String(scope ?? 'unscoped')) {
      return fail(`${job} reported scope ${JSON.stringify(reported.scope)}`, { expected: scope ?? 'unscoped' });
    }
    summary.push(`${job}=${index}/${count}:${want.files}f`);
  }

  if (seen.size !== count) {
    return fail(`shard indices present ${[...seen].sort().join(',')} but expected 1..${count}`);
  }

  const union = partitions.reduce((total, partition) => total + partition.length, 0);
  return {
    ok: true,
    message:
      `${summary.join(' ')} union=${union}/${fullInventory.length} ` +
      `fullDigest=${expected[0].fullDigest.slice(0, 12)} scope=${scope ?? 'unscoped'}`,
  };
}

function main() {
  const readJson = (name) => {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '') return { error: `${name} missing` };
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return { error: `${name} is not valid JSON` };
    }
  };
  const needs = readJson('CI_NEEDS');
  const jobs = readJson('CI_SHARD_JOBS');
  if (needs.error) return finish({ ok: false, message: needs.error });
  if (jobs.error) return finish({ ok: false, message: jobs.error });

  const scope = process.env.CI_SHARD_SCOPE || null;
  let inventory;
  try {
    const discovered = discover();
    validateOwnership(discovered, manifest);
    inventory = scope ? manifest[scope] : discovered;
  } catch (error) {
    return finish({ ok: false, message: `inventory unavailable: ${error.message}` });
  }

  return finish(
    verifyShards({
      needs: needs.value,
      jobs: jobs.value,
      count: Number(process.env.CI_SHARD_COUNT),
      scope,
      inventory,
    }),
  );
}

function finish(result) {
  if (!result.ok) {
    console.error(`verify-shards: ${result.message}`, result.detail ?? '');
    process.exit(1);
  }
  console.log(`verify-shards: ${result.message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
