import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectNearOpeningShows, decideOpeningRefresh } = require('./ibdb-opening-refresh.js');

const NOW = Date.parse('2026-11-16T12:00:00Z');
// The BRO-8188 record as it stood: IBDB-sourced 11-18, press night moved to 11-23.
const wonderfulLife = {
  id: 'its-a-wonderful-life-a-live-radio-play-2026', status: 'previews', category: 'broadway',
  previewsStartDate: '2026-11-04', openingDate: '2026-11-18', openingDateSource: 'ibdb',
};

test('BRO-8188: a moved IBDB opening replaces the stored IBDB date', () => {
  const d = decideOpeningRefresh(wonderfulLife, '2026-11-23', NOW);
  assert.equal(d.refresh, true, d.reason);
});

test('still refreshes a few days after the stale date passed (show auto-flipped to open)', () => {
  const d = decideOpeningRefresh({ ...wonderfulLife, status: 'open' }, '2026-11-23', Date.parse('2026-11-21T12:00:00Z'));
  assert.equal(d.refresh, true, d.reason);
});

test('no change when IBDB agrees', () => {
  assert.equal(decideOpeningRefresh(wonderfulLife, '2026-11-18', NOW).refresh, false);
});

test('never overrides a human correction or a stronger source', () => {
  assert.equal(decideOpeningRefresh({ ...wonderfulLife, humanCorrectedOpeningDate: '2026-11-18' }, '2026-11-23', NOW).refresh, false);
  for (const src of ['review-derived-press-night', 'playbill', 'playbill-manual', 'human-correction']) {
    assert.equal(decideOpeningRefresh({ ...wonderfulLife, openingDateSource: src }, '2026-11-23', NOW).refresh, false, src);
  }
});

test('weak sources from the shared rule (isUnconfirmedDateSource) are refreshable', () => {
  for (const src of ['previews-fallback', 'first-performance-no-press-night-found', 'todaytix']) {
    assert.equal(decideOpeningRefresh({ ...wonderfulLife, openingDateSource: src }, '2026-11-23', NOW).refresh, true, src);
  }
});

test('a missing source counts as refreshable (legacy rows)', () => {
  const { openingDateSource, ...legacy } = wonderfulLife;
  assert.equal(decideOpeningRefresh(legacy, '2026-11-23', NOW).refresh, true);
});

test('refuses a jump to another production, a date before previews, and old history', () => {
  assert.equal(decideOpeningRefresh(wonderfulLife, '2028-11-23', NOW).refresh, false);
  assert.equal(decideOpeningRefresh(wonderfulLife, '2026-11-01', NOW).refresh, false);
  assert.equal(decideOpeningRefresh(wonderfulLife, '2026-11-23', Date.parse('2027-01-20T12:00:00Z')).refresh, false);
});

test('ship-check: only near press night, and at most 60 days from the stored date', () => {
  const farFuture = { ...wonderfulLife, status: 'upcoming', previewsStartDate: '2027-03-01', openingDate: '2027-04-01' };
  assert.equal(decideOpeningRefresh(farFuture, '2027-04-10', NOW).refresh, false);
  assert.equal(decideOpeningRefresh(wonderfulLife, '2027-01-18', NOW).refresh, false); // 61 days
  assert.equal(decideOpeningRefresh(wonderfulLife, '2027-01-16', NOW).refresh, true);  // 59 days
});

test('near-opening selection: Broadway shows with a press night from 14 days ago to 45 days ahead', () => {
  const shows = [
    wonderfulLife,
    { id: 'far-future', status: 'upcoming', openingDate: '2027-04-01' },
    { id: 'long-open', status: 'open', openingDate: '2025-04-01' },
    { id: 'closed', status: 'closed', openingDate: '2026-11-10' },
    { id: 'we', status: 'previews', category: 'west-end', openingDate: '2026-11-20' },
    { id: 'previews-only', status: 'previews', openingDate: null, previewsStartDate: '2026-11-25' },
    { id: 'just-past', status: 'open', openingDate: '2026-11-05' },
  ];
  assert.deepEqual(selectNearOpeningShows(shows, NOW).map((s) => s.id), ['its-a-wonderful-life-a-live-radio-play-2026', 'previews-only', 'just-past']);
});
