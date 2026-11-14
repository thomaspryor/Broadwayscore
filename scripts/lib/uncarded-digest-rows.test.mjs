// BRO-7488: advisory tripwire for digest rows listed 4+ days with no card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUncardedDigestRows, uncardedDigestRowsResult } = require('./uncarded-digest-rows.js');

const NOW = Date.parse('2026-11-14T13:50:00Z');
const snapshot = {
  errors: [],
  warns: [
    { name: 'Workflow repeat-failure: Test UGC Features / UGC Functional & Visual Tests / Run UGC tests', message: 'failed 2 times', firstSeen: '2026-11-09T09:53:09.444Z' },
    { name: 'Workflow repeat-failure: Check Performance Budget / Bundle Size Check / Build', message: 'failed 2 times', firstSeen: '2026-11-09T09:53:09.444Z' },
    { name: 'Quality: opening date vs review dates', message: 'x', firstSeen: '2026-11-11T23:31:10.176Z' }, // 3 days
    { name: 'Push-retry deadman', message: 'x', firstSeen: '1970-01-01T00:00:00.000Z' }, // legacy seed: unknown
    { name: 'Data: no clock row', message: 'x' },
  ],
};

test('lists rows 4+ days old by the snapshot clock with no card, ignoring seed/null clocks', () => {
  const got = findUncardedDigestRows(snapshot, [], NOW);
  assert.deepEqual(got.map((r) => r.title), ['BSC Daily: Test UGC Features', 'BSC Daily: Check Performance Budget']);
  assert.equal(got[0].days, 5);
});

test('a family-collapsed card title, a "Fix: " card, or a covers-digest-row line counts as a card', () => {
  const open = [
    { title: 'BSC Daily: Test UGC Features' },
    { title: 'Fix: BSC Daily: Check Performance Budget' },
  ];
  assert.deepEqual(findUncardedDigestRows(snapshot, open, NOW), []);
  const covers = [{ title: 'Main is red', description: 'covers-digest-row: Test UGC Features\ncovers-digest-row: Check Performance Budget' }];
  assert.deepEqual(findUncardedDigestRows(snapshot, covers, NOW), []);
});

test('result row: warn with the list, pass when carded, pass without a snapshot, warn unmeasurable when Linear fails', async () => {
  const warn = await uncardedDigestRowsResult({ snapshot, listOpenIssues: async () => [], nowMs: NOW });
  assert.equal(warn.status, 'warn');
  assert.match(warn.message, /Test UGC Features \(5d\)/);
  const pass = await uncardedDigestRowsResult({ snapshot, listOpenIssues: async () => [{ title: 'BSC Daily: Test UGC Features' }, { title: 'BSC Daily: Check Performance Budget' }], nowMs: NOW });
  assert.equal(pass.status, 'pass');
  assert.equal((await uncardedDigestRowsResult({ snapshot: null, listOpenIssues: async () => [] })).status, 'pass');
  const down = await uncardedDigestRowsResult({ snapshot, listOpenIssues: async () => { throw new Error('down'); }, nowMs: NOW });
  assert.match(down.message, /^Unmeasurable/);
});
