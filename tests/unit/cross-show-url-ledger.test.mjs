// BRO-6910: the cross-show URL guard's drop ledger. Requires the real lib
// (CLAUDE.md §15); the ledger path is redirected per test via
// CROSS_SHOW_URL_LEDGER, which wins over the test-run tmpdir default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ledger = require('../../scripts/lib/cross-show-url-ledger.js');
const { findEntry } = require('../../scripts/lib/core-data-merge-registry.js');

const LEFTY = 'clifford-odets-waiting-for-lefty-off-broadway-2026';
const NYSR = 'https://nystagereview.com/2026/11/02/waiting-for-lefty-no-no-odets/';

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'csu-ledger-'));
  const file = join(dir, 'ledger.jsonl');
  const prev = process.env.CROSS_SHOW_URL_LEDGER;
  process.env.CROSS_SHOW_URL_LEDGER = file;
  try { return fn(file); } finally {
    if (prev === undefined) delete process.env.CROSS_SHOW_URL_LEDGER; else process.env.CROSS_SHOW_URL_LEDGER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a drop is recorded once per (show, url) across repeated gather passes', () => withLedger((file) => {
  const row = { showId: LEFTY, url: NYSR, outletId: 'nysr', matchedShowId: 'waiting-for-lefty-regional-2024', matchedTitle: 'Waiting for Lefty', matchedStatus: 'closed' };
  assert.equal(ledger.appendCrossShowUrlRow(row), true);
  assert.equal(ledger.appendCrossShowUrlRow(row), false);
  assert.equal(ledger.appendCrossShowUrlRow({ ...row, showId: 'other-show-2026' }), true);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].matchedStatus, 'closed');
  assert.ok(rows[0].ts);
}));

test('dedupe also honours rows already on disk from an earlier run', () => withLedger((file) => {
  writeFileSync(file, JSON.stringify({ ts: '2026-11-02T20:00:00Z', showId: 'seeded-show-2026', url: 'https://x.test/a/' }) + '\n');
  assert.equal(ledger.appendCrossShowUrlRow({ showId: 'seeded-show-2026', url: 'https://x.test/a/' }), false);
}));

test('rows without showId or url are refused', () => withLedger(() => {
  assert.equal(ledger.appendCrossShowUrlRow({ showId: LEFTY }), false);
  assert.equal(ledger.appendCrossShowUrlRow(null), false);
}));

test('readCrossShowUrlRows filters by show and skips corrupt lines', () => withLedger((file) => {
  writeFileSync(file, [
    JSON.stringify({ ts: '2026-11-02T20:00:00Z', showId: LEFTY, url: NYSR }),
    '{not json',
    JSON.stringify({ ts: '2026-11-02T21:00:00Z', showId: 'b-2026', url: 'https://x.test/b/' }),
  ].join('\n') + '\n');
  assert.deepEqual(ledger.readCrossShowUrlRows({ showId: LEFTY }).map(r => r.url), [NYSR]);
  assert.equal(ledger.readCrossShowUrlRows().length, 2);
  assert.equal(ledger.readCrossShowUrlRows({ since: '2026-11-02T20:30:00Z' }).length, 1);
}));

test('merge unions parallel writers by (show, url), ours wins on a tie', () => {
  const ours = [{ ts: '1', showId: 'a', url: 'u1', source: 'ours' }];
  const remote = [{ ts: '2', showId: 'a', url: 'u1', source: 'remote' }, { ts: '3', showId: 'a', url: 'u2' }];
  const { merged, stats } = ledger.mergeCrossShowUrlLedger(ours, remote);
  assert.deepEqual(merged.map(r => r.url), ['u1', 'u2']);
  assert.equal(merged[0].source, 'ours');
  assert.deepEqual(stats, { added: 1, kept: 1, total: 2 });
});

test('the ledger is registered for union merge on both push paths', () => {
  const e = findEntry('audit/cross-show-url-holds.jsonl');
  assert.ok(e, 'registry entry missing');
  assert.equal(e.status, 'active');
  assert.equal(e.merge, ledger.mergeCrossShowUrlLedger);
  assert.equal(e.apiFallbackMerge, true);
});
