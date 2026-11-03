import { createHash } from "node:crypto";

export const MAX_SHARDS = 8;

// Partitioning is computed here rather than delegated to Node's `--test-shard` so the
// exact selection can be enumerated, hashed and checked for completeness inside every
// shard. The distribution matches Node's: sorted file i goes to shard (i % n) + 1.
export function buildShardPartitions(files, count) {
  const partitions = Array.from({ length: count }, () => []);
  files.forEach((file, position) => {
    partitions[position % count].push(file);
  });
  return partitions;
}

export function parseShard(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const match = String(raw).match(/^(\d+)\/(\d+)$/);
  if (!match) throw new Error(`--shard must look like i/n, got ${JSON.stringify(raw)}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 2 || count > MAX_SHARDS) {
    throw new Error(`--shard count must be between 2 and ${MAX_SHARDS}, got ${count}`);
  }
  if (index < 1 || index > count) {
    throw new Error(`--shard index must be between 1 and ${count}, got ${index}`);
  }
  return { index, count };
}

// Fails closed if a file is assigned twice or left out. It runs in every shard, so a
// single job proves the whole partition is complete and disjoint.
export function assertPartitionComplete(files, partitions) {
  const assigned = new Set();
  for (const partition of partitions) {
    for (const file of partition) {
      if (assigned.has(file)) throw new Error(`duplicate shard assignment: ${file}`);
      assigned.add(file);
    }
  }
  const missing = files.filter((file) => !assigned.has(file));
  if (missing.length > 0) throw new Error(`unassigned test files: ${missing.join(", ")}`);
  if (assigned.size !== files.length) {
    throw new Error(`shard union has ${assigned.size} files but discovery has ${files.length}`);
  }
  return { files: assigned.size, partitions: partitions.length };
}

export function digest(list) {
  return createHash("sha256").update(list.join("\n")).digest("hex");
}

// The single description of a shard selection that the runner logs and publishes, and
// that the aggregator re-derives from the repository to prove the executed set.
export function describeShard({ index, count, files, fullFiles }) {
  return {
    index,
    count,
    files: files.length,
    fullFiles: fullFiles.length,
    selectionDigest: digest(files),
    fullDigest: digest(fullFiles),
  };
}
