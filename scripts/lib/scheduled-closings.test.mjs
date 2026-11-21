import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { countScheduledClosingsSince } = require('./scheduled-closings.js');

const now = new Date('2026-11-02T12:54:00Z');
const baseline = { openShowIds: ['a', 'b', 'c', 'd', 'e'] };

test('counts only baseline-open shows now closed on or before their closingDate', () => {
  const shows = [
    { id: 'a', status: 'closed', closingDate: '2026-11-01' }, // scheduled closing: counted
    { id: 'b', status: 'closed', closingDate: '2026-11-02' }, // today: counted
    { id: 'c', status: 'closed', closingDate: '2026-11-05' }, // closed early, not on schedule
    { id: 'd', status: 'open', closingDate: '2026-11-01' },   // still open
    { id: 'z', status: 'closed', closingDate: '2026-11-01' }, // was not open at baseline
    { id: 'e', status: 'closed' },                            // no date
  ];
  assert.equal(countScheduledClosingsSince(shows, baseline, now), 2);
});

test('a show missing from shows.json is never excused', () => {
  assert.equal(countScheduledClosingsSince([], baseline, now), 0);
});

test('legacy baseline without openShowIds excuses nothing', () => {
  const shows = [{ id: 'a', status: 'closed', closingDate: '2026-11-01' }];
  assert.equal(countScheduledClosingsSince(shows, { openShows: 50 }, now), 0);
  assert.equal(countScheduledClosingsSince(shows, null, now), 0);
  assert.equal(countScheduledClosingsSince(null, baseline, now), 0);
});
