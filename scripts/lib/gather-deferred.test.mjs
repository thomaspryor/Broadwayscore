// BRO-6743: checkpoint survival is necessary for timeout recovery, but does
// not guarantee the cancelled job uploads its artifact. These tests cover the
// existing helper contract, not recovery when that artifact is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { recordDeferredShows, collectDeferredShows, redispatchPlan, unreportedShardShows, readDeferredReports } = require('./gather-deferred.js');
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
    assert.equal(readFileSync(file, 'utf8'), '# done\n');
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

// BRO-6910: run 41648864401 (one shard, Waiting for Lefty) — download-artifact
// extracted the lone artifact straight into the download dir, the batch id was
// lost, and a clean run failed the step as "every show was deferred".
test('BRO-6910: a lone artifact at the download root still reports its batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-root-'));
  try {
    writeFileSync(join(dir, 'deferred-shows-0.txt'), '# done\n');
    const { texts, reported } = readDeferredReports(dir);
    assert.deepEqual(reported, ['0']);
    const matrix = [{ batch_id: 0, shows: 'clifford-odets-waiting-for-lefty-off-broadway-2026' }];
    texts.push(unreportedShardShows(matrix, reported).join('\n'));
    assert.deepEqual(redispatchPlan(collectDeferredShows(texts), matrix[0].shows), { shows: [], stalled: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-6910: the old file name at the root reproduces the false stall (why the name changed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-legacy-'));
  try {
    writeFileSync(join(dir, 'deferred-shows.txt'), '# done\n');
    const { texts, reported } = readDeferredReports(dir);
    assert.deepEqual(reported, []);
    const matrix = [{ batch_id: 0, shows: 'x-2026' }];
    texts.push(unreportedShardShows(matrix, reported).join('\n'));
    assert.equal(redispatchPlan(collectDeferredShows(texts), 'x-2026').stalled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-6910: multi-shard folders (new and legacy names) report every batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-multi-'));
  try {
    mkdirSync(join(dir, 'gather-deferred-9-1-0'));
    mkdirSync(join(dir, 'gather-deferred-9-1-1'));
    mkdirSync(join(dir, 'gather-deferred-9-1-2'));
    writeFileSync(join(dir, 'gather-deferred-9-1-0', 'deferred-shows-0.txt'), 'b-2026\n');
    writeFileSync(join(dir, 'gather-deferred-9-1-1', 'deferred-shows-1.txt'), '# done\n');
    writeFileSync(join(dir, 'gather-deferred-9-1-2', 'deferred-shows.txt'), '# done\n');
    writeFileSync(join(dir, 'gather-deferred-9-1-2', 'notes.txt'), 'ignored-2026\n');
    const { texts, reported } = readDeferredReports(dir);
    assert.deepEqual([...reported].sort(), ['0', '1', '2']);
    assert.deepEqual(collectDeferredShows(texts), ['b-2026']);
    assert.deepEqual(readDeferredReports(join(dir, 'missing')), { texts: [], reported: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
