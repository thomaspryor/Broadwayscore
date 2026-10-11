import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { decideBatchMode } = createRequire(import.meta.url)('./scoring-batch-mode.js');

const now = new Date('2026-10-11T12:00:00Z');
const shows = [
  { id: 'new-show-2026', openingDate: '2026-10-10' },
  { id: 'old-show-2025', openingDate: '2025-04-01' },
  { id: 'next-week-2026', openingDate: '2026-10-18' },
];
const d = (o) => decideBatchMode({ shows, now, ...o }).mode;

test('opening-window show dispatch stays sync', () => {
  assert.equal(d({ eventName: 'workflow_dispatch', showId: 'new-show-2026' }), 'sync');
  assert.equal(d({ eventName: 'workflow_dispatch', showId: 'old-show-2025, new-show-2026' }), 'sync');
});
test('backlog and rescore dispatches batch', () => {
  assert.equal(d({ eventName: 'workflow_dispatch', showId: '' }), 'batch');
  assert.equal(d({ eventName: 'workflow_dispatch', showId: 'old-show-2025' }), 'batch');
  assert.equal(d({ eventName: 'workflow_dispatch', showId: 'next-week-2026' }), 'batch');
});
test('schedule batches, even for a window show', () => {
  assert.equal(d({ eventName: 'schedule', showId: 'new-show-2026' }), 'batch');
});
test('kill switch and dry run force sync', () => {
  assert.equal(d({ eventName: 'schedule', disableBatch: true }), 'sync');
  assert.equal(d({ eventName: 'workflow_dispatch', dryRun: true }), 'sync');
});
test('unknown show data falls back to batch', () => {
  assert.equal(decideBatchMode({ eventName: 'workflow_dispatch', showId: 'x', shows: null, now }).mode, 'batch');
});
