import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These cases exercise the bounded runner's own contract. Every nested run uses an
// explicit trivial test file and never `--ci-scope`, so it cannot fan out into the
// full suite or recurse into this file.
const runner = 'scripts/release/run-tests-bounded.mjs';

function withTrivialTest(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ega-bounded-'));
  try {
    const file = join(dir, 'trivial.test.mjs');
    writeFileSync(file, "import { test } from 'node:test';\ntest('trivial', () => {});\n");
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function invoke(file, { env = {}, args = [] } = {}) {
  const base = { ...process.env };
  delete base.EGA_TEST_CONCURRENCY;
  delete base.EGA_TEST_PER_TEST_TIMEOUT_MS;
  delete base.EGA_TEST_OVERALL_TIMEOUT_MS;
  // Node's outer test runner marks its child with NODE_TEST_CONTEXT. Inheriting it
  // would make the nested `node --test` refuse to run files, which would silently
  // turn every case below into a no-op.
  delete base.NODE_TEST_CONTEXT;
  delete base.NODE_OPTIONS;
  return spawnSync(process.execPath, [runner, ...args, file], {
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function runtimeLine(stderr) {
  const line = stderr.split('\n').find((entry) => entry.startsWith('[test:bounded] runtime '));
  assert.ok(line, `runtime line missing from: ${stderr}`);
  return JSON.parse(line.slice('[test:bounded] runtime '.length));
}

test('bounded runner keeps Node default concurrency when no value is requested', () => {
  withTrivialTest((file) => {
    const run = invoke(file);
    assert.equal(run.status, 0, run.stderr);
    const runtime = runtimeLine(run.stderr);
    assert.equal(runtime.testConcurrencySource, 'default (availableParallelism - 1)');
    assert.equal(runtime.availableParallelism, runtime.cpuCount);
    assert.ok(runtime.testConcurrency >= 1);
    assert.doesNotMatch(run.stderr, /--test-concurrency=/);
  });
});

test('bounded runner forwards a validated explicit concurrency and logs its source', () => {
  withTrivialTest((file) => {
    const run = invoke(file, { env: { EGA_TEST_CONCURRENCY: '2' } });
    assert.equal(run.status, 0, run.stderr);
    const runtime = runtimeLine(run.stderr);
    assert.equal(runtime.testConcurrency, 2);
    assert.equal(runtime.testConcurrencySource, 'EGA_TEST_CONCURRENCY');
    assert.match(run.stderr, /--test-concurrency=2/);
  });
});

test('bounded runner rejects invalid, out-of-range and conflicting concurrency without running tests', () => {
  withTrivialTest((file) => {
    for (const value of ['0', 'abc', '-1', '1.5', '99', ' 2', '2 3']) {
      const run = invoke(file, { env: { EGA_TEST_CONCURRENCY: value } });
      assert.notEqual(run.status, 0, `value ${JSON.stringify(value)} must fail`);
      assert.doesNotMatch(run.stdout, /trivial/, `value ${JSON.stringify(value)} must not run tests`);
    }
    const viaArg = invoke(file, { args: ['--test-concurrency=2'] });
    assert.equal(viaArg.status, 0, viaArg.stderr);
    assert.equal(runtimeLine(viaArg.stderr).testConcurrencySource, 'flag');
    const conflict = invoke(file, { args: ['--test-concurrency=2'], env: { EGA_TEST_CONCURRENCY: '3' } });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /conflicts with --test-concurrency/);
  });
});

test('bounded runner preserves the per-test timeout, overall bound and exit-code passthrough', () => {
  withTrivialTest((file) => {
    const ok = invoke(file);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /--test-timeout=600000/);
    assert.match(ok.stderr, /per-test timeout 600000 ms, overall bound 1500000 ms/);

    const failing = invoke(file, { args: ['--per-test-timeout-ms=1234'] });
    assert.equal(failing.status, 0, failing.stderr);
    assert.match(failing.stderr, /--test-timeout=1234/);

    const dir = mkdtempSync(join(tmpdir(), 'ega-bounded-fail-'));
    try {
      const file = join(dir, 'failing.test.mjs');
      writeFileSync(file, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => { assert.equal(1, 2); });\n");
      const run = invoke(file);
      assert.equal(run.status, 1, 'a failing test must exit non-zero');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
