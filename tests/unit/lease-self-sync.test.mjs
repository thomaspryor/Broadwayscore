// 2026-11-17: fetch-guardian-reviews.yml rebuilt reviews.json with no lease file (it never ran the
// opening-night-lease-sync action), read "nothing leased" and wiped the-fantasticks-2026's 20 lane-written
// reviews on its press night. rebuild-all-reviews.js now self-syncs when a CI job left the file missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const guard = require(path.join(ROOT, 'scripts/lib/opening-night-lane/lease-guard.js'));
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-self-sync-')), 'leases.json');
const LEASED = (show) => JSON.stringify({ leases: { [`${show}|2026-11-16`]: { holder: 'gha-lane', expiresAt: new Date(Date.now() + 3600e3).toISOString() } } });

test('CI with no lease file: runs the sync, then the publish view names the leased show', () => {
  const file = tmpFile();
  let ran = 0;
  const r = guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true' }, run: () => { ran++; fs.writeFileSync(file, LEASED('the-fantasticks-2026')); } });
  assert.equal(r, 'synced');
  assert.equal(ran, 1);
  assert.deepEqual(guard.leasedShowIds({ file, env: {} }), ['the-fantasticks-2026']);
});

test('CI, sync throws and writes nothing: the unknown marker is written, never a silent "nothing leased" file', () => {
  const file = tmpFile();
  const r = guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true', OPENING_NIGHT_SHOWS_FILE: '/nonexistent' }, run: () => { throw new Error('no network'); } });
  assert.equal(r, 'unknown');
  assert.equal(guard.readUnknownMarker(file), true);
});

test('file already present (the action ran) or off CI: no sync', () => {
  const file = tmpFile();
  fs.writeFileSync(file, LEASED('x-2026'));
  assert.equal(guard.syncIfMissing({ file, env: { GITHUB_ACTIONS: 'true' }, run: () => assert.fail('must not sync') }), 'present');
  const missing = tmpFile();
  assert.equal(guard.syncIfMissing({ file: missing, env: {}, run: () => assert.fail('must not sync') }), 'not-ci');
  assert.equal(fs.existsSync(missing), false);
});

test('structural: rebuild-all-reviews self-syncs before it reads the publish view', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const syncAt = src.indexOf('leaseGuard.syncIfMissing()');
  const readAt = src.indexOf('leaseGuard.leasedShowIds()');
  assert.ok(syncAt > 0 && readAt > syncAt, 'syncIfMissing() must run before leasedShowIds()');
});

test('structural: every workflow that runs rebuild-all-reviews either syncs leases or relies on the self-sync (listed)', () => {
  // Auto-discovered, so a new workflow cannot slip past a hand-kept list. The self-sync covers the rest; this
  // records which workflows lean on it so a removal of syncIfMissing shows up here too.
  const dir = path.join(ROOT, '.github/workflows');
  const unsynced = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).filter((f) => {
    const y = fs.readFileSync(path.join(dir, f), 'utf8');
    return /rebuild-all-reviews\.js/.test(y) && !/opening-night-lease-sync|opening-night-lease\.js"? sync/.test(y);
  });
  assert.ok(unsynced.includes('fetch-guardian-reviews.yml'), `scan is stale: ${unsynced.join(', ')}`);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8'), /leaseGuard\.syncIfMissing\(\)/,
    `${unsynced.length} workflows rebuild without a lease sync step; the script's self-sync is their only guard`);
});

// ------------------------------------------------------------ lane rows survive until their texts arrive
const { orphanLaneRows } = require(path.join(ROOT, 'scripts/lib/opening-night-lane/orphan-lane-rows.js'));
const NOW_ON = Date.parse('2026-11-17T06:00:00Z');
const laneRow = (outletId, seenAt = '2026-11-17T03:00:00.000Z') => ({
  showId: 'the-fantasticks-2026', outletId, outlet: outletId, productionVerified: 'aggregator',
  openingNightLane: { show: 'the-fantasticks-2026', night: '2026-11-16', source: 'aggregator', seenAt },
});

test('orphanLaneRows: an unleased lane row with no review-text yet is kept; one whose text arrived is not', () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-rt-'));
  fs.mkdirSync(path.join(rt, 'the-fantasticks-2026'));
  fs.writeFileSync(path.join(rt, 'the-fantasticks-2026', 'theatrely--kobi-kassal.json'), '{}');
  const existing = [laneRow('nytimes'), laneRow('theatrely'), { showId: 'the-fantasticks-2026', outletId: 'vulture' } /* not a lane row */];
  const kept = orphanLaneRows(existing, [], { reviewTextsDir: rt, now: NOW_ON });
  assert.deepEqual(kept.map((r) => r.outletId), ['nytimes']);
});

test('orphanLaneRows: rebuilt row for the same outlet, a leased show, or a lane row older than 7 days is not carried', () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-rt-'));
  assert.equal(orphanLaneRows([laneRow('nytimes')], [{ showId: 'the-fantasticks-2026', outletId: 'nytimes' }], { reviewTextsDir: rt, now: NOW_ON }).length, 0);
  assert.equal(orphanLaneRows([laneRow('nytimes')], [], { reviewTextsDir: rt, now: NOW_ON, leased: new Set(['the-fantasticks-2026']) }).length, 0);
  assert.equal(orphanLaneRows([laneRow('nytimes')], [], { reviewTextsDir: rt, now: NOW_ON + 8 * 86400e3 }).length, 0);
});

test('structural: rebuild-all-reviews carries orphan lane rows after the lease carry-over and before the aggregate write', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const leaseAt = src.indexOf('[LEASE CARRY-OVER]');
  const orphanAt = src.indexOf('orphanLaneRows(');
  const writeAt = src.indexOf('fs.writeFileSync(reviewsTmpPath');
  assert.ok(leaseAt > 0 && orphanAt > leaseAt && writeAt > orphanAt, 'lease carry-over, then orphan lane rows, then write');
});
