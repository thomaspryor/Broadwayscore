// BRO-6743: checkpoint survival is necessary for timeout recovery, but does
// not guarantee the cancelled job uploads its artifact. These tests cover the
// existing helper contract, not recovery when that artifact is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { recordDeferredShows, collectDeferredShows, redispatchPlan, unreportedShardShows } = require('./gather-deferred.js');
const helperPath = require.resolve('./gather-deferred.js');
const assigned = [
  'building-the-wall-off-broadway-2017',
  'the-lost-boys-2026',
  'hadestown-west-end-2024',
];

for (const signal of ['SIGTERM', 'SIGKILL']) {
  for (const { name, checkpoint, expectedPlan } of [
    {
      name: 'first show still in flight',
      checkpoint: assigned,
      expectedPlan: { shows: [], stalled: true },
    },
    {
      name: 'one finished, one in flight, one unreached',
      checkpoint: ['the-lost-boys-2026', 'hadestown-west-end-2024'],
      expectedPlan: { shows: ['the-lost-boys-2026', 'hadestown-west-end-2024'], stalled: false },
    },
    {
      name: 'all shows finished before termination',
      checkpoint: [],
      expectedPlan: { shows: [], stalled: false },
    },
  ]) {
    test(`${signal}: ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'gather-deferred-'));
      try {
        const file = join(dir, 'deferred-shows.txt');
        // Call the real writer in a process that cannot run graceful cleanup.
        // The supplied checkpoint represents the gather caller's last write.
        const child = spawnSync(process.execPath, ['-e', `
          const { recordDeferredShows } = require(process.argv[1]);
          recordDeferredShows(JSON.parse(process.argv[2]));
          recordDeferredShows(JSON.parse(process.argv[3]));
          process.kill(process.pid, process.argv[4]);
        `, helperPath, JSON.stringify(assigned), JSON.stringify(checkpoint), signal], {
          env: { ...process.env, GATHER_DEFERRED_FILE: file },
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.ifError(child.error);
        assert.equal(child.signal, signal, child.stderr);
        const deferred = collectDeferredShows([readFileSync(file, 'utf8')]);
        assert.deepEqual(deferred, checkpoint);
        assert.deepEqual(redispatchPlan(deferred, assigned.join(',')), expectedPlan);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('follow-up merges partial shards and clears a completed checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gather-deferred-'));
  try {
    const file = join(dir, 'deferred-shows.txt');
    assert.equal(recordDeferredShows(assigned, file), true);
    assert.equal(recordDeferredShows([], file), false);
    assert.equal(readFileSync(file, 'utf8'), '');
    const deferred = collectDeferredShows([
      readFileSync(file, 'utf8'),
      'the-lost-boys-2026\nhadestown-west-end-2024\n',
      ' hadestown-west-end-2024, the-lost-boys-2026\n',
      '--flag\nBad ID\n$(false)\n',
    ]);
    assert.deepEqual(deferred, ['the-lost-boys-2026', 'hadestown-west-end-2024']);
    assert.deepEqual(redispatchPlan(deferred, assigned.join(',')), { shows: deferred, stalled: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no-progress guard compares IDs across shards regardless of order', () => {
  const deferred = collectDeferredShows([
    'hadestown-west-end-2024\n',
    'the-lost-boys-2026\nbuilding-the-wall-off-broadway-2017\n',
  ]);
  assert.deepEqual(redispatchPlan(deferred, assigned.join(',')), { shows: [], stalled: true });
});

test('BRO-6743: a shard with no uploaded list contributes its whole assignment', () => {
  const matrix = [
    { batch_id: 0, shows: 'building-the-wall-off-broadway-2017,the-lost-boys-2026', delay: 0 },
    { batch_id: 1, shows: 'hadestown-west-end-2024', delay: 30 },
    { batch_id: 2, shows: 'bad id,still-ok-2026', delay: 60 },
  ];
  assert.deepEqual(unreportedShardShows(matrix, [1]), ['building-the-wall-off-broadway-2017', 'the-lost-boys-2026', 'still-ok-2026']);
  assert.deepEqual(unreportedShardShows(matrix, ['0', '1', '2']), []);
  assert.equal(unreportedShardShows(matrix, []).length, 4);
  assert.deepEqual(unreportedShardShows(null, null), []);
});

test('BRO-6743: unreported shard shows keep the no-progress guard', () => {
  const matrix = [{ batch_id: 0, shows: assigned.join(',') }];
  const merged = collectDeferredShows(['', unreportedShardShows(matrix, []).join('\n')]);
  assert.deepEqual(redispatchPlan(merged, assigned.join(',')), { shows: [], stalled: true });
});
