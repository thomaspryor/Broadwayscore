import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPublicHistory } from '../../src/lib/data-cast';
import type { CastHistoryEntry } from '../../src/lib/data-types';

const RADCLIFFE: CastHistoryEntry = {
  name: 'Daniel Radcliffe',
  role: 'Narrator/Protagonist',
  since: '2026-02-21',
  until: '2026-05-24',
};

const HARGITAY: CastHistoryEntry = {
  name: 'Mariska Hargitay',
  role: 'Narrator/Protagonist',
  since: '2026-05-26',
  until: '2026-07-05',
};

const FLAGGED: CastHistoryEntry = {
  name: 'Unverified Actor',
  role: 'Ensemble',
  since: '2026-01-01',
  until: '2026-02-01',
  note: '[AUTO-FLAGGED] needs verification',
};

test('filterPublicHistory drops [AUTO-FLAGGED] entries', () => {
  const out = filterPublicHistory([RADCLIFFE, FLAGGED, HARGITAY]);
  assert.equal(out.length, 2);
  assert.ok(!out.some(e => e.name === 'Unverified Actor'));
});

test('filterPublicHistory sorts most-recent-stint-first (by until, falling back to since)', () => {
  const out = filterPublicHistory([RADCLIFFE, HARGITAY]);
  assert.deepEqual(out.map(e => e.name), ['Mariska Hargitay', 'Daniel Radcliffe']);
});

test('filterPublicHistory falls back to since when until is missing', () => {
  const openEnded: CastHistoryEntry = { name: 'Open Ended', role: 'Swing', since: '2026-08-01' };
  const out = filterPublicHistory([RADCLIFFE, openEnded]);
  // 2026-08-01 (since fallback) sorts after 2026-05-24 (until) — open-ended entry first.
  assert.deepEqual(out.map(e => e.name), ['Open Ended', 'Daniel Radcliffe']);
});

test('filterPublicHistory returns empty array for empty input', () => {
  assert.deepEqual(filterPublicHistory([]), []);
});
